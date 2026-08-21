import type { DeepSeekHarnessProfileConfig, Diagnostic, RunnerStatus } from '@specbridge/core';
import type { RunnerCapability } from '../contract.js';
import type { RunnerCapabilitySet } from '../contracts/capabilities.js';
import { capabilitySet } from '../contracts/capabilities.js';
import { resolveExecutable } from '../safe-process.js';
import { DSH_RUNTIME_SERVER_NAME, DSH_SDK_TESTED_VERSION, DshSdkAdapter, dshFailureOf } from './sdk-adapter.js';
import { verifyDshComputeLocality } from './locality.js';

/**
 * DeepSeek Harness detection: read-only, never a model turn.
 *
 * Cheap detection (runner list) verifies only static facts: the configured
 * launch command resolves and the profile is complete enough to execute.
 * Doctor-level detection (`probeCapabilities`) additionally spawns the
 * runtime once, performs the `initialize` handshake, verifies the
 * wire-stable server identity, records the runtime version, and shuts the
 * process down — no session, no prompt, no inference.
 *
 * Authentication is always `unknown`: the tested public SDK exposes no
 * read-only way to check the runtime's provider credentials, and SpecBridge
 * never guesses (and never reads credential stores).
 */

/**
 * Capabilities this adapter implements when the provider is fully
 * available. Detection only DOWNGRADES:
 *   - `sandbox` requires the profile's workspace-boundary attestation;
 *   - `taskResume` requires the session-persistence attestation.
 * Stage generation/refinement are deliberately ABSENT: the public DSH SDK
 * has no way to force a read-only execution boundary per run (the runtime
 * profile owns its tools), so authoring through DSH would pretend a safety
 * property SpecBridge cannot enforce. Task execution and resume are the
 * vNext.3 scope.
 */
export const DSH_DECLARED_CAPABILITIES: RunnerCapabilitySet = capabilitySet([
  'taskExecution',
  'taskResume',
  'structuredFinalOutput',
  'streamingEvents',
  'repositoryRead',
  'repositoryWrite',
  'sandbox',
  'usageReporting',
  'supportsCancellation',
]);

/** Minimal safe child-environment base (names only; values read at spawn). */
export const DSH_BASE_ENVIRONMENT_NAMES = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'COMSPEC',
  'WINDIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'LANG',
  'LC_ALL',
  'SHELL',
  'TERM',
] as const;

/**
 * Build the COMPLETE child environment for the runtime process: the minimal
 * safe base plus the profile's explicit passthrough names. The SDK replaces
 * the child environment with exactly this record, so parent credentials and
 * secrets are never inherited implicitly.
 */
export function buildDshEnvironment(config: DeepSeekHarnessProfileConfig): Record<string, string> {
  const env: Record<string, string> = {};
  const names = new Set<string>([...DSH_BASE_ENVIRONMENT_NAMES, ...config.environmentPassthrough]);
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export interface DshProbe {
  status: RunnerStatus;
  executable: string;
  resolvedExecutable?: string | undefined;
  version?: string | undefined;
  capabilities: RunnerCapability[];
  diagnostics: Diagnostic[];
  /** Set when the handshake probe ran and verified the server identity. */
  handshakeVerified: boolean;
}

export interface ProbeDshOptions {
  /** Spawn the runtime once for the initialize handshake (runner doctor). */
  probeCapabilities?: boolean | undefined;
  timeoutMs?: number | undefined;
  workspaceRoot?: string | undefined;
  /**
   * vNext.4: whether the SpecBridge-managed local model server is enabled
   * and coherent, which is the evidence behind a `managed-local-model`
   * locality attestation. Absent means the caller did not resolve it; the
   * locality row then reports what the profile alone proves.
   */
  managedLocalModelAvailable?: boolean | undefined;
}

/** Configuration gaps that block execution (empty when complete). */
export function dshConfigurationGaps(config: DeepSeekHarnessProfileConfig): string[] {
  const gaps: string[] = [];
  if (config.provider === null) {
    gaps.push('provider is not set — the initialize handshake requires an explicit provider route');
  }
  if (config.model === null) {
    gaps.push('model is not set — the initialize handshake requires an explicit model (never guessed)');
  }
  return gaps;
}

export async function probeDeepSeekHarness(
  config: DeepSeekHarnessProfileConfig,
  options: ProbeDshOptions = {},
): Promise<DshProbe> {
  const diagnostics: Diagnostic[] = [];
  const capabilities: RunnerCapability[] = [];
  const executable = config.command.executable;
  const cwd = options.workspaceRoot ?? process.cwd();

  capabilities.push({
    id: 'sdk-pin',
    label: 'Official DSH SDK (exact pin)',
    available: true,
    required: true,
    detail: `@deepseek-ai/dsh-sdk-client ${DSH_SDK_TESTED_VERSION} (developer preview)`,
  });

  const resolved = resolveExecutable(executable, cwd);
  capabilities.push({
    id: 'runtime-command',
    label: 'Configured runtime command resolves',
    available: resolved !== undefined,
    required: true,
    detail: resolved ?? `"${executable}" was not found (the launch spec is explicit; no global command is assumed)`,
  });
  if (resolved === undefined) {
    diagnostics.push({
      severity: 'error',
      code: 'RUNNER_EXECUTABLE_NOT_FOUND',
      message:
        `The DeepSeek Harness runtime command "${executable}" was not found. Configure ` +
        'runnerProfiles.<profile>.command with the actual runtime launch spec ' +
        '(e.g. node + the dsh-jsonrpc-agent entry point and its cordis.yml).',
    });
  }

  const gaps = dshConfigurationGaps(config);
  for (const gap of gaps) {
    diagnostics.push({ severity: 'error', code: 'RUNNER_PROFILE_INCOMPLETE', message: gap });
  }

  const boundaryAttested = config.workspaceBoundary === 'runtime-profile';
  capabilities.push({
    id: 'workspace-boundary',
    label: 'Workspace write boundary (runtime-profile attestation)',
    available: boundaryAttested,
    required: false,
    detail: boundaryAttested
      ? 'the operator attests the launched runtime profile confines writes to the workspace; SpecBridge additionally verifies protected paths and evidence after every run'
      : 'unconfirmed — task execution FAILS CLOSED until workspaceBoundary is set to "runtime-profile" for a runtime profile that confines writes',
  });
  if (!boundaryAttested) {
    diagnostics.push({
      severity: 'warning',
      code: 'RUNNER_BOUNDARY_UNCONFIRMED',
      message:
        'workspaceBoundary is "unconfirmed": the public DSH SDK cannot impose a sandbox, so task ' +
        'execution is unavailable until the operator attests the runtime profile\'s write boundary.',
    });
  }

  const resumeAttested = config.sessionPersistence === 'runtime-managed';
  capabilities.push({
    id: 'resume',
    label: 'Session resume (runtime-managed persistence attestation)',
    available: resumeAttested,
    required: false,
    detail: resumeAttested
      ? 'sessions are attested to persist across runtime processes; every resume is additionally verified by session-log seq continuity before any agentic work'
      : 'sessionPersistence is "none": interrupted tasks continue from the SpecBridge checkpoint with a fresh session (always available)',
  });

  // vNext.4: economic locality of the COMPUTE behind this profile. Reported
  // in detection because "which lane may use this runner" is an operator
  // question, and because a profile that attests loopback while pointing at
  // a public host is a misconfiguration worth seeing before a job runs.
  const locality = verifyDshComputeLocality({
    config,
    ...(options.managedLocalModelAvailable !== undefined
      ? { managedLocalModelAvailable: options.managedLocalModelAvailable }
      : {}),
  });
  capabilities.push({
    id: 'compute-locality',
    label: 'Verified compute locality (LOCAL economic lane eligibility)',
    available: locality.locality === 'LOCAL',
    required: false,
    detail: `${locality.locality} — ${locality.evidence}`,
  });
  if (locality.rejections.includes('endpoint-remote')) {
    diagnostics.push({
      severity: 'warning',
      code: 'RUNNER_COMPUTE_REMOTE',
      message:
        'This DeepSeek Harness profile runs REMOTE compute: it is usable by explicit selection, ' +
        'but the LOCAL economic lane refuses it (a LOCAL attempt must never bill a provider).',
    });
  }
  if (locality.credentialRisks.length > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'RUNNER_CREDENTIAL_PASSTHROUGH',
      message:
        `environmentPassthrough forwards credential-shaped variable NAMES (${locality.credentialRisks.join(', ')}) ` +
        'to the runtime; a LOCAL-bound harness should not inherit paid-provider credentials.',
    });
  }

  capabilities.push({
    id: 'structured-output',
    label: 'Strict validated final message (JSON only, no prose)',
    available: true,
    required: true,
    detail: 'the final assistant message must be a bare JSON document matching the report schema',
  });

  let version: string | undefined;
  let handshakeVerified = false;
  let status: RunnerStatus;
  if (resolved === undefined) {
    status = 'unavailable';
  } else if (gaps.length > 0) {
    status = 'misconfigured';
  } else if (options.probeCapabilities === true) {
    const adapter = new DshSdkAdapter({
      command: config.command.executable,
      args: config.command.args,
      workspaceRoot: cwd,
      env: buildDshEnvironment(config),
      provider: config.provider as string,
      model: config.model as string,
      ...(config.maxTokens !== null ? { maxTokens: config.maxTokens } : {}),
      requestTimeoutMs: options.timeoutMs ?? config.handshakeTimeoutMs,
    });
    try {
      const handshake = await adapter.open();
      version = handshake.serverVersion;
      handshakeVerified = true;
      status = 'available';
      capabilities.push({
        id: 'protocol-handshake',
        label: 'Initialize handshake / server identity',
        available: true,
        required: true,
        detail: `${DSH_RUNTIME_SERVER_NAME} ${handshake.serverVersion}`,
      });
    } catch (error) {
      const failure = dshFailureOf(error);
      const incompatible = failure.kind === 'identity-mismatch' || failure.kind === 'protocol-violation';
      status = incompatible ? 'incompatible' : failure.kind === 'launch' ? 'unavailable' : 'error';
      capabilities.push({
        id: 'protocol-handshake',
        label: 'Initialize handshake / server identity',
        available: false,
        required: true,
        detail: failure.message,
      });
      diagnostics.push({
        severity: 'error',
        code: incompatible ? 'RUNNER_INCOMPATIBLE_RUNTIME' : 'RUNNER_HANDSHAKE_FAILED',
        message: `The initialize handshake failed: ${failure.message}`,
      });
    } finally {
      await adapter.close();
    }
  } else {
    status = 'available';
    capabilities.push({
      id: 'protocol-handshake',
      label: 'Initialize handshake / server identity',
      available: false,
      required: false,
      detail: 'not probed — run "runner doctor" to spawn the runtime once (read-only; no model turn)',
    });
  }

  return {
    status,
    executable,
    resolvedExecutable: resolved,
    version,
    capabilities,
    diagnostics,
    handshakeVerified,
  };
}

/**
 * Detected capability set: the declaration downgraded by the profile's
 * attestations. Detection never ADDS a capability. Resume additionally
 * requires the workspace boundary: a session that cannot safely EXECUTE
 * cannot be resumed either.
 */
export function dshCapabilitySet(config: DeepSeekHarnessProfileConfig): RunnerCapabilitySet {
  const boundaryAttested = config.workspaceBoundary === 'runtime-profile';
  return {
    ...DSH_DECLARED_CAPABILITIES,
    sandbox: boundaryAttested,
    taskResume: boundaryAttested && config.sessionPersistence === 'runtime-managed',
  };
}
