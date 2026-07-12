import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ClaudeRunnerConfig } from '@specbridge/core';
import { SpecBridgeError, writeFileAtomic } from '@specbridge/core';
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
  /** Temp files the invocation writes under `<runDir>/tmp/`. */
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
   * False for dry-run previews: temp files (the output schema) are not
   * written and a placeholder path appears in the argv instead.
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
    const schemaPath = path.join(execution.runDir, 'tmp', 'output-schema.json');
    if (input.materializeTempFiles !== false) {
      mkdirSync(path.dirname(schemaPath), { recursive: true });
      writeFileAtomic(schemaPath, `${JSON.stringify(input.outputJsonSchema, null, 2)}\n`);
      tempFiles.push(schemaPath);
    }
    argv.push('--json-schema', schemaPath);
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
    if (data.structured_result !== undefined) {
      return { envelope: data, structuredResult: data.structured_result };
    }
    if (data.result !== undefined) {
      return { envelope: data, reportText: data.result };
    }
    // An envelope without a result field (e.g. an error envelope).
    return { envelope: data };
  }

  return { problem: 'no JSON result envelope found in the runner output' };
}
