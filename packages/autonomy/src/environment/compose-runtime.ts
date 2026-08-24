import path from 'node:path';
import { runSafeProcess } from '@specbridge/runners';
import type { EnvironmentRuntime } from './service.js';
import type { EnvironmentPlan, ServicePlan } from './state.js';

/**
 * The Docker Compose environment runtime.
 *
 * Small on purpose. Everything interesting — readiness ordering, timeouts,
 * restart budgets, evidence honesty — lives in the service; this file knows
 * how to say "up", "restart", "logs", and "down" to one specific tool. That
 * boundary is why a second runtime (podman, a plain process supervisor, a
 * remote environment) is a new file rather than a refactor.
 *
 * Two decisions worth naming:
 *
 * `--project-name` is always passed. Without it, compose derives a project
 * name from the directory, and two SpecBridge instances working in sibling
 * worktrees would silently share containers — a failure that presents as
 * inexplicable cross-talk between unrelated runs.
 *
 * `down` never passes `--volumes` unless teardown was asked to discard
 * everything. An overnight run that fails at 04:00 and helpfully deletes the
 * database it failed against has destroyed the only evidence of what went
 * wrong.
 */

export interface ComposeRuntimeOptions {
  /** Working directory for compose invocations. */
  cwd: string;
  /** Executable name; `docker` unless an operator uses a wrapper. */
  executable?: string | undefined;
}

export function createComposeRuntime(options: ComposeRuntimeOptions): EnvironmentRuntime {
  const executable = options.executable ?? 'docker';

  const composeArgs = (plan: EnvironmentPlan, rest: readonly string[]): string[] => {
    const args = ['compose'];
    if (plan.composeFile !== undefined) {
      args.push('-f', path.resolve(options.cwd, plan.composeFile));
    }
    args.push('--project-name', plan.projectName ?? plan.planId);
    args.push(...rest);
    return args;
  };

  const run = async (
    argv: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
    maxStdoutBytes = 256 * 1024,
  ): Promise<{ ok: boolean; stdout: string; stderr: string; status: string }> => {
    const result = await runSafeProcess({
      executable,
      argv: [...argv],
      cwd: options.cwd,
      timeoutMs,
      maxStdoutBytes,
      maxStderrBytes: 256 * 1024,
      ...(signal !== undefined ? { signal } : {}),
    });
    return {
      ok: result.status === 'ok',
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
    };
  };

  return {
    label: 'docker-compose',

    async provision(input) {
      const result = await run(
        composeArgs(input.plan, ['up', '--detach', '--wait=false']),
        input.timeoutMs,
        input.signal,
      );
      if (result.ok) return { ok: true, detail: 'compose up --detach succeeded' };
      const combined = `${result.stderr}\n${result.stdout}`.toLowerCase();
      return {
        ok: false,
        detail: firstLine(result.stderr || result.stdout) || `compose up ${result.status}`,
        failureKind: classifyComposeFailure(combined, result.status),
      };
    },

    async restart(input) {
      const result = await run(
        composeArgs(input.plan, ['restart', input.service.name]),
        input.timeoutMs,
        input.signal,
      );
      return {
        ok: result.ok,
        detail: result.ok
          ? `restarted ${input.service.name}`
          : firstLine(result.stderr) || `restart ${result.status}`,
      };
    },

    async logs(input) {
      const result = await run(
        composeArgs(input.plan, ['logs', '--no-color', '--tail', '400', input.service.name]),
        60_000,
        undefined,
        input.maxBytes,
      );
      return result.stdout.slice(0, input.maxBytes);
    },

    async teardown(input) {
      // `--remove-orphans` cleans up services a previous plan revision
      // started under the same project name; without it a renamed service
      // leaks a container that outlives every run that could stop it.
      const argv = input.retain
        ? composeArgs(input.plan, ['stop'])
        : composeArgs(input.plan, ['down', '--remove-orphans', '--volumes']);
      const result = await run(argv, input.timeoutMs);
      return {
        ok: result.ok,
        detail: result.ok
          ? input.retain
            ? 'containers stopped and retained for diagnosis'
            : 'compose down removed containers and volumes'
          : firstLine(result.stderr) || `teardown ${result.status}`,
      };
    },
  };
}

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim().length > 0) ?? '').trim().slice(0, 400);
}

/**
 * Classify a compose failure into something a repair can act on.
 *
 * Deliberately conservative: anything unrecognised is UNKNOWN rather than
 * guessed, because a wrong classification sends the runtime down a repair
 * path that cannot work and burns the restart budget getting there.
 */
function classifyComposeFailure(
  combined: string,
  status: string,
): 'RUNTIME_UNAVAILABLE' | 'IMAGE_PULL_FAILED' | 'PORT_CONFLICT' | 'CONFIGURATION_INVALID' | 'RESOURCE_EXHAUSTED' | 'UNKNOWN' {
  if (status === 'spawn-failed' || combined.includes('cannot connect to the docker daemon')) {
    return 'RUNTIME_UNAVAILABLE';
  }
  if (combined.includes('pull access denied') || combined.includes('manifest unknown') || combined.includes('error pulling image')) {
    return 'IMAGE_PULL_FAILED';
  }
  if (combined.includes('address already in use') || combined.includes('port is already allocated')) {
    return 'PORT_CONFLICT';
  }
  if (combined.includes('no space left on device') || combined.includes('cannot allocate memory')) {
    return 'RESOURCE_EXHAUSTED';
  }
  if (combined.includes('yaml') || combined.includes('services must be a mapping') || combined.includes('unsupported config option')) {
    return 'CONFIGURATION_INVALID';
  }
  return 'UNKNOWN';
}

/**
 * Build a plan for a compose file whose services are named.
 *
 * A convenience for the common case, and a place to put the one rule that
 * matters: a service with no declared probe gets `CONTAINER_HEALTHCHECK`,
 * which FAILS when the container declares no healthcheck. The alternative —
 * defaulting to PROCESS_ALIVE — would silently produce shallow evidence for
 * every service nobody thought about, which is exactly the readiness lie
 * this module exists to prevent.
 */
export function composePlanFromServices(input: {
  name: string;
  composeFile: string;
  projectName?: string | undefined;
  services: { serviceId: string; name?: string | undefined; kind: ServicePlan['kind']; dependsOn?: string[]; probes?: ServicePlan['probes'] }[];
}): Omit<EnvironmentPlan, 'schemaVersion' | 'createdAt' | 'planId'> {
  return {
    name: input.name,
    composeFile: input.composeFile,
    ...(input.projectName !== undefined ? { projectName: input.projectName } : {}),
    services: input.services.map((service) => ({
      serviceId: service.serviceId,
      kind: service.kind,
      name: service.name ?? service.serviceId,
      dependsOn: service.dependsOn ?? [],
      probes:
        service.probes ??
        ([
          {
            kind: 'CONTAINER_HEALTHCHECK',
            host: '127.0.0.1',
            expectStatus: [200],
            argv: [service.name ?? service.serviceId],
            timeoutMs: 10_000,
          },
        ] as ServicePlan['probes']),
      maxRestarts: 3,
      readinessTimeoutMs: 120_000,
      ports: [],
    })),
  };
}
