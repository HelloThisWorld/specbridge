import { accessSync, constants, existsSync, readFileSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { runSafeProcess } from '@specbridge/runners';

/**
 * Capability probes.
 *
 * Every probe here reports what it OBSERVED and refuses to infer anything
 * else. A probe that cannot decide returns `unknown` rather than guessing
 * either way, because a false READY costs an overnight window and a false
 * HUMAN_REQUIRED costs the operator's trust in the whole report.
 *
 * The `ProbeRunner` indirection exists so the certification and the unit
 * tests can drive the preflight without Docker, without a network, and
 * without the several seconds each real probe costs. Production wires it to
 * `runSafeProcess`, which is argv-only and shell-free like every other
 * process invocation in SpecBridge.
 */

export interface ProbeCommandResult {
  ok: boolean;
  /** First line of stdout, bounded. Never the environment. */
  output: string;
  /** Why it failed, when it failed. */
  detail?: string | undefined;
}

export type ProbeRunner = (
  executable: string,
  argv: readonly string[],
  timeoutMs: number,
) => Promise<ProbeCommandResult>;

/** The production probe runner: argv-only, bounded, no shell. */
export function createProcessProbeRunner(cwd: string): ProbeRunner {
  return async (executable, argv, timeoutMs) => {
    try {
      const result = await runSafeProcess({
        executable,
        argv: [...argv],
        cwd,
        timeoutMs,
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 64 * 1024,
      });
      const output = (result.stdout || result.stderr).split('\n')[0]?.trim() ?? '';
      if (result.status === 'ok') return { ok: true, output: output.slice(0, 200) };
      return {
        ok: false,
        output: output.slice(0, 200),
        detail: `${result.status}`,
      };
    } catch (cause) {
      return {
        ok: false,
        output: '',
        detail: (cause instanceof Error ? cause.message : String(cause)).slice(0, 200),
      };
    }
  };
}

/**
 * A probe runner that never spawns anything.
 *
 * Used by the offline certification profile. It reports every command as
 * unavailable, which is the honest answer for an environment that declined
 * to let anything run — and it makes the resulting report's
 * `SATISFIABLE_AUTONOMOUSLY` classifications the interesting thing under
 * test, rather than whatever happens to be installed on the CI runner.
 */
export function createNullProbeRunner(): ProbeRunner {
  return async () => ({ ok: false, output: '', detail: 'probes disabled' });
}

// ---------------------------------------------------------------------------
// Filesystem probes
// ---------------------------------------------------------------------------

export function isWritableDirectory(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Free bytes on the volume holding a path, or `null` when unknowable.
 *
 * `statfsSync` is Node 18.15+/20+; a platform or filesystem that refuses it
 * yields `null`, and the caller reports UNKNOWN rather than assuming there
 * is room. An overnight run that fills a disk at 04:00 is one of the few
 * failures no amount of runtime autonomy can recover from.
 */
export function freeDiskBytes(target: string): number | null {
  try {
    const stats = statfsSync(target);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

export function pathExists(target: string): boolean {
  try {
    return existsSync(target);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Toolchain probes
// ---------------------------------------------------------------------------

export interface ToolProbe {
  /** The tool this probe is about, e.g. `docker`. */
  tool: string;
  available: boolean;
  version: string | null;
  detail?: string | undefined;
}

export async function probeTool(
  run: ProbeRunner,
  tool: string,
  argv: readonly string[] = ['--version'],
  timeoutMs = 15_000,
): Promise<ToolProbe> {
  const result = await run(tool, argv, timeoutMs);
  if (result.ok) return { tool, available: true, version: result.output || null };
  return {
    tool,
    available: false,
    version: null,
    ...(result.detail !== undefined ? { detail: result.detail } : {}),
  };
}

/**
 * Whether a container runtime is not merely installed but ANSWERING.
 *
 * `docker --version` succeeds when the CLI exists and the daemon is dead,
 * which is exactly the state that ruins an unattended run four hours later.
 * `docker info` talks to the daemon, so it is the version of this question
 * worth asking.
 */
export async function probeContainerRuntime(run: ProbeRunner): Promise<ToolProbe> {
  const info = await run('docker', ['info', '--format', '{{.ServerVersion}}'], 20_000);
  if (info.ok) return { tool: 'docker', available: true, version: info.output || null };
  const cli = await probeTool(run, 'docker');
  return {
    tool: 'docker',
    available: false,
    version: cli.version,
    detail: cli.available
      ? 'the docker CLI is installed but the daemon did not answer'
      : (info.detail ?? 'docker is not available'),
  };
}

export async function probeCompose(run: ProbeRunner): Promise<ToolProbe> {
  const plugin = await run('docker', ['compose', 'version'], 20_000);
  if (plugin.ok) return { tool: 'docker compose', available: true, version: plugin.output || null };
  const standalone = await probeTool(run, 'docker-compose');
  return standalone.available
    ? { tool: 'docker-compose', available: true, version: standalone.version }
    : {
        tool: 'docker compose',
        available: false,
        version: null,
        detail: 'neither the compose plugin nor docker-compose answered',
      };
}

/**
 * The package manager a project declares, from its own manifest.
 *
 * Read from `packageManager` in package.json, then from lockfile presence.
 * Deliberately never a default: guessing `npm` for a pnpm workspace produces
 * an install that half-works, which is worse than reporting that nothing was
 * declared.
 */
export function detectPackageManager(projectDir: string): string | null {
  const manifest = path.join(projectDir, 'package.json');
  if (pathExists(manifest)) {
    try {
      const raw = JSON.parse(readFileSync(manifest, 'utf8')) as { packageManager?: unknown };
      if (typeof raw.packageManager === 'string' && raw.packageManager.length > 0) {
        return raw.packageManager.split('@')[0] ?? null;
      }
    } catch {
      // A malformed manifest is a project problem, not a probe failure.
    }
  }
  for (const [lockfile, manager] of [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
    ['bun.lockb', 'bun'],
  ] as const) {
    if (pathExists(path.join(projectDir, lockfile))) return manager;
  }
  return null;
}

/** Build tools a JVM or polyglot project may need, detected from its files. */
export function detectBuildTool(projectDir: string): string | null {
  for (const [marker, tool] of [
    ['gradlew', 'gradle-wrapper'],
    ['build.gradle', 'gradle'],
    ['build.gradle.kts', 'gradle'],
    ['mvnw', 'maven-wrapper'],
    ['pom.xml', 'maven'],
    ['Cargo.toml', 'cargo'],
    ['go.mod', 'go'],
  ] as const) {
    if (pathExists(path.join(projectDir, marker))) return tool;
  }
  return null;
}
