import type { CodexProfileConfig, Diagnostic, RunnerStatus } from '@specbridge/core';
import type { RunnerAuthState, RunnerCapability, RunnerCapabilityId } from '../contract.js';
import type { RunnerCapabilitySet } from '../contracts/capabilities.js';
import { capabilitySet } from '../contracts/capabilities.js';
import { runSafeProcess } from '../safe-process.js';

/**
 * Codex CLI executable, authentication, and capability detection.
 *
 * Everything here is read-only: `--version`, `--help`, `exec --help`, and
 * `login status`. Doctor-level detection NEVER sends a model request.
 *
 * Capability detection probes help text for flag/subcommand tokens instead
 * of relying on one exact help layout, so newer/older CLI versions degrade
 * gracefully. Authentication uses the official `codex login status` command
 * when it exists; SpecBridge never reads Codex credential files — when no
 * safe command exists, authentication is reported as `unknown`.
 */

export interface CodexCapabilityProbe {
  id: RunnerCapabilityId | 'output-schema' | 'output-last-message' | 'sandbox-read-only' | 'sandbox-workspace-write' | 'json-events' | 'model-selection';
  label: string;
  /** Any matching token in help output counts. */
  tokens: string[];
  /** Which help text to search: root `--help` or `exec --help`. */
  source: 'root' | 'exec';
  required: boolean;
  degradedNote?: string;
}

export const CODEX_CAPABILITY_PROBES: CodexCapabilityProbe[] = [
  {
    id: 'non-interactive',
    label: 'Non-interactive execution (exec)',
    tokens: ['exec'],
    source: 'root',
    required: true,
  },
  {
    id: 'json-events',
    label: 'Machine-readable event output (--json)',
    tokens: ['--json'],
    source: 'exec',
    required: true,
  },
  {
    id: 'output-schema',
    label: 'JSON Schema constrained output (--output-schema)',
    tokens: ['--output-schema'],
    source: 'exec',
    required: false,
    degradedNote: 'the final agent message is validated against the schema instead',
  },
  {
    id: 'output-last-message',
    label: 'Final message to file (--output-last-message)',
    tokens: ['--output-last-message'],
    source: 'exec',
    required: false,
    degradedNote: 'the final message is extracted from the event stream instead',
  },
  {
    id: 'sandbox-read-only',
    label: 'Read-only sandbox (--sandbox read-only)',
    tokens: ['--sandbox'],
    source: 'exec',
    required: true,
  },
  {
    id: 'sandbox-workspace-write',
    label: 'Workspace-write sandbox (--sandbox workspace-write)',
    tokens: ['workspace-write'],
    source: 'exec',
    required: false,
    degradedNote: 'task execution is unavailable without a workspace-write sandbox',
  },
  {
    id: 'resume',
    label: 'Session resume (exec resume <session-id>)',
    tokens: ['resume'],
    source: 'exec',
    required: false,
    degradedNote: 'interrupted runs need a fresh attempt instead of a resume',
  },
  {
    id: 'model-selection',
    label: 'Model selection (--model)',
    tokens: ['--model', '-m,'],
    source: 'exec',
    required: false,
    degradedNote: 'the provider default model is used',
  },
];

/** Argument fragments that must never be passed (asserted pre-spawn too). */
export const CODEX_FORBIDDEN_ARGUMENTS = [
  'danger-full-access',
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--skip-git-repo-check',
];

/**
 * Codex CLI capabilities when a fully featured installation is available.
 * `sandbox` is the safe execution boundary (read-only for authoring,
 * workspace-write for task execution; unrestricted modes are rejected at
 * three layers: config schema, argv assembly, pre-spawn assertion).
 */
export const CODEX_DECLARED_CAPABILITIES: RunnerCapabilitySet = capabilitySet([
  'stageGeneration',
  'stageRefinement',
  'taskExecution',
  'taskResume',
  'structuredFinalOutput',
  'streamingEvents',
  'repositoryRead',
  'repositoryWrite',
  'sandbox',
  'usageReporting',
  'requiresNetwork',
  'supportsJsonSchema',
  'supportsCancellation',
]);

export interface CodexProbe {
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

/** Match a token on a word boundary so `--json` does not match `--json-x`. */
function tokenPresent(helpText: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,=<[])${escaped}(?![\\w-])`, 'm').test(helpText);
}

export async function probeCodex(
  config: CodexProfileConfig,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<CodexProbe> {
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
    CODEX_CAPABILITY_PROBES.map((probe) => ({
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
        `Codex CLI executable "${config.command.executable}" could not be started. ` +
        'Install the Codex CLI (the user installs and authenticates it independently) ' +
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

  // 2. Help probes — root help for subcommands, exec help for flags.
  const rootHelp = await invoke(['--help']);
  const rootText = `${rootHelp.stdout}\n${rootHelp.stderr}`;
  const rootUsable = rootHelp.status === 'ok' && rootText.trim().length > 0;
  const execHelp = rootUsable && tokenPresent(rootText, 'exec') ? await invoke(['exec', '--help']) : undefined;
  const execText = execHelp !== undefined ? `${execHelp.stdout}\n${execHelp.stderr}` : '';
  const execUsable = execHelp !== undefined && execHelp.status === 'ok' && execText.trim().length > 0;

  if (!rootUsable) {
    diagnostics.push({
      severity: 'error',
      code: 'RUNNER_HELP_FAILED',
      message: `"${config.command.executable} --help" ${rootHelp.failureReason ?? 'produced no output'}; capabilities cannot be verified.`,
    });
  }

  const supportedTokens = new Set<string>();
  const capabilities: RunnerCapability[] = CODEX_CAPABILITY_PROBES.map((probe) => {
    const text = probe.source === 'root' ? rootText : execText;
    const usable = probe.source === 'root' ? rootUsable : execUsable;
    const available = usable && probe.tokens.some((token) => tokenPresent(text, token));
    if (available) for (const token of probe.tokens) supportedTokens.add(token);
    return {
      id: probe.id,
      label: probe.label,
      available,
      required: probe.required,
      ...(available || probe.degradedNote === undefined ? {} : { detail: probe.degradedNote }),
    };
  });

  // 3. Authentication — official safe command only; NEVER credential files.
  let authState: RunnerAuthState = 'unknown';
  if (rootUsable && tokenPresent(rootText, 'login')) {
    const loginStatus = await invoke(['login', 'status']);
    if (loginStatus.status === 'ok') {
      authState = 'authenticated';
    } else if (loginStatus.status === 'nonzero-exit') {
      authState = 'unauthenticated';
      diagnostics.push({
        severity: 'error',
        code: 'RUNNER_UNAUTHENTICATED',
        message:
          'The Codex CLI is installed but not authenticated. Run "codex login" yourself ' +
          '(SpecBridge never handles or stores credentials), then verify with "specbridge runner doctor".',
      });
    } else {
      diagnostics.push({
        severity: 'warning',
        code: 'RUNNER_AUTH_PROBE_FAILED',
        message: `Authentication could not be verified (${loginStatus.failureReason ?? loginStatus.status}). It will surface at execution time.`,
      });
    }
  } else if (rootUsable) {
    diagnostics.push({
      severity: 'info',
      code: 'RUNNER_AUTH_PROBE_UNSUPPORTED',
      message:
        'This Codex CLI version exposes no safe authentication status command; authentication is reported as unknown ' +
        '(SpecBridge never reads provider credential files). Use "specbridge runner test <profile> --network" for a minimal authenticated probe.',
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
        `This Codex CLI version is missing required capabilities: ` +
        `${missingRequired.map((c) => c.label).join(', ')}. ` +
        'Update the Codex CLI to a version with non-interactive exec, machine-readable output, and sandbox control.',
    });
  } else if (!rootUsable || !execUsable) {
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

function probeAvailable(probe: CodexProbe, id: CodexCapabilityProbe['id']): boolean {
  return probe.capabilities.find((capability) => capability.id === id)?.available === true;
}

/** Downgrade declared capabilities to what the installed CLI actually has. */
export function codexCapabilitySet(probe: CodexProbe): RunnerCapabilitySet {
  if (!probe.found) return capabilitySet([]);
  const set: RunnerCapabilitySet = { ...CODEX_DECLARED_CAPABILITIES };
  const execReady = probeAvailable(probe, 'non-interactive') && probeAvailable(probe, 'json-events');
  const readOnlySandbox = probeAvailable(probe, 'sandbox-read-only');
  const workspaceWrite = probeAvailable(probe, 'sandbox-workspace-write');
  set.stageGeneration = execReady && readOnlySandbox;
  set.stageRefinement = set.stageGeneration;
  set.sandbox = readOnlySandbox;
  set.taskExecution = execReady && workspaceWrite;
  set.taskResume = set.taskExecution && probeAvailable(probe, 'resume');
  set.structuredFinalOutput = execReady;
  set.streamingEvents = execReady;
  set.supportsJsonSchema = probeAvailable(probe, 'output-schema');
  return set;
}
