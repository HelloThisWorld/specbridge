import type { Diagnostic, GeminiProfileConfig, RunnerStatus } from '@specbridge/core';
import type { RunnerAuthState, RunnerCapability, RunnerCapabilityId } from '../contract.js';
import type { RunnerCapabilitySet } from '../contracts/capabilities.js';
import { capabilitySet } from '../contracts/capabilities.js';
import { runSafeProcess } from '../safe-process.js';

/**
 * Gemini CLI executable, authentication, and capability detection (v0.6.1).
 *
 * Everything here is read-only: `--version` and `--help` only. Doctor-level
 * detection NEVER sends a model request, never triggers an interactive
 * login, never touches trusted-folder state, and never reads Google
 * credential files.
 *
 * Capability detection probes help text for flag/value tokens instead of
 * relying on one exact help layout, so newer/older CLI versions degrade
 * gracefully. The Gemini CLI exposes no safe offline authentication-status
 * command, so authentication is reported as `unknown` — a minimal
 * authenticated probe is available through `runner test <profile> --network`.
 */

export interface GeminiCapabilityProbe {
  id:
    | RunnerCapabilityId
    | 'headless'
    | 'output-json'
    | 'output-stream-json'
    | 'approval-mode'
    | 'plan-mode'
    | 'auto-edit-mode'
    | 'sandbox'
    | 'allowed-tools'
    | 'extension-restriction'
    | 'model-selection'
    | 'session-list';
  label: string;
  /** Any matching token in help output counts. */
  tokens: string[];
  required: boolean;
  degradedNote?: string;
}

export const GEMINI_CAPABILITY_PROBES: GeminiCapabilityProbe[] = [
  {
    id: 'headless',
    label: 'Headless prompt invocation (--prompt)',
    tokens: ['--prompt'],
    required: true,
  },
  {
    id: 'output-json',
    label: 'Machine-readable output (--output-format json)',
    tokens: ['--output-format'],
    required: true,
  },
  {
    id: 'output-stream-json',
    label: 'Streaming machine-readable events (stream-json)',
    tokens: ['stream-json'],
    required: false,
    degradedNote: 'the single JSON result envelope is used instead of streamed events',
  },
  {
    id: 'approval-mode',
    label: 'Approval-mode selection (--approval-mode)',
    tokens: ['--approval-mode'],
    required: true,
  },
  {
    id: 'plan-mode',
    label: 'Read-only plan approval mode (plan)',
    tokens: ['plan'],
    required: false,
    degradedNote: 'authoring needs a read-only tool allowlist instead of plan mode',
  },
  {
    id: 'auto-edit-mode',
    label: 'Edit-only approval mode (auto_edit)',
    tokens: ['auto_edit'],
    required: false,
    degradedNote: 'task execution is unavailable without a bounded edit approval mode',
  },
  {
    id: 'sandbox',
    label: 'Sandboxed tool execution (--sandbox)',
    tokens: ['--sandbox'],
    required: false,
    degradedNote: 'the tool allowlist is the only execution boundary',
  },
  {
    id: 'allowed-tools',
    label: 'Tool allowlist (--allowed-tools)',
    tokens: ['--allowed-tools'],
    required: false,
    degradedNote: 'the sandbox is the only execution boundary',
  },
  {
    id: 'extension-restriction',
    label: 'Extension restriction (--extensions)',
    tokens: ['--extensions'],
    required: false,
    degradedNote: 'installed extensions cannot be disabled for SpecBridge runs',
  },
  {
    id: 'model-selection',
    label: 'Model selection (--model)',
    tokens: ['--model'],
    required: false,
    degradedNote: 'the provider default model is used',
  },
  {
    id: 'session-list',
    label: 'Session listing (--list-sessions)',
    tokens: ['--list-sessions'],
    required: false,
  },
  {
    id: 'resume',
    label: 'Explicit session resume (--resume <session-id>)',
    tokens: ['--resume'],
    required: false,
    degradedNote: 'interrupted runs need a fresh attempt instead of a resume',
  },
];

/**
 * Gemini CLI capabilities when a fully featured installation is available.
 * Detection downgrades individual capabilities (never adds). There is no
 * `supportsJsonSchema`: the CLI cannot constrain output with a schema, so
 * structured output is a strict JSON-only response validated completely by
 * SpecBridge (the conformance-approved fallback).
 */
export const GEMINI_DECLARED_CAPABILITIES: RunnerCapabilitySet = capabilitySet([
  'stageGeneration',
  'stageRefinement',
  'taskExecution',
  'taskResume',
  'structuredFinalOutput',
  'streamingEvents',
  'repositoryRead',
  'repositoryWrite',
  'sandbox',
  'toolRestriction',
  'usageReporting',
  'requiresNetwork',
  'supportsCancellation',
]);

export interface GeminiProbe {
  executable: string;
  commandArgs: string[];
  found: boolean;
  version?: string;
  authState: RunnerAuthState;
  capabilities: RunnerCapability[];
  /** Tokens found in the probed help output. */
  supportedTokens: Set<string>;
  status: RunnerStatus;
  diagnostics: Diagnostic[];
}

const PROBE_TIMEOUT_MS = 15_000;

/** Match a token on a word boundary so `json` does not match `jsonl`. */
function tokenPresent(helpText: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,=<[|])${escaped}(?![\\w-])`, 'm').test(helpText);
}

export async function probeGemini(
  config: GeminiProfileConfig,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<GeminiProbe> {
  const diagnostics: Diagnostic[] = [];
  const timeoutMs = options?.timeoutMs ?? PROBE_TIMEOUT_MS;
  const base = {
    executable: config.command.executable,
    commandArgs: config.command.args,
  };

  const invoke = (argv: string[]) =>
    runSafeProcess({
      executable: config.command.executable,
      argv: [...config.command.args, ...argv],
      cwd: process.cwd(),
      timeoutMs,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      maxStdoutBytes: 1024 * 1024,
      maxStderrBytes: 256 * 1024,
    });

  const emptyCapabilities = (): RunnerCapability[] =>
    GEMINI_CAPABILITY_PROBES.map((probe) => ({
      id: probe.id,
      label: probe.label,
      available: false,
      required: probe.required,
    }));

  // 1. Version probe — also proves the executable spawns at all.
  const versionResult = await invoke(['--version']);
  if (versionResult.status === 'spawn-failed') {
    diagnostics.push({
      severity: 'error',
      code: 'RUNNER_EXECUTABLE_NOT_FOUND',
      message:
        `Gemini CLI executable "${config.command.executable}" could not be started. ` +
        'Install the Gemini CLI (the user installs and authenticates it independently) ' +
        'or set the profile command in .specbridge/config.json.',
    });
    return {
      ...base,
      found: false,
      authState: 'unknown',
      capabilities: emptyCapabilities(),
      supportedTokens: new Set(),
      status: 'unavailable',
      diagnostics,
    };
  }
  if (versionResult.status !== 'ok') {
    diagnostics.push({
      severity: 'error',
      code: 'RUNNER_VERSION_FAILED',
      message: `"${config.command.executable} --version" ${versionResult.failureReason ?? 'produced no output'}.`,
    });
    return {
      ...base,
      found: true,
      authState: 'unknown',
      capabilities: emptyCapabilities(),
      supportedTokens: new Set(),
      status: 'error',
      diagnostics,
    };
  }
  const version = versionResult.stdout.trim().split(/\r?\n/)[0]?.trim();

  // 2. Help probe — bounded token search, tolerant of layout changes.
  const help = await invoke(['--help']);
  const helpText = `${help.stdout}\n${help.stderr}`;
  const helpUsable = help.status === 'ok' && helpText.trim().length > 0;
  if (!helpUsable) {
    diagnostics.push({
      severity: 'error',
      code: 'RUNNER_HELP_FAILED',
      message: `"${config.command.executable} --help" ${help.failureReason ?? 'produced no output'}; capabilities cannot be verified.`,
    });
  }

  const supportedTokens = new Set<string>();
  const capabilities: RunnerCapability[] = GEMINI_CAPABILITY_PROBES.map((probe) => {
    const available = helpUsable && probe.tokens.some((token) => tokenPresent(helpText, token));
    if (available) for (const token of probe.tokens) supportedTokens.add(token);
    return {
      id: probe.id,
      label: probe.label,
      available,
      required: probe.required,
      ...(available || probe.degradedNote === undefined ? {} : { detail: probe.degradedNote }),
    };
  });

  // 3. Authentication: the Gemini CLI exposes no safe offline status command.
  //    SpecBridge never reads OAuth caches or credential files, never starts
  //    the interactive login, and therefore reports `unknown`.
  const authState: RunnerAuthState = 'unknown';
  if (helpUsable) {
    diagnostics.push({
      severity: 'info',
      code: 'RUNNER_AUTH_PROBE_UNSUPPORTED',
      message:
        'Authentication cannot be verified without a model request; it is reported as unknown ' +
        '(SpecBridge never reads Google credential files and never starts an interactive login). ' +
        'Use "specbridge runner test <profile> --network" for a minimal authenticated probe.',
    });
  }

  const available = (id: GeminiCapabilityProbe['id']): boolean =>
    capabilities.find((capability) => capability.id === id)?.available === true;

  const missingRequired = capabilities.filter((c) => c.required && !c.available);
  const authoringBoundary = available('plan-mode') || available('allowed-tools');
  let status: RunnerStatus;
  if (missingRequired.length > 0) {
    status = 'incompatible';
    diagnostics.push({
      severity: 'error',
      code: 'RUNNER_MISSING_CAPABILITY',
      message:
        `This Gemini CLI version is missing required capabilities: ` +
        `${missingRequired.map((c) => c.label).join(', ')}. ` +
        'Update the Gemini CLI to a version with headless prompts, machine-readable output, and approval-mode control.',
    });
  } else if (helpUsable && !authoringBoundary) {
    status = 'incompatible';
    diagnostics.push({
      severity: 'error',
      code: 'RUNNER_MISSING_CAPABILITY',
      message:
        'This Gemini CLI version offers neither a plan approval mode nor a tool allowlist, so a ' +
        'read-only authoring boundary cannot be established. SpecBridge never weakens the boundary ' +
        '(and never uses YOLO) — update the Gemini CLI.',
    });
  } else if (!helpUsable) {
    status = 'error';
  } else {
    status = 'available';
    for (const capability of capabilities.filter((c) => !c.required && !c.available)) {
      diagnostics.push({
        severity: 'warning',
        code: 'RUNNER_DEGRADED_CAPABILITY',
        message: `Optional capability unavailable: ${capability.label}${capability.detail !== undefined ? ` — ${capability.detail}` : ''}.`,
      });
    }
    if (!available('auto-edit-mode') || (!available('allowed-tools') && !available('sandbox'))) {
      diagnostics.push({
        severity: 'warning',
        code: 'RUNNER_TASK_EXECUTION_UNAVAILABLE',
        message:
          'Task execution is unavailable for this installation: file edits cannot be permitted ' +
          'without also permitting arbitrary shell commands (needs auto_edit plus a tool allowlist or sandbox). ' +
          'Authoring remains available. Use a claude-code or codex-cli profile for task execution.',
      });
    }
  }

  return {
    ...base,
    found: true,
    ...(version !== undefined && version.length > 0 ? { version } : {}),
    authState,
    capabilities,
    supportedTokens,
    status,
    diagnostics,
  };
}

function probeAvailable(probe: GeminiProbe, id: GeminiCapabilityProbe['id']): boolean {
  return probe.capabilities.find((capability) => capability.id === id)?.available === true;
}

/** Downgrade declared capabilities to what the installed CLI actually has. */
export function geminiCapabilitySet(probe: GeminiProbe): RunnerCapabilitySet {
  if (!probe.found) return capabilitySet([]);
  const set: RunnerCapabilitySet = { ...GEMINI_DECLARED_CAPABILITIES };
  const headless =
    probeAvailable(probe, 'headless') &&
    probeAvailable(probe, 'output-json') &&
    probeAvailable(probe, 'approval-mode');
  const plan = probeAvailable(probe, 'plan-mode');
  const allowedTools = probeAvailable(probe, 'allowed-tools');
  const sandbox = probeAvailable(probe, 'sandbox');
  const autoEdit = probeAvailable(probe, 'auto-edit-mode');

  // Authoring needs a proven read-only boundary: plan mode or a tool
  // allowlist restricted to repository-reading operations.
  set.stageGeneration = headless && (plan || allowedTools);
  set.stageRefinement = set.stageGeneration;
  set.structuredFinalOutput = headless;
  set.streamingEvents = probeAvailable(probe, 'output-stream-json');
  set.sandbox = sandbox;
  set.toolRestriction = allowedTools;
  // Task execution needs a bounded edit policy: auto_edit (edits only are
  // auto-approved; everything else — including shell — is refused headlessly)
  // PLUS a tool allowlist or sandbox. YOLO is never an option.
  set.taskExecution = headless && autoEdit && (allowedTools || sandbox);
  set.repositoryWrite = set.taskExecution;
  set.taskResume = set.taskExecution && probeAvailable(probe, 'resume');
  return set;
}
