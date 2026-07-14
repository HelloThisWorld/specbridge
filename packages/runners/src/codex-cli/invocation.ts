import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { CodexProfileConfig } from '@specbridge/core';
import { SpecBridgeError, writeFileAtomic } from '@specbridge/core';
import type { RunnerExecutionOptions, RunnerToolPolicy } from '../contract.js';
import type { SafeProcessResult } from '../safe-process.js';
import { runSafeProcess } from '../safe-process.js';
import type { CodexProbe } from './detection.js';
import { CODEX_FORBIDDEN_ARGUMENTS } from './detection.js';

/**
 * Codex CLI invocation: argument-vector construction, process execution,
 * and temp-file handling.
 *
 * Hard rules (tested):
 *   - the argument vector is an array; no shell string is ever built
 *   - no unrestricted sandbox mode can appear, whatever the configuration
 *     says (`danger-full-access`, bypass flags, and repo-check skips are
 *     rejected pre-spawn)
 *   - authoring ALWAYS uses `--sandbox read-only`; task execution uses
 *     `--sandbox workspace-write` — never anything broader
 *   - the prompt travels via stdin (`codex exec -`), never via a
 *     process-list-visible argument
 *   - only flags detected in help output are passed (graceful degradation)
 */

export interface CodexInvocationPlan {
  executable: string;
  argv: string[];
  /** Prompt content delivered via stdin. */
  stdin: string;
  /** Sandbox mode the plan uses (never an unrestricted mode). */
  sandbox: 'read-only' | 'workspace-write';
  /** File the CLI writes the final agent message to (when supported). */
  lastMessagePath?: string;
  /** Temp files under `<runDir>/tmp/` (schema, last-message target). */
  tempFiles: string[];
  /** Flags that were requested but skipped because the CLI lacks them. */
  skippedFlags: string[];
}

export interface BuildCodexInvocationInput {
  config: CodexProfileConfig;
  probe: CodexProbe;
  prompt: string;
  toolPolicy: RunnerToolPolicy;
  /** JSON Schema for the structured final output. */
  outputJsonSchema: Record<string, unknown>;
  /** Resume an existing provider session (explicit id only, never "last"). */
  resumeSessionId?: string;
  execution: RunnerExecutionOptions;
  /** False for dry-run previews: temp files are not written. */
  materializeTempFiles?: boolean;
}

/** Defense in depth: no code path may assemble an unrestricted invocation. */
export function assertNoForbiddenCodexArguments(argv: readonly string[]): void {
  for (const argument of argv) {
    for (const forbidden of CODEX_FORBIDDEN_ARGUMENTS) {
      if (argument.includes(forbidden)) {
        throw new SpecBridgeError(
          'INVALID_STATE',
          `Refusing to invoke the Codex CLI: the argument vector contains "${forbidden}". ` +
            'SpecBridge never disables sandboxing, approvals, or repository safety checks.',
        );
      }
    }
  }
  const sandboxIndex = argv.indexOf('--sandbox');
  if (sandboxIndex >= 0) {
    const mode = argv[sandboxIndex + 1];
    if (mode !== 'read-only' && mode !== 'workspace-write') {
      throw new SpecBridgeError(
        'INVALID_STATE',
        `Refusing to invoke the Codex CLI with sandbox mode "${mode ?? '(missing)'}". ` +
          'Only read-only and workspace-write are ever used.',
      );
    }
  }
}

/** Build the full argument vector. Pure aside from temp files; safe to preview. */
export function buildCodexInvocation(input: BuildCodexInvocationInput): CodexInvocationPlan {
  const { config, probe, execution } = input;
  const argv: string[] = [...config.command.args];
  const tempFiles: string[] = [];
  const skippedFlags: string[] = [];
  const supports = (token: string): boolean => probe.supportedTokens.has(token);

  argv.push('exec');
  if (input.resumeSessionId !== undefined) {
    // Explicit session identity only — the ambiguous "resume last" form is
    // never used (it could continue an unrelated conversation).
    argv.push('resume', input.resumeSessionId);
  }

  argv.push('--json');

  // Authoring is ALWAYS read-only. Task execution uses workspace-write —
  // config.sandbox can only narrow it to read-only, never broaden it.
  const sandbox: 'read-only' | 'workspace-write' =
    input.toolPolicy === 'implementation'
      ? config.sandbox === 'read-only'
        ? 'read-only'
        : 'workspace-write'
      : 'read-only';
  argv.push('--sandbox', sandbox);

  const tmpDir = path.join(execution.runDir, 'tmp');
  if (supports('--output-schema')) {
    const schemaPath = path.join(tmpDir, 'codex-output-schema.json');
    if (input.materializeTempFiles !== false) {
      mkdirSync(tmpDir, { recursive: true });
      writeFileAtomic(schemaPath, `${JSON.stringify(input.outputJsonSchema, null, 2)}\n`);
      tempFiles.push(schemaPath);
    }
    argv.push('--output-schema', schemaPath);
  } else {
    skippedFlags.push('--output-schema');
  }

  let lastMessagePath: string | undefined;
  if (supports('--output-last-message')) {
    lastMessagePath = path.join(tmpDir, 'codex-last-message.txt');
    if (input.materializeTempFiles !== false) {
      mkdirSync(tmpDir, { recursive: true });
    }
    argv.push('--output-last-message', lastMessagePath);
    tempFiles.push(lastMessagePath);
  } else {
    skippedFlags.push('--output-last-message');
  }

  const model = execution.model ?? config.model;
  if (model !== null && model !== undefined) {
    if (supports('--model')) argv.push('--model', model);
    else skippedFlags.push('--model');
  }

  // Prompt via stdin: `-` tells codex exec to read the prompt from stdin,
  // keeping spec content out of the process list.
  argv.push('-');

  assertNoForbiddenCodexArguments(argv);

  return {
    executable: config.command.executable,
    argv,
    stdin: input.prompt,
    sandbox,
    ...(lastMessagePath !== undefined ? { lastMessagePath } : {}),
    tempFiles,
    skippedFlags,
  };
}

export async function runCodexInvocation(
  plan: CodexInvocationPlan,
  config: CodexProfileConfig,
  execution: RunnerExecutionOptions,
): Promise<SafeProcessResult> {
  assertNoForbiddenCodexArguments(plan.argv);
  return runSafeProcess({
    executable: plan.executable,
    argv: plan.argv,
    cwd: execution.workspaceRoot,
    timeoutMs: execution.timeoutMs,
    ...(execution.signal !== undefined ? { signal: execution.signal } : {}),
    stdin: plan.stdin,
    maxStdoutBytes: config.maxStdoutBytes,
    maxStderrBytes: config.maxStderrBytes,
  });
}

/** Read the final-message file when the CLI wrote one. */
export function readLastMessage(plan: CodexInvocationPlan): string | undefined {
  if (plan.lastMessagePath === undefined || !existsSync(plan.lastMessagePath)) return undefined;
  try {
    return readFileSync(plan.lastMessagePath, 'utf8');
  } catch {
    return undefined;
  }
}

/** Remove invocation temp files. Best-effort; called on every outcome. */
export function cleanupCodexTempFiles(plan: CodexInvocationPlan): void {
  for (const file of plan.tempFiles) {
    rmSync(file, { force: true });
  }
}
