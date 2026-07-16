import { spawn, type ChildProcess } from 'node:child_process';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { createLineDecoder } from '@specbridge/extension-sdk';
import { ExtensionError } from './errors.js';
import { EXTENSION_LIMITS } from './limits.js';
import { checkPackageRelativePath } from './paths.js';

/**
 * The extension process host.
 *
 * Executable extensions always run out of process: SpecBridge spawns
 * `node <entrypoint>` with an argv array (never a shell string), the
 * installed extension directory as working directory, and a sanitized
 * environment containing only a safe base set plus explicitly granted
 * variable names. stdout is treated as protocol-only and stderr as bounded
 * log text. Child-process hosting is a safety and audit boundary, not an OS
 * sandbox — an enabled extension still runs as local code with the user's
 * operating-system permissions.
 */
const BASE_ENVIRONMENT_ALLOWLIST = [
  'PATH',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'TZ',
] as const;

export interface ExtensionProcessOptions {
  readonly installedDir: string;
  /** Package-relative entrypoint, already validated by the manifest. */
  readonly entrypoint: string;
  /** Explicitly granted environment variable names. */
  readonly grantedEnvironmentVariables: readonly string[];
  /** Source environment (defaults to process.env). */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
}

export interface ExtensionProcessExit {
  readonly code: number | undefined;
  readonly signal: string | undefined;
}

export interface ExtensionProcessHandle {
  /** Write one already-serialized protocol line to the child's stdin. */
  readonly send: (line: string) => void;
  readonly onLine: (listener: (line: string) => void) => void;
  /** Fired once when stdout violates the protocol framing or size bounds. */
  readonly onProtocolCorruption: (listener: (detail: string) => void) => void;
  readonly onExit: (listener: (exit: ExtensionProcessExit) => void) => void;
  /** Bounded stderr text captured so far (secrets redacted by the caller). */
  readonly stderrText: () => string;
  readonly stdoutBytes: () => number;
  /** Graceful SIGTERM, then SIGKILL after the force-kill grace period. */
  readonly terminate: () => void;
  readonly killed: () => boolean;
  readonly exited: Promise<ExtensionProcessExit>;
}

/** Resolve and validate the entrypoint file without following symlinks. */
export function resolveEntrypoint(installedDir: string, entrypoint: string): string {
  const problem = checkPackageRelativePath(entrypoint);
  if (problem !== undefined) {
    throw new ExtensionError('SBE012', `entrypoint "${entrypoint}": ${problem}.`, 'Fix the extension manifest.');
  }
  const resolved = path.join(installedDir, ...entrypoint.split('/'));
  const relative = path.relative(installedDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ExtensionError(
      'SBE012',
      `entrypoint "${entrypoint}" escapes the installed extension directory.`,
      'Fix the extension manifest.',
    );
  }
  // Refuse symlinks anywhere on the entrypoint path below the install dir.
  let current = installedDir;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) {
      throw new ExtensionError(
        'SBE012',
        `entrypoint "${entrypoint}" does not exist in the installed extension.`,
        'Reinstall the extension.',
      );
    }
    if (stat.isSymbolicLink()) {
      throw new ExtensionError(
        'SBE011',
        `entrypoint path component "${segment}" is a symbolic link.`,
        'Reinstall the extension from a trusted source.',
      );
    }
  }
  const finalStat = lstatSync(resolved, { throwIfNoEntry: false });
  if (finalStat === undefined || !finalStat.isFile()) {
    throw new ExtensionError(
      'SBE012',
      `entrypoint "${entrypoint}" is not a regular file.`,
      'Reinstall the extension.',
    );
  }
  return resolved;
}

export function buildSanitizedEnvironment(
  granted: readonly string[],
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of BASE_ENVIRONMENT_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  for (const name of granted) {
    const value = source[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

export function spawnExtensionProcess(options: ExtensionProcessOptions): ExtensionProcessHandle {
  const entrypointPath = resolveEntrypoint(options.installedDir, options.entrypoint);
  const environment = buildSanitizedEnvironment(
    options.grantedEnvironmentVariables,
    options.environment ?? process.env,
  );
  const maxStdoutBytes = options.maxStdoutBytes ?? EXTENSION_LIMITS.maxProcessStdoutBytes;
  const maxStderrBytes = options.maxStderrBytes ?? EXTENSION_LIMITS.maxProcessStderrBytes;

  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [entrypointPath], {
      cwd: options.installedDir,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
  } catch (cause) {
    throw new ExtensionError(
      'SBE026',
      `failed to start the extension process: ${cause instanceof Error ? cause.message : String(cause)}.`,
      'Check that Node.js can execute the installed entrypoint.',
    );
  }

  const lineListeners: Array<(line: string) => void> = [];
  const corruptionListeners: Array<(detail: string) => void> = [];
  const exitListeners: Array<(exit: ExtensionProcessExit) => void> = [];
  let stderrBuffer = '';
  let stderrBytes = 0;
  let stdoutByteCount = 0;
  let killedFlag = false;
  let forceKillTimer: NodeJS.Timeout | undefined;

  const decoder = createLineDecoder({
    onLine: (line) => {
      for (const listener of lineListeners) {
        listener(line);
      }
    },
    onOverflow: (bytes) => {
      for (const listener of corruptionListeners) {
        listener(`stdout line of ${bytes} bytes exceeds the protocol message limit`);
      }
    },
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutByteCount += chunk.length;
    if (stdoutByteCount > maxStdoutBytes) {
      for (const listener of corruptionListeners) {
        listener(`stdout exceeded the ${maxStdoutBytes} byte limit`);
      }
      return;
    }
    decoder.push(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderrBytes >= maxStderrBytes) {
      return;
    }
    stderrBytes += chunk.length;
    stderrBuffer += chunk.toString('utf8');
    if (stderrBuffer.length > maxStderrBytes) {
      stderrBuffer = stderrBuffer.slice(0, maxStderrBytes);
    }
  });

  const exited = new Promise<ExtensionProcessExit>((resolve) => {
    let settled = false;
    const settle = (exit: ExtensionProcessExit): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
        forceKillTimer = undefined;
      }
      for (const listener of exitListeners) {
        listener(exit);
      }
      resolve(exit);
    };
    child.once('exit', (code, signal) => {
      settle({ code: code ?? undefined, signal: signal ?? undefined });
    });
    child.once('error', () => {
      settle({ code: undefined, signal: undefined });
    });
  });

  const terminate = (): void => {
    if (killedFlag) {
      return;
    }
    killedFlag = true;
    try {
      child.stdin?.end();
    } catch {
      // Already closed.
    }
    try {
      child.kill('SIGTERM');
    } catch {
      // Already exited.
    }
    forceKillTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already exited.
      }
    }, EXTENSION_LIMITS.forceKillAfterMs);
    forceKillTimer.unref?.();
  };

  return {
    send: (line: string) => {
      try {
        child.stdin?.write(line);
      } catch {
        // The exit handler reports the failure.
      }
    },
    onLine: (listener) => {
      lineListeners.push(listener);
    },
    onProtocolCorruption: (listener) => {
      corruptionListeners.push(listener);
    },
    onExit: (listener) => {
      exitListeners.push(listener);
    },
    stderrText: () => stderrBuffer,
    stdoutBytes: () => stdoutByteCount,
    terminate,
    killed: () => killedFlag,
    exited,
  };
}
