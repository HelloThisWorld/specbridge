import { Socket } from 'node:net';
import { runSafeProcess } from '@specbridge/runners';
import type { ReadinessProbe } from './state.js';

/**
 * Executing one readiness probe.
 *
 * Each probe answers one question and answers it about the SERVICE, not
 * about the container that happens to hold it. That distinction is the whole
 * reason this file exists: `docker ps` says a Postgres container is running
 * several seconds before Postgres will accept a connection, and a test suite
 * started in that window fails in a way that looks like a product bug.
 *
 * Every probe is bounded, cancellable, and reports what it OBSERVED rather
 * than throwing. A probe that could throw would make the readiness loop
 * responsible for exception handling on every iteration, and the loop's job
 * is to be patient, not defensive.
 */

export interface ProbeOutcome {
  ready: boolean;
  /** One line describing what was observed. Never a response body dump. */
  detail: string;
}

export type ProbeExecutor = (probe: ReadinessProbe, signal?: AbortSignal) => Promise<ProbeOutcome>;

/** The production probe executor. */
export function createReadinessProbeExecutor(options: { cwd: string }): ProbeExecutor {
  return async (probe, signal) => {
    switch (probe.kind) {
      case 'TCP_CONNECT':
        return probeTcp(probe.host, probe.port ?? 0, probe.timeoutMs, signal);
      case 'HTTP_STATUS':
      case 'HTTP_BODY':
        return probeHttp(probe, signal);
      case 'COMMAND_EXIT':
        return probeCommand(probe, options.cwd, signal);
      case 'CONTAINER_HEALTHCHECK':
        return probeContainerHealth(probe, options.cwd, signal);
      case 'PROTOCOL_HANDSHAKE':
        // A protocol handshake is expressed as the protocol client's own
        // command (psql, kafka-topics, redis-cli). Modelling it as a distinct
        // probe kind keeps the EVIDENCE honest about what was proven, while
        // the execution reuses the bounded command path rather than growing a
        // protocol client per broker.
        return probeCommand(probe, options.cwd, signal);
      case 'PROCESS_ALIVE':
        return { ready: true, detail: 'liveness only: nothing about the service protocol was verified' };
      default:
        return { ready: false, detail: `unsupported probe kind ${String(probe.kind)}` };
    }
  };
}

function probeTcp(
  host: string,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(outcome);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ready: true, detail: `tcp ${host}:${port} accepted` }));
    socket.once('timeout', () => finish({ ready: false, detail: `tcp ${host}:${port} timed out` }));
    socket.once('error', (error) =>
      finish({ ready: false, detail: `tcp ${host}:${port}: ${error.message}`.slice(0, 200) }),
    );
    signal?.addEventListener('abort', () => finish({ ready: false, detail: 'cancelled' }), {
      once: true,
    });
    socket.connect(port, host);
  });
}

async function probeHttp(probe: ReadinessProbe, signal?: AbortSignal): Promise<ProbeOutcome> {
  const url = `http://${probe.host}:${probe.port ?? 80}${probe.urlPath ?? '/'}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), probe.timeoutMs);
  timer.unref?.();
  signal?.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    if (!probe.expectStatus.includes(response.status)) {
      return {
        ready: false,
        detail: `http ${url} returned ${response.status} (expected ${probe.expectStatus.join('/')})`,
      };
    }
    if (probe.kind === 'HTTP_BODY' && probe.expectBody !== undefined) {
      // Bounded read: a readiness probe must never pull a large response into
      // memory, and the first 64 KiB is more than enough to find a marker.
      const body = (await response.text()).slice(0, 64 * 1024);
      if (!body.includes(probe.expectBody)) {
        return { ready: false, detail: `http ${url} body did not contain the expected marker` };
      }
      return { ready: true, detail: `http ${url} returned ${response.status} with the expected marker` };
    }
    return { ready: true, detail: `http ${url} returned ${response.status}` };
  } catch (cause) {
    return {
      ready: false,
      detail: `http ${url}: ${(cause instanceof Error ? cause.message : String(cause)).slice(0, 160)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeCommand(
  probe: ReadinessProbe,
  cwd: string,
  signal?: AbortSignal,
): Promise<ProbeOutcome> {
  const [executable, ...argv] = probe.argv;
  if (executable === undefined) return { ready: false, detail: 'probe has no command' };
  const result = await runSafeProcess({
    executable,
    argv,
    cwd,
    timeoutMs: probe.timeoutMs,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024,
    ...(signal !== undefined ? { signal } : {}),
  });
  const label = probe.protocol !== undefined ? `${probe.protocol} handshake` : executable;
  return result.status === 'ok'
    ? { ready: true, detail: `${label} succeeded` }
    : { ready: false, detail: `${label} ${result.status}` };
}

async function probeContainerHealth(
  probe: ReadinessProbe,
  cwd: string,
  signal?: AbortSignal,
): Promise<ProbeOutcome> {
  const container = probe.argv[0];
  if (container === undefined) {
    return { ready: false, detail: 'container healthcheck probe names no container' };
  }
  const result = await runSafeProcess({
    executable: 'docker',
    argv: ['inspect', '--format', '{{.State.Health.Status}}', container],
    cwd,
    timeoutMs: probe.timeoutMs,
    maxStdoutBytes: 4 * 1024,
    maxStderrBytes: 16 * 1024,
    ...(signal !== undefined ? { signal } : {}),
  });
  const status = result.stdout.trim();
  if (result.status !== 'ok') {
    return { ready: false, detail: `docker inspect ${container} ${result.status}` };
  }
  // A container with no healthcheck reports an empty status. That is NOT
  // healthy: it means nobody defined what healthy would look like, and
  // treating the absence of a check as a passing check is the exact
  // shortcut this whole module exists to avoid.
  if (status.length === 0 || status === '<no value>') {
    return {
      ready: false,
      detail: `container ${container} declares no healthcheck; readiness cannot be established from it`,
    };
  }
  return status === 'healthy'
    ? { ready: true, detail: `container ${container} is healthy` }
    : { ready: false, detail: `container ${container} is ${status}` };
}
