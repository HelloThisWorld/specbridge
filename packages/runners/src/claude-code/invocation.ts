import { rmSync } from 'node:fs';
import { z } from 'zod';
import type { ClaudeRunnerConfig } from '@specbridge/core';
import { SpecBridgeError } from '@specbridge/core';
import type { RunnerExecutionOptions, RunnerToolPolicy } from '../contract.js';
import type { SafeProcessResult } from '../safe-process.js';
import { runSafeProcess } from '../safe-process.js';
import type { ClaudeProbe } from './detection.js';

/**
 * Claude Code invocation: argument-vector construction, process execution,
 * and envelope parsing.
 *
 * Hard rules (tested):
 *   - the argument vector is an array; no shell string is ever built
 *   - no permission-bypass flag can appear, whatever the configuration says
 *   - the prompt travels via stdin, never via a process-list-visible argument
 *   - only flags detected in `--help` are passed (graceful degradation)
 */

const FORBIDDEN_ARGUMENTS = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  'bypassPermissions',
];

/** Tools for each policy tier. Task execution uses the configured set. */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const;

export interface ClaudeInvocationPlan {
  executable: string;
  argv: string[];
  /** Prompt content delivered via stdin. */
  stdin: string;
  /**
   * Temp files the invocation writes under `<runDir>/tmp/`. Claude Code
   * needs none: the output schema travels inside the argument vector.
   */
  tempFiles: string[];
  /** Flags that were requested but skipped because the CLI lacks them. */
  skippedFlags: string[];
}

export interface BuildInvocationInput {
  config: ClaudeRunnerConfig;
  probe: ClaudeProbe;
  prompt: string;
  toolPolicy: RunnerToolPolicy;
  /** JSON Schema for the structured final output. */
  outputJsonSchema: Record<string, unknown>;
  sessionId?: string;
  /** Resume an existing session instead of starting one. */
  resumeSessionId?: string;
  execution: RunnerExecutionOptions;
  /**
   * Retained for callers shared with runners that DO materialize temp
   * files. Claude Code writes none, so this no longer affects the plan.
   */
  materializeTempFiles?: boolean;
}

function allowedToolsValue(config: ClaudeRunnerConfig, policy: RunnerToolPolicy): string {
  if (policy !== 'implementation') {
    // Stage generation: repository reading only. No Edit/Write/Bash at all.
    return READ_ONLY_TOOLS.join(',');
  }
  const tools = config.tools.filter((tool) => tool !== 'Bash');
  const bashConfigured = config.tools.includes('Bash');
  const rules = bashConfigured ? config.allowedBashRules : [];
  return [...tools, ...rules].join(',');
}

/** Build the full argument vector. Pure; safe to show in dry runs. */
export function buildClaudeInvocation(input: BuildInvocationInput): ClaudeInvocationPlan {
  const { config, probe, execution } = input;
  const argv: string[] = [...config.commandArgs];
  const tempFiles: string[] = [];
  const skippedFlags: string[] = [];
  const supports = (flag: string): boolean => probe.supportedFlags.has(flag);
  const pushIfSupported = (flag: string, ...values: string[]): void => {
    if (supports(flag)) argv.push(flag, ...values);
    else skippedFlags.push(flag);
  };

  argv.push(supports('--print') ? '--print' : '-p');
  argv.push('--output-format', 'json');

  if (supports('--json-schema')) {
    // Claude Code takes the JSON Schema DEFINITION as the flag value, not a
    // path to a schema file. The serialized schema is exactly one argv
    // element: no shell is involved, so no quoting is applied here.
    argv.push('--json-schema', JSON.stringify(input.outputJsonSchema));
  } else {
    skippedFlags.push('--json-schema');
  }

  const maxTurns = execution.maxTurns ?? config.maxTurns;
  pushIfSupported('--max-turns', String(maxTurns));

  // Stage generation must not edit anything, so it always runs in the
  // default permission mode; only task execution uses the configured mode.
  const permissionMode = input.toolPolicy === 'implementation' ? config.permissionMode : 'default';
  pushIfSupported('--permission-mode', permissionMode);

  const toolsFlag = supports('--allowedTools') ? '--allowedTools' : '--allowed-tools';
  argv.push(toolsFlag, allowedToolsValue(config, input.toolPolicy));

  if (input.resumeSessionId !== undefined) {
    argv.push('--resume', input.resumeSessionId);
  } else if (input.sessionId !== undefined && supports('--session-id')) {
    argv.push('--session-id', input.sessionId);
  }

  const model = execution.model ?? config.model;
  if (model !== null && model !== undefined) pushIfSupported('--model', model);
  if (config.effort !== null) pushIfSupported('--effort', config.effort);
  const maxBudget = execution.maxBudgetUsd ?? config.maxBudgetUsd;
  if (maxBudget !== null && maxBudget !== undefined) {
    pushIfSupported('--max-budget-usd', String(maxBudget));
  }
  if (!config.loadProjectConfiguration) {
    pushIfSupported('--setting-sources', 'user');
  }

  assertNoForbiddenArguments(argv);

  return {
    executable: config.command,
    argv,
    stdin: input.prompt,
    tempFiles,
    skippedFlags,
  };
}

/** Defense in depth: no code path may assemble a permission bypass. */
export function assertNoForbiddenArguments(argv: readonly string[]): void {
  for (const argument of argv) {
    for (const forbidden of FORBIDDEN_ARGUMENTS) {
      if (argument.includes(forbidden)) {
        throw new SpecBridgeError(
          'INVALID_STATE',
          `Refusing to invoke Claude Code: the argument vector contains "${forbidden}". ` +
            'SpecBridge never skips or bypasses runner permissions.',
        );
      }
    }
  }
}

export async function runClaudeInvocation(
  plan: ClaudeInvocationPlan,
  config: ClaudeRunnerConfig,
  execution: RunnerExecutionOptions,
): Promise<SafeProcessResult> {
  assertNoForbiddenArguments(plan.argv);
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

/** Remove invocation temp files after a successful run. Best-effort. */
export function cleanupTempFiles(plan: ClaudeInvocationPlan): void {
  for (const file of plan.tempFiles) {
    rmSync(file, { force: true });
  }
}

/**
 * The Claude Code `--output-format json` envelope, parsed tolerantly.
 * Unknown fields are preserved; only the fields SpecBridge needs are typed.
 */
const claudeEnvelopeSchema = z
  .object({
    type: z.string().optional(),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    result: z.string().optional(),
    session_id: z.string().optional(),
    // Current Claude Code emits `structured_output`; `structured_result`
    // is the obsolete spelling, still parsed for older installations.
    structured_output: z.unknown().optional(),
    structured_result: z.unknown().optional(),
    permission_denials: z.array(z.unknown()).optional(),
  })
  .passthrough();
export type ClaudeEnvelope = z.infer<typeof claudeEnvelopeSchema>;

export interface EnvelopeParseResult {
  envelope?: ClaudeEnvelope;
  /** The text that should contain the structured report. */
  reportText?: string;
  /** Structured result object when the CLI emitted one directly. */
  structuredResult?: unknown;
  problem?: string;
}

/**
 * Parse stdout into the result envelope. `--output-format json` prints one
 * JSON object; some versions stream JSON lines first, so the last parseable
 * JSON object wins. Never guesses at malformed output.
 */
export function parseClaudeEnvelope(stdout: string): EnvelopeParseResult {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { problem: 'the runner produced no output' };
  }

  const candidates: string[] = [];
  candidates.push(trimmed);
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim() ?? '';
    if (line.startsWith('{')) candidates.push(line);
  }

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const envelope = claudeEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) continue;
    const data = envelope.data;
    const structured = data.structured_output ?? data.structured_result;
    if (structured !== undefined && structured !== null) {
      return { envelope: data, structuredResult: structured };
    }
    if (data.result !== undefined) {
      return { envelope: data, reportText: data.result };
    }
    // An envelope without a result field (e.g. an error envelope).
    return { envelope: data };
  }

  return { problem: 'no JSON result envelope found in the runner output' };
}

/** Upper bound on stderr characters retained in a failure diagnostic. */
export const MAX_STDERR_DIAGNOSTIC_CHARS = 500;

/**
 * Patterns whose matches never survive into a retained diagnostic. Bounded
 * process output is still process output: a CLI is free to echo an
 * authorization header or a key-shaped value into stderr.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/gi,
  /\bbearer\s+[A-Za-z0-9._-]{8,}/gi,
  /\boauth-[A-Za-z0-9-]{6,}/gi,
  /\b(?:api[-_]?keys?|access[-_]?tokens?|secrets?|passwords?)\b(?:\s*[:=]\s*\S+)?/gi,
];

/** Replace credential-shaped substrings with a fixed marker. */
export function redactCredentials(text: string): string {
  let redacted = text;
  for (const pattern of CREDENTIAL_PATTERNS) redacted = redacted.replace(pattern, '[redacted]');
  return redacted;
}

/**
 * A bounded, single-line, credential-scrubbed excerpt of stderr, or
 * undefined when stderr carries nothing useful. Never returns unbounded
 * process output.
 */
export function stderrDiagnostic(stderr: string): string | undefined {
  const collapsed = redactCredentials(stderr).replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return undefined;
  if (collapsed.length <= MAX_STDERR_DIAGNOSTIC_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_STDERR_DIAGNOSTIC_CHARS)}… [truncated]`;
}

/**
 * Compose the problem text for a Claude invocation that produced no usable
 * result envelope. When the process also exited non-zero, the CLI's own
 * stderr message is the only signal that explains why — losing it collapses
 * every provider-side failure into an indistinguishable "no output".
 *
 * This changes diagnostics only. A provider or CLI failure remains a WORKER
 * failure: it never becomes task completion and never completes a task.
 */
export function claudeFailureProblem(
  problem: string,
  processResult: Pick<SafeProcessResult, 'status' | 'stderr'>,
): string {
  if (processResult.status !== 'nonzero-exit') return problem;
  const diagnostic = stderrDiagnostic(processResult.stderr);
  return diagnostic === undefined ? problem : `${problem} (claude stderr: ${diagnostic})`;
}
