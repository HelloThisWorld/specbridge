import { Buffer } from 'node:buffer';
import { statSync } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { SpecBridgeError } from '@specbridge/core';
import type { ProcessObservation } from './contract.js';

/**
 * Safe child-process invocation shared by all runner implementations and by
 * trusted verification commands.
 *
 *   - argv arrays only; no shell is ever involved
 *   - null bytes and empty strings are rejected before spawn
 *   - configurable timeout with graceful-then-forced termination
 *   - AbortSignal cancellation (no orphaned children)
 *   - stdout/stderr size limits: the process is stopped, the truncated
 *     output is retained, and the result is marked — never parsed as valid
 *   - environment is inherited from the parent and NEVER logged
 */

export interface SafeProcessRequest {
  executable: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Content piped to stdin (used for large prompts). */
  stdin?: string;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  /** Exact argv values to replace with `<redacted>` in the audit record. */
  redactValues?: string[];
  /** Grace period between SIGTERM and SIGKILL. */
  forceKillAfterMs?: number;
}

export type SafeProcessStatus =
  | 'ok'
  | 'nonzero-exit'
  | 'timeout'
  | 'cancelled'
  | 'output-limit'
  | 'spawn-failed';

export interface SafeProcessResult {
  status: SafeProcessStatus;
  stdout: string;
  stderr: string;
  observation: ProcessObservation;
  /** Human-readable failure explanation (never includes environment values). */
  failureReason?: string;
}

export const DEFAULT_MAX_STDOUT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_STDERR_BYTES = 1024 * 1024;

function assertSafeToken(value: string, what: string): void {
  if (value.length === 0) {
    throw new SpecBridgeError('INVALID_ARGUMENT', `${what} must not be empty.`);
  }
  if (value.includes('\0')) {
    throw new SpecBridgeError('INVALID_ARGUMENT', `${what} must not contain null bytes.`);
  }
}

/** Redact configured values; safe for storage in run records. */
export function redactArgv(argv: string[], redactValues: string[] = []): string[] {
  if (redactValues.length === 0) return [...argv];
  return argv.map((argument) => (redactValues.includes(argument) ? '<redacted>' : argument));
}

function isExecutableFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve an executable the way the OS would (PATH + PATHEXT on Windows),
 * without ever invoking a shell. Returns undefined when nothing matches —
 * a deterministic, locale-independent "executable not found" signal.
 */
export function resolveExecutable(command: string, cwd: string): string | undefined {
  if (command.includes('/') || command.includes('\\')) {
    const resolved = path.resolve(cwd, command);
    return isExecutableFile(resolved) ? resolved : undefined;
  }
  const pathValue = process.env['PATH'] ?? process.env['Path'] ?? '';
  const extensions =
    process.platform === 'win32'
      ? ['', ...(process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';')]
      : [''];
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir.length === 0) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, command + extension);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Run one process. Never throws for process-level failures (nonzero exit,
 * timeout, missing executable) — those come back as a structured result.
 * Throws only for caller bugs (malformed argv).
 */
export async function runSafeProcess(request: SafeProcessRequest): Promise<SafeProcessResult> {
  assertSafeToken(request.executable, 'executable');
  for (const argument of request.argv) {
    if (argument.includes('\0')) {
      throw new SpecBridgeError('INVALID_ARGUMENT', 'argv must not contain null bytes.');
    }
  }

  const maxStdout = request.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const maxStderr = request.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  const startedAt = new Date();

  // Deterministic, locale-independent missing-executable detection (Windows
  // otherwise reports a localized cmd error with exit code 1).
  if (resolveExecutable(request.executable, request.cwd) === undefined) {
    const endedAt = new Date();
    return {
      status: 'spawn-failed',
      stdout: '',
      stderr: '',
      failureReason: `could not start "${request.executable}": executable not found on PATH`,
      observation: {
        executable: request.executable,
        redactedArgv: redactArgv(request.argv, request.redactValues),
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: 0,
        exitCode: undefined,
        signal: undefined,
        timedOut: false,
        cancelled: false,
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    };
  }

  const result = await execa(request.executable, request.argv, {
    cwd: request.cwd,
    timeout: request.timeoutMs,
    ...(request.signal !== undefined ? { cancelSignal: request.signal } : {}),
    forceKillAfterDelay: request.forceKillAfterMs ?? 2000,
    maxBuffer: { stdout: maxStdout, stderr: maxStderr },
    reject: false,
    stripFinalNewline: false,
    ...(request.stdin !== undefined ? { input: request.stdin } : { stdin: 'ignore' }),
    // Environment: inherited from the parent process on purpose (the local
    // agent CLI needs its own auth environment). It is never logged.
    windowsHide: true,
  });

  const endedAt = new Date();
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';

  const spawnFailed = result.exitCode === undefined && !result.timedOut && !result.isCanceled;
  // Output-limit detection must not depend on execa's isMaxBuffer flag
  // alone: on macOS a fast-exiting child can finish before the overflow is
  // flagged, leaving truncated output on a "successful" result. Output at
  // or beyond the configured limit is indistinguishable from an overflow
  // (execa truncates TO the limit), so treat it as one — never parse it.
  const stdoutTruncated = Buffer.byteLength(stdout, 'utf8') >= maxStdout;
  const stderrTruncated = Buffer.byteLength(stderr, 'utf8') >= maxStderr;
  const isMaxBuffer =
    ('isMaxBuffer' in result && result.isMaxBuffer === true) || stdoutTruncated || stderrTruncated;

  let status: SafeProcessStatus;
  let failureReason: string | undefined;
  if (result.timedOut) {
    status = 'timeout';
    failureReason = `process exceeded the ${request.timeoutMs} ms timeout and was terminated`;
  } else if (result.isCanceled) {
    status = 'cancelled';
    failureReason = 'process was cancelled and terminated';
  } else if (isMaxBuffer) {
    status = 'output-limit';
    failureReason =
      `process output exceeded the configured limit ` +
      `(stdout ${maxStdout} bytes, stderr ${maxStderr} bytes) and was terminated; ` +
      'the truncated output was retained but will not be parsed';
  } else if (spawnFailed && result.isTerminated !== true) {
    status = 'spawn-failed';
    const original =
      'originalMessage' in result && typeof result.originalMessage === 'string'
        ? result.originalMessage
        : (result.shortMessage ?? 'unknown spawn failure');
    failureReason = `could not start "${request.executable}": ${original}`;
  } else if (result.exitCode === 0) {
    status = 'ok';
  } else {
    status = 'nonzero-exit';
    failureReason =
      result.exitCode !== undefined
        ? `process exited with code ${result.exitCode}`
        : `process was terminated by signal ${result.signal ?? 'unknown'}`;
  }

  return {
    status,
    stdout,
    stderr,
    ...(failureReason !== undefined ? { failureReason } : {}),
    observation: {
      executable: request.executable,
      redactedArgv: redactArgv(request.argv, request.redactValues),
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
      exitCode: result.exitCode,
      signal: typeof result.signal === 'string' ? result.signal : undefined,
      timedOut: result.timedOut === true,
      cancelled: result.isCanceled === true,
      stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
      stderrBytes: Buffer.byteLength(stderr, 'utf8'),
      stdoutTruncated,
      stderrTruncated,
    },
  };
}
