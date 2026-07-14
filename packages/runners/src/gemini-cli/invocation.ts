import type { GeminiProfileConfig } from '@specbridge/core';
import { SpecBridgeError } from '@specbridge/core';
import type { RunnerExecutionOptions, RunnerToolPolicy } from '../contract.js';
import type { SafeProcessResult } from '../safe-process.js';
import { runSafeProcess } from '../safe-process.js';
import type { GeminiProbe } from './detection.js';

/**
 * Gemini CLI invocation: argument-vector construction and process execution.
 *
 * Hard rules (tested):
 *   - the argument vector is an array; no shell string is ever built
 *   - YOLO can never appear: not as a flag, not as an approval-mode value,
 *     whatever the configuration says (asserted pre-spawn)
 *   - authoring ALWAYS uses the plan approval mode (or, on installations
 *     without plan mode, a read-only tool allowlist) — never an edit mode
 *   - task execution uses auto_edit with a bounded tool set that excludes
 *     every shell-execution tool
 *   - workspace trust is never granted and extensions are disabled where
 *     supported
 *   - the prompt travels via stdin, never via a process-list-visible argument
 *   - resume uses an explicit session UUID only — never "latest", never an
 *     index
 *   - only flags detected in help output are passed (graceful degradation)
 */

/** Flags that must never be passed to the Gemini CLI (asserted pre-spawn). */
export const GEMINI_FORBIDDEN_ARGUMENTS = [
  '--yolo',
  '-y',
  '--dangerously-skip-permissions',
  '--trust-folder',
  '--trust',
];

/** Approval-mode values SpecBridge is allowed to pass. */
export const GEMINI_ALLOWED_APPROVAL_MODES = ['plan', 'default', 'auto_edit'] as const;

/** Repository-reading tools allowed during authoring. */
export const GEMINI_READ_ONLY_TOOLS = [
  'read_file',
  'read_many_files',
  'list_directory',
  'glob',
  'search_file_content',
];

/** File-editing tools additionally allowed during task execution. */
export const GEMINI_EDIT_TOOLS = ['replace', 'write_file'];

/** Tool names that must never be allowed (arbitrary execution). */
export const GEMINI_FORBIDDEN_TOOLS = [
  'run_shell_command',
  'shell',
  'bash',
  'execute_command',
  'terminal',
];

const SESSION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the value is an explicit session UUID (never "latest"/index). */
export function isExplicitGeminiSessionId(value: string): boolean {
  return SESSION_UUID_PATTERN.test(value);
}

export interface GeminiInvocationPlan {
  executable: string;
  argv: string[];
  /** Prompt content delivered via stdin. */
  stdin: string;
  outputFormat: 'json' | 'stream-json';
  /** The approval mode the plan uses (never yolo). */
  approvalMode: string;
  /** The tool allowlist passed, when the CLI supports one. */
  allowedTools?: string[];
  /** Flags that were requested but skipped because the CLI lacks them. */
  skippedFlags: string[];
}

export interface BuildGeminiInvocationInput {
  config: GeminiProfileConfig;
  probe: GeminiProbe;
  prompt: string;
  toolPolicy: RunnerToolPolicy;
  /** Resume an existing provider session (explicit UUID only, never "latest"). */
  resumeSessionId?: string;
  execution: RunnerExecutionOptions;
}

/** Defense in depth: no code path may assemble an unrestricted invocation. */
export function assertNoForbiddenGeminiArguments(argv: readonly string[]): void {
  for (const argument of argv) {
    for (const forbidden of GEMINI_FORBIDDEN_ARGUMENTS) {
      if (argument === forbidden) {
        throw new SpecBridgeError(
          'INVALID_STATE',
          `Refusing to invoke the Gemini CLI: the argument vector contains "${forbidden}". ` +
            'SpecBridge never uses YOLO, never skips approvals, and never auto-trusts a workspace.',
        );
      }
    }
  }
  const approvalIndex = argv.indexOf('--approval-mode');
  if (approvalIndex >= 0) {
    const mode = argv[approvalIndex + 1];
    if (!GEMINI_ALLOWED_APPROVAL_MODES.includes(mode as (typeof GEMINI_ALLOWED_APPROVAL_MODES)[number])) {
      throw new SpecBridgeError(
        'INVALID_STATE',
        `Refusing to invoke the Gemini CLI with approval mode "${mode ?? '(missing)'}". ` +
          `Only ${GEMINI_ALLOWED_APPROVAL_MODES.join(', ')} are ever used — never yolo.`,
      );
    }
  }
  const toolsIndex = argv.indexOf('--allowed-tools');
  if (toolsIndex >= 0) {
    const tools = (argv[toolsIndex + 1] ?? '').split(',');
    for (const tool of tools) {
      if (GEMINI_FORBIDDEN_TOOLS.includes(tool.trim().toLowerCase())) {
        throw new SpecBridgeError(
          'INVALID_STATE',
          `Refusing to invoke the Gemini CLI with allowed tool "${tool}". ` +
            'SpecBridge never grants the Gemini CLI arbitrary shell access.',
        );
      }
    }
  }
  const resumeIndex = argv.indexOf('--resume');
  if (resumeIndex >= 0) {
    const session = argv[resumeIndex + 1];
    if (session === undefined || !isExplicitGeminiSessionId(session)) {
      throw new SpecBridgeError(
        'INVALID_STATE',
        `Refusing to resume the Gemini session "${session ?? '(missing)'}": resume requires an ` +
          'explicit session UUID — "latest", indexes, and ambiguous identifiers are never used.',
      );
    }
  }
}

/** Build the full argument vector. Pure; safe to preview (no side effects). */
export function buildGeminiInvocation(input: BuildGeminiInvocationInput): GeminiInvocationPlan {
  const { config, probe, execution } = input;
  const argv: string[] = [...config.command.args];
  const skippedFlags: string[] = [];
  const supports = (token: string): boolean => probe.supportedTokens.has(token);
  const implementation = input.toolPolicy === 'implementation';

  // Headless mode; the prompt itself travels via stdin (process-list safety).
  argv.push('--prompt');

  const outputFormat: 'json' | 'stream-json' = supports('stream-json') ? 'stream-json' : 'json';
  argv.push('--output-format', outputFormat);

  // Authoring is ALWAYS plan (read-only). Task execution uses the configured
  // bounded edit mode (auto_edit or default) — never yolo, which is neither a
  // schema value nor accepted by the pre-spawn assertion.
  const approvalMode = implementation
    ? config.approvalModeForExecution
    : config.approvalModeForAuthoring;
  argv.push('--approval-mode', approvalMode);

  let allowedTools: string[] | undefined;
  if (supports('--allowed-tools')) {
    allowedTools = implementation
      ? [
          ...GEMINI_READ_ONLY_TOOLS,
          ...GEMINI_EDIT_TOOLS,
          ...config.allowedTools.filter(
            (tool) => !GEMINI_FORBIDDEN_TOOLS.includes(tool.toLowerCase()),
          ),
        ]
      : [...GEMINI_READ_ONLY_TOOLS];
    argv.push('--allowed-tools', allowedTools.join(','));
  } else {
    skippedFlags.push('--allowed-tools');
  }

  if (config.sandbox) {
    if (supports('--sandbox')) argv.push('--sandbox');
    else skippedFlags.push('--sandbox');
  }

  if (config.disabledExtensions) {
    if (supports('--extensions')) argv.push('--extensions', 'none');
    else skippedFlags.push('--extensions');
  }

  const model = execution.model ?? config.model;
  if (model !== null && model !== undefined) {
    if (supports('--model')) argv.push('--model', model);
    else skippedFlags.push('--model');
  }

  if (input.resumeSessionId !== undefined) {
    if (!isExplicitGeminiSessionId(input.resumeSessionId)) {
      throw new SpecBridgeError(
        'INVALID_ARGUMENT',
        `Cannot resume Gemini session "${input.resumeSessionId}": an explicit session UUID is required ` +
          '("latest", indexes, and ambiguous identifiers are never used).',
      );
    }
    argv.push('--resume', input.resumeSessionId);
  }

  assertNoForbiddenGeminiArguments(argv);

  return {
    executable: config.command.executable,
    argv,
    stdin: input.prompt,
    outputFormat,
    approvalMode,
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    skippedFlags,
  };
}

export async function runGeminiInvocation(
  plan: GeminiInvocationPlan,
  config: GeminiProfileConfig,
  execution: RunnerExecutionOptions,
): Promise<SafeProcessResult> {
  assertNoForbiddenGeminiArguments(plan.argv);
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
