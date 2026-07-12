import type { VerificationCommand } from '@specbridge/core';
import type { SafeProcessStatus } from '@specbridge/runners';
import { runSafeProcess } from '@specbridge/runners';

/**
 * Trusted verification command execution.
 *
 * Commands come exclusively from `.specbridge/config.json` — never from spec
 * Markdown, never from model output (both are untrusted input by principle).
 * They run as argv arrays from the repository root with individual timeouts;
 * no shell is involved.
 */

export interface VerificationCommandResult {
  name: string;
  argv: string[];
  required: boolean;
  status: SafeProcessStatus;
  exitCode: number | undefined;
  durationMs: number;
  timedOut: boolean;
  /** Tail of the output, retained for reports (full output goes to run logs). */
  stdoutTail: string;
  stderrTail: string;
  passed: boolean;
}

export interface VerificationRunResult {
  /** False when verification was skipped (`--no-verify`). */
  ran: boolean;
  skipped: boolean;
  /** True when at least one command is configured. */
  configured: boolean;
  commands: VerificationCommandResult[];
  requiredFailed: string[];
  optionalFailed: string[];
  /** True only when verification ran and every required command passed. */
  passed: boolean;
}

const TAIL_BYTES = 8 * 1024;

function tail(text: string): string {
  return text.length > TAIL_BYTES ? text.slice(text.length - TAIL_BYTES) : text;
}

export function skippedVerification(commands: VerificationCommand[]): VerificationRunResult {
  return {
    ran: false,
    skipped: true,
    configured: commands.length > 0,
    commands: [],
    requiredFailed: [],
    optionalFailed: [],
    passed: false,
  };
}

export interface RunVerificationOptions {
  signal?: AbortSignal;
  /** Called before each command starts (progress reporting). */
  onCommandStart?: (command: VerificationCommand) => void;
  /** Full output sink per command (run-directory logs). */
  onCommandFinished?: (result: VerificationCommandResult, stdout: string, stderr: string) => void;
}

/** Run the configured commands sequentially from the repository root. */
export async function runVerificationCommands(
  workspaceRoot: string,
  commands: VerificationCommand[],
  options: RunVerificationOptions = {},
): Promise<VerificationRunResult> {
  const results: VerificationCommandResult[] = [];
  const requiredFailed: string[] = [];
  const optionalFailed: string[] = [];

  for (const command of commands) {
    options.onCommandStart?.(command);
    const executable = command.argv[0] as string;
    const rest = command.argv.slice(1);
    const processResult = await runSafeProcess({
      executable,
      argv: rest,
      cwd: workspaceRoot,
      timeoutMs: command.timeoutMs,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      maxStdoutBytes: 16 * 1024 * 1024,
      maxStderrBytes: 16 * 1024 * 1024,
    });
    const passed = processResult.status === 'ok';
    const result: VerificationCommandResult = {
      name: command.name,
      argv: [...command.argv],
      required: command.required,
      status: processResult.status,
      exitCode: processResult.observation.exitCode,
      durationMs: processResult.observation.durationMs,
      timedOut: processResult.observation.timedOut,
      stdoutTail: tail(processResult.stdout),
      stderrTail: tail(processResult.stderr),
      passed,
    };
    results.push(result);
    options.onCommandFinished?.(result, processResult.stdout, processResult.stderr);
    if (!passed) {
      if (command.required) requiredFailed.push(command.name);
      else optionalFailed.push(command.name);
    }
  }

  return {
    ran: true,
    skipped: false,
    configured: commands.length > 0,
    commands: results,
    requiredFailed,
    optionalFailed,
    passed: requiredFailed.length === 0,
  };
}
