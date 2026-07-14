import type { ClaudeRunnerConfig, Diagnostic, RunnerStatus } from '@specbridge/core';
import type { RunnerAuthState, RunnerCapability, RunnerCapabilityId } from '../contract.js';
import type { RunnerCapabilitySet } from '../contracts/capabilities.js';
import { capabilitySet } from '../contracts/capabilities.js';
import { runSafeProcess } from '../safe-process.js';

/**
 * Claude Code executable, authentication, and capability detection.
 *
 * Everything here is read-only: `--version`, `--help`, and `auth status`.
 * Detection never prints credential material — only "authenticated" /
 * "not authenticated" / "unknown" plus exit-status-level diagnostics.
 *
 * Capability detection searches help text for flag tokens instead of parsing
 * one exact help layout, so newer/older CLI versions degrade gracefully:
 * a missing optional flag lowers compatibility, it does not crash.
 */

export interface ClaudeCapabilityFlag {
  id: RunnerCapabilityId;
  label: string;
  /** Flag tokens that indicate the capability (any match counts). */
  flags: string[];
  required: boolean;
  /** Reported when the capability is missing but execution can continue. */
  degradedNote?: string;
}

export const CLAUDE_CAPABILITY_FLAGS: ClaudeCapabilityFlag[] = [
  {
    id: 'non-interactive',
    label: 'Non-interactive print mode',
    flags: ['--print', '-p'],
    required: true,
  },
  {
    id: 'json-output',
    label: 'JSON output',
    flags: ['--output-format'],
    required: true,
  },
  {
    id: 'structured-output',
    label: 'Structured output (JSON Schema)',
    flags: ['--json-schema'],
    required: false,
    degradedNote:
      'final output will be validated JSON extracted from the result text (degraded compatibility)',
  },
  {
    id: 'session-id',
    label: 'Session IDs',
    flags: ['--session-id'],
    required: false,
    degradedNote: 'runs cannot be resumed later',
  },
  {
    id: 'resume',
    label: 'Resume support',
    flags: ['--resume'],
    required: false,
    degradedNote: 'interrupted runs need a fresh attempt instead of a resume',
  },
  {
    id: 'tool-restriction',
    label: 'Tool restrictions',
    flags: ['--allowedTools', '--allowed-tools', '--disallowedTools'],
    required: true,
  },
  {
    id: 'permission-modes',
    label: 'Permission modes',
    flags: ['--permission-mode'],
    required: true,
  },
  {
    id: 'max-turns',
    label: 'Maximum turn limit',
    flags: ['--max-turns'],
    required: false,
    degradedNote: 'SpecBridge still enforces its own process timeout',
  },
  {
    id: 'max-budget',
    label: 'Maximum budget limit',
    flags: ['--max-budget-usd'],
    required: false,
    degradedNote: 'budget limits are unavailable; use turn limits and timeouts',
  },
];

/** Optional invocation flags probed from help so we only pass what exists. */
export const OPTIONAL_FLAGS = [
  '--model',
  '--effort',
  '--append-system-prompt-file',
  '--setting-sources',
] as const;
export type OptionalClaudeFlag = (typeof OPTIONAL_FLAGS)[number];

export interface ClaudeProbe {
  executable: string;
  commandArgs: string[];
  found: boolean;
  version?: string;
  authState: RunnerAuthState;
  capabilities: RunnerCapability[];
  /** Flags (from OPTIONAL_FLAGS plus capability flags) present in help. */
  supportedFlags: Set<string>;
  status: RunnerStatus;
  diagnostics: Diagnostic[];
}

/**
 * Claude Code capabilities when the local installation is fully available.
 * `structuredFinalOutput` is honest without `--json-schema`: the adapter's
 * validated JSON-extraction fallback passed structured-output conformance.
 * Tool restriction + permission modes are the documented safe execution
 * boundary (no OS sandbox; no bypass flags, ever).
 */
export const CLAUDE_DECLARED_CAPABILITIES: RunnerCapabilitySet = capabilitySet([
  'stageGeneration',
  'stageRefinement',
  'taskExecution',
  'taskResume',
  'structuredFinalOutput',
  'repositoryRead',
  'repositoryWrite',
  'toolRestriction',
  'usageReporting',
  'costReporting',
  'requiresNetwork',
  'supportsSystemPrompt',
  'supportsJsonSchema',
  'supportsCancellation',
]);

/** Downgrade declared capabilities to what the installed CLI actually has. */
export function claudeCapabilitySet(probe: ClaudeProbe): RunnerCapabilitySet {
  if (!probe.found) {
    return capabilitySet([]);
  }
  const has = (id: RunnerCapabilityId): boolean =>
    probe.capabilities.find((capability) => capability.id === id)?.available === true;
  const set: RunnerCapabilitySet = { ...CLAUDE_DECLARED_CAPABILITIES };
  const executionReady =
    has('non-interactive') && has('json-output') && has('tool-restriction') && has('permission-modes');
  set.taskExecution = executionReady;
  set.taskResume = executionReady && has('resume');
  set.toolRestriction = has('tool-restriction');
  set.supportsJsonSchema = has('structured-output');
  // The validated text fallback keeps structuredFinalOutput true as long as
  // JSON output mode exists at all.
  set.structuredFinalOutput = has('json-output');
  set.stageGeneration = has('non-interactive') && has('json-output');
  set.stageRefinement = set.stageGeneration;
  return set;
}

const PROBE_TIMEOUT_MS = 15_000;

function capabilityFromHelp(flag: ClaudeCapabilityFlag, helpText: string): RunnerCapability {
  const available = flag.flags.some((token) => helpTokenPresent(helpText, token));
  return {
    id: flag.id,
    label: flag.label,
    available,
    required: flag.required,
    ...(available || flag.degradedNote === undefined ? {} : { detail: flag.degradedNote }),
  };
}

/** Match a flag token on a word boundary so `--print` does not match `--print-x`. */
function helpTokenPresent(helpText: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,])${escaped}(?![\\w-])`, 'm').test(helpText);
}

export async function probeClaude(
  config: ClaudeRunnerConfig,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<ClaudeProbe> {
  const diagnostics: Diagnostic[] = [];
  const timeoutMs = options?.timeoutMs ?? PROBE_TIMEOUT_MS;
  const base = {
    executable: config.command,
    commandArgs: config.commandArgs,
  };

  const invoke = (argv: string[]) =>
    runSafeProcess({
      executable: config.command,
      argv: [...config.commandArgs, ...argv],
      cwd: process.cwd(),
      timeoutMs,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      maxStdoutBytes: 1024 * 1024,
      maxStderrBytes: 256 * 1024,
    });

  // 1. Version probe — also proves the executable spawns at all.
  const versionResult = await invoke(['--version']);
  if (versionResult.status === 'spawn-failed') {
    diagnostics.push({
      severity: 'error',
      code: 'RUNNER_EXECUTABLE_NOT_FOUND',
      message:
        `Claude Code executable "${config.command}" could not be started. ` +
        'Install Claude Code or set runners.claude-code.command in .specbridge/config.json.',
    });
    return {
      ...base,
      found: false,
      authState: 'unknown',
      capabilities: CLAUDE_CAPABILITY_FLAGS.map((flag) => ({
        id: flag.id,
        label: flag.label,
        available: false,
        required: flag.required,
      })),
      supportedFlags: new Set(),
      status: 'unavailable',
      diagnostics,
    };
  }
  if (versionResult.status === 'timeout') {
    diagnostics.push({
      severity: 'error',
      code: 'RUNNER_VERSION_TIMEOUT',
      message: `"${config.command} --version" did not finish within ${timeoutMs} ms.`,
    });
    return {
      ...base,
      found: true,
      authState: 'unknown',
      capabilities: [],
      supportedFlags: new Set(),
      status: 'error',
      diagnostics,
    };
  }
  const version = versionResult.stdout.trim().split(/\r?\n/)[0]?.trim();
  if (versionResult.status !== 'ok' || version === undefined || version.length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'RUNNER_VERSION_FAILED',
      message: `"${config.command} --version" ${versionResult.failureReason ?? 'produced no output'}.`,
    });
    return {
      ...base,
      found: true,
      authState: 'unknown',
      capabilities: [],
      supportedFlags: new Set(),
      status: 'error',
      diagnostics,
    };
  }

  // 2. Help probe — capability detection by flag token, not help layout.
  const helpResult = await invoke(['--help']);
  const helpText = `${helpResult.stdout}\n${helpResult.stderr}`;
  const helpUsable = helpResult.status === 'ok' && helpText.trim().length > 0;
  if (!helpUsable) {
    diagnostics.push({
      severity: 'error',
      code: 'RUNNER_HELP_FAILED',
      message: `"${config.command} --help" ${helpResult.failureReason ?? 'produced no output'}; capabilities cannot be verified.`,
    });
  }
  const capabilities = CLAUDE_CAPABILITY_FLAGS.map((flag) =>
    helpUsable
      ? capabilityFromHelp(flag, helpText)
      : { id: flag.id, label: flag.label, available: false, required: flag.required },
  );
  const supportedFlags = new Set<string>();
  if (helpUsable) {
    for (const flag of CLAUDE_CAPABILITY_FLAGS) {
      for (const token of flag.flags) {
        if (helpTokenPresent(helpText, token)) supportedFlags.add(token);
      }
    }
    for (const token of OPTIONAL_FLAGS) {
      if (helpTokenPresent(helpText, token)) supportedFlags.add(token);
    }
  }

  // 3. Authentication probe — only when the CLI documents an auth command.
  //    Output is summarized, never echoed: it could contain account details.
  let authState: RunnerAuthState = 'unknown';
  if (helpUsable && /\bauth\b/.test(helpText)) {
    const authResult = await invoke(['auth', 'status']);
    if (authResult.status === 'ok') {
      authState = 'authenticated';
    } else if (authResult.status === 'nonzero-exit') {
      authState = 'unauthenticated';
      diagnostics.push({
        severity: 'error',
        code: 'RUNNER_UNAUTHENTICATED',
        message:
          'Claude Code is installed but not authenticated. Run "claude auth login" (SpecBridge never handles credentials), ' +
          'then verify with "specbridge runner doctor claude-code".',
      });
    } else {
      diagnostics.push({
        severity: 'warning',
        code: 'RUNNER_AUTH_PROBE_FAILED',
        message: `Authentication could not be verified (${authResult.failureReason ?? authResult.status}).`,
      });
    }
  } else if (helpUsable) {
    diagnostics.push({
      severity: 'info',
      code: 'RUNNER_AUTH_PROBE_UNSUPPORTED',
      message:
        'This Claude Code version exposes no "auth status" command; authentication will surface at execution time instead.',
    });
  }

  const missingRequired = capabilities.filter((c) => c.required && !c.available);
  let status: RunnerStatus;
  if (authState === 'unauthenticated') {
    status = 'unauthenticated';
  } else if (missingRequired.length > 0) {
    status = 'incompatible';
    diagnostics.push({
      severity: 'error',
      code: 'RUNNER_MISSING_CAPABILITY',
      message:
        `This Claude Code version is missing required capabilities: ` +
        `${missingRequired.map((c) => c.label).join(', ')}. ` +
        'Update Claude Code to a version that supports non-interactive JSON output with tool restrictions.',
    });
  } else if (!helpUsable) {
    status = 'error';
  } else {
    status = 'available';
    const degraded = capabilities.filter((c) => !c.required && !c.available);
    for (const capability of degraded) {
      diagnostics.push({
        severity: 'warning',
        code: 'RUNNER_DEGRADED_CAPABILITY',
        message: `Optional capability unavailable: ${capability.label}${capability.detail !== undefined ? ` — ${capability.detail}` : ''}.`,
      });
    }
  }

  return {
    ...base,
    found: true,
    version,
    authState,
    capabilities,
    supportedFlags,
    status,
    diagnostics,
  };
}
