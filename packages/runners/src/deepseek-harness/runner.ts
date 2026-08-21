import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { DeepSeekHarnessProfileConfig, ExecutionOutcome, TaskRunnerReport } from '@specbridge/core';
import { deepseekHarnessProfileSchema, taskRunnerReportSchema } from '@specbridge/core';
import type {
  AgentRunner,
  ProcessObservation,
  RunnerDetectionContext,
  RunnerDetectionResult,
  RunnerExecutionOptions,
  RunnerModelListResult,
  RunnerSelfTestResult,
  RunnerToolPolicy,
  StageGenerationInput,
  StageGenerationResult,
  TaskExecutionInput,
  TaskExecutionResult,
  TaskResumeInput,
} from '../contract.js';
import type { RunnerCapabilitySet, RunnerSupportLevel } from '../contracts/capabilities.js';
import { effectiveSupportLevel } from '../contracts/capabilities.js';
import type { RunnerContextCapabilities } from '../contracts/context.js';
import { RUNNER_CONTEXT_CAPABILITIES_SCHEMA_VERSION } from '../contracts/context.js';
import type { NormalizedRunnerError } from '../contracts/errors.js';
import { runnerError } from '../contracts/errors.js';
import type { NormalizedRunnerEvent } from '../contracts/events.js';
import { normalizedRunnerEventSchema } from '../contracts/events.js';
import type { RunnerUsage } from '../contracts/usage.js';
import { unavailableCost } from '../contracts/usage.js';
import {
  DSH_RUNTIME_SERVER_NAME,
  DSH_SDK_TESTED_VERSION,
  DshSdkAdapter,
  dshFailureOf,
} from './sdk-adapter.js';
import type { DshHandshake, DshNotification, DshRunObservation } from './sdk-adapter.js';
import {
  buildDshEnvironment,
  dshCapabilitySet,
  dshConfigurationGaps,
  probeDeepSeekHarness,
} from './detection.js';
import type { DshProbe } from './detection.js';
import { classifyDshFailure } from './errors.js';
import {
  collectDshRun,
  normalizeDshEvents,
  parseDshNotification,
  redactDshNotificationsForRetention,
} from './events.js';
import type { DshRunCollection } from './events.js';

/**
 * DeepSeek Harness runner (vNext.3) — PREVIEW.
 *
 * Drives a DeepSeek Harness runtime as a disposable out-of-process execution
 * engine behind the frozen AgentRunner contract:
 *
 *   SpecBridge Job/Task/Attempt/Checkpoint  =  canonical engineering state
 *   DSH process/session/context/logs        =  disposable working state
 *
 * Everything DSH reports is a CLAIM. Completion authority stays with the
 * existing SpecBridge Git/evidence pipeline; killing the runtime, deleting
 * its sessions, or replacing its version must never lose a Task.
 *
 * Safety posture (documented, tested, and the reason this adapter is
 * `preview` and never auto-selected):
 *   - the public SDK exposes NO sandbox/tool-restriction configuration —
 *     the launched runtime profile (`cordis.yml`) owns its tools, so task
 *     execution FAILS CLOSED until the operator attests the profile's
 *     workspace write boundary (and SpecBridge still verifies protected
 *     paths and evidence after every run);
 *   - the wire has NO mid-turn cancel: cancellation and timeouts close the
 *     runtime through the SDK's bounded teardown ladder;
 *   - stage generation is unsupported (no enforceable read-only boundary);
 *   - resume is attested, then VERIFIED: a "resumed" session whose log
 *     starts at seq 0 was silently recreated empty, and the run is stopped
 *     as session_unavailable before any agentic work.
 */
export class DeepSeekHarnessRunner implements AgentRunner {
  readonly name = 'deepseek-harness';
  readonly kind = 'deepseek-harness';
  readonly category = 'agent-cli';
  /** Profile-aware declaration: attestation gates downgrade it at construction. */
  readonly declaredCapabilities: RunnerCapabilitySet;
  /** Developer-preview integration: explicit selection only, never automatic. */
  readonly declaredSupportLevel: RunnerSupportLevel = 'preview';
  /**
   * vNext.1 context capabilities. The window is never guessed. Native
   * compaction is declared 'none' — the public SDK cannot verify whether
   * the launched runtime profile composes compaction plugins, so SpecBridge
   * relies on nothing: observed `compaction/*` events are normalized as
   * working-memory observations, and the ContextLifecycleManager stays the
   * canonical context authority either way.
   */
  readonly declaredContextCapabilities: RunnerContextCapabilities;
  private readonly config: DeepSeekHarnessProfileConfig;
  private probePromise: Promise<DshProbe> | undefined;

  constructor(config?: Partial<DeepSeekHarnessProfileConfig>) {
    this.config = deepseekHarnessProfileSchema.parse({
      runner: 'deepseek-harness',
      ...(config ?? {}),
    });
    this.declaredCapabilities = dshCapabilitySet(this.config);
    this.declaredContextCapabilities = {
      schemaVersion: RUNNER_CONTEXT_CAPABILITIES_SCHEMA_VERSION,
      contextWindowTokens: null,
      nativeCompaction: 'none',
      supportsSessionPersistence: this.config.sessionPersistence === 'runtime-managed',
    };
  }

  /** Probe once per runner instance; detection is read-only. */
  private probe(options?: {
    probeCapabilities?: boolean | undefined;
    timeoutMs?: number | undefined;
    workspaceRoot?: string | undefined;
  }): Promise<DshProbe> {
    this.probePromise ??= probeDeepSeekHarness(this.config, {
      probeCapabilities: options?.probeCapabilities,
      timeoutMs: options?.timeoutMs,
      workspaceRoot: options?.workspaceRoot,
    });
    return this.probePromise;
  }

  async detect(context: RunnerDetectionContext): Promise<RunnerDetectionResult> {
    if (!this.config.enabled) {
      return {
        runner: this.name,
        kind: this.kind,
        status: 'misconfigured',
        executable: this.config.command.executable,
        authentication: 'unknown',
        capabilities: [],
        diagnostics: [
          {
            severity: 'error',
            code: 'RUNNER_DISABLED',
            message:
              'This DeepSeek Harness profile is disabled in .specbridge/config.json ' +
              '(enabled = false). DSH is preview, disabled by default, and never selected ' +
              'automatically; enable and select it explicitly to use it.',
          },
        ],
        category: this.category,
        capabilitySet: this.declaredCapabilities,
        supportLevel: effectiveSupportLevel(this.declaredSupportLevel, 'misconfigured'),
        networkBacked: false,
      };
    }
    const probe = await this.probe({
      probeCapabilities: context.probeCapabilities === true,
      timeoutMs: context.timeoutMs,
      workspaceRoot: context.workspaceRoot,
    });
    return {
      runner: this.name,
      kind: this.kind,
      status: probe.status,
      executable: probe.executable,
      ...(probe.version !== undefined ? { version: probe.version } : {}),
      // No official read-only credential check exists; never guessed.
      authentication: 'unknown',
      capabilities: probe.capabilities,
      diagnostics: probe.diagnostics,
      category: this.category,
      capabilitySet: dshCapabilitySet(this.config),
      supportLevel: effectiveSupportLevel(this.declaredSupportLevel, probe.status),
      // The runtime process is local; its provider connectivity is its own.
      networkBacked: false,
    };
  }

  executionBoundaryNote(policy: RunnerToolPolicy): string {
    if (policy !== 'implementation') {
      return 'Authoring through DeepSeek Harness is unsupported: the public SDK cannot enforce a read-only boundary.';
    }
    return this.config.workspaceBoundary === 'runtime-profile'
      ? 'Execution boundary: the launched DSH runtime profile confines writes to the workspace (operator-attested); SpecBridge protected paths and evidence are verified independently after the run. Permission bypasses are never used.'
      : 'Execution boundary: UNCONFIRMED — task execution fails closed until the runtime profile boundary is attested.';
  }

  listModels(_context: RunnerDetectionContext): Promise<RunnerModelListResult> {
    return Promise.resolve({
      supported: false,
      models: [],
      detail:
        'The DSH SDK protocol has no model-listing request; the runtime mounts whatever routes ' +
        'its profile composes. Configure provider/model on the profile explicitly.',
    });
  }

  /**
   * Stage generation is deliberately unsupported in vNext.3 (§capability
   * scope): the tested public DSH surface cannot guarantee a read-only
   * execution boundary, so SpecBridge refuses before any model invocation
   * instead of pretending support.
   */
  generateStage(
    _input: StageGenerationInput,
    _execution: RunnerExecutionOptions,
  ): Promise<StageGenerationResult> {
    return Promise.resolve({
      runner: this.name,
      outcome: 'failed',
      failureReason:
        'the deepseek-harness runner does not support stage generation: the public DSH SDK ' +
        'cannot enforce a read-only boundary, so authoring is refused before any model call',
      rawStdout: '',
      rawStderr: '',
      durationMs: 0,
      warnings: [],
      error: runnerError({
        code: 'unsupported_operation',
        message: 'DeepSeek Harness profiles execute implementation tasks only.',
        remediation: ['Use claude-code, codex, gemini, or a model-API profile for authoring.'],
      }),
    });
  }

  async executeTask(
    input: TaskExecutionInput,
    execution: RunnerExecutionOptions,
  ): Promise<TaskExecutionResult> {
    return this.runTask(input.prompt, execution, {
      sessionId: input.sessionId ?? randomUUID(),
      resume: false,
    });
  }

  async resumeTask(
    input: TaskResumeInput,
    execution: RunnerExecutionOptions,
  ): Promise<TaskExecutionResult> {
    if (this.config.sessionPersistence !== 'runtime-managed') {
      return {
        runner: this.name,
        outcome: 'failed',
        failureReason:
          'this profile attests no session persistence (sessionPersistence = "none"); resume is ' +
          'unavailable — continue from the SpecBridge checkpoint with a fresh attempt',
        rawStdout: '',
        rawStderr: '',
        durationMs: 0,
        warnings: [],
        resumeSupported: false,
        error: runnerError({
          code: 'unsupported_operation',
          message: 'Session resume requires sessionPersistence = "runtime-managed" on the profile.',
          remediation: [
            'Start a fresh attempt from the latest SpecBridge checkpoint (always available).',
          ],
        }),
      };
    }
    return this.runTask(input.prompt, execution, { sessionId: input.sessionId, resume: true });
  }

  private preflightFailure(started: number): (TaskExecutionResult & { error: NormalizedRunnerError }) | undefined {
    const fail = (
      error: NormalizedRunnerError,
      failureReason: string,
    ): TaskExecutionResult & { error: NormalizedRunnerError } => ({
      runner: this.name,
      outcome: 'failed',
      failureReason,
      rawStdout: '',
      rawStderr: '',
      durationMs: Math.max(0, Date.now() - started),
      warnings: [],
      resumeSupported: false,
      error,
    });
    if (!this.config.enabled) {
      return fail(
        runnerError({
          code: 'runner_disabled',
          message: 'This DeepSeek Harness profile is disabled.',
          remediation: ['Enable it explicitly in .specbridge/config.json (never implicit).'],
        }),
        'the deepseek-harness profile is disabled',
      );
    }
    const gaps = dshConfigurationGaps(this.config);
    if (gaps.length > 0) {
      return fail(
        runnerError({
          code: 'invalid_configuration',
          message: `The DeepSeek Harness profile is incomplete: ${gaps.join('; ')}.`,
          remediation: ['Set provider and model on the profile; SpecBridge never guesses routes.'],
        }),
        'the deepseek-harness profile is incomplete (provider/model)',
      );
    }
    if (this.config.workspaceBoundary !== 'runtime-profile') {
      // Fail closed: the public SDK cannot impose a sandbox, so an
      // unattested runtime profile never executes agentic work.
      return fail(
        runnerError({
          code: 'sandbox_unavailable',
          message:
            'Task execution is unavailable: the DSH runtime profile\'s workspace write boundary ' +
            'is unconfirmed, and the public SDK exposes no sandbox configuration to impose one.',
          remediation: [
            'Configure a runtime profile that confines writes to the workspace, then set workspaceBoundary = "runtime-profile" to attest it.',
          ],
        }),
        'the DSH workspace boundary is unconfirmed; execution fails closed',
      );
    }
    return undefined;
  }

  private async runTask(
    prompt: string,
    execution: RunnerExecutionOptions,
    session: { sessionId: string; resume: boolean },
  ): Promise<TaskExecutionResult> {
    const started = Date.now();
    const preflight = this.preflightFailure(started);
    if (preflight !== undefined) return preflight;

    const warnings: string[] = [];
    if (execution.maxTurns !== undefined) {
      warnings.push('maxTurns is not supported by the DSH runtime and was ignored');
    }
    if (execution.maxBudgetUsd !== undefined) {
      warnings.push('maxBudgetUsd is not supported by the DSH runtime and was ignored');
    }
    const model = execution.model ?? (this.config.model as string);
    const adapter = new DshSdkAdapter({
      command: this.config.command.executable,
      args: this.config.command.args,
      workspaceRoot: execution.workspaceRoot,
      env: buildDshEnvironment(this.config),
      provider: this.config.provider as string,
      model,
      ...(this.config.maxTokens !== null ? { maxTokens: this.config.maxTokens } : {}),
      requestTimeoutMs: this.config.handshakeTimeoutMs,
    });

    if (execution.signal?.aborted === true) {
      return this.failureResult(started, session, warnings, undefined, [], {
        kind: 'closed-by-adapter',
        message: 'cancelled before launch',
        closeCause: 'cancelled',
      });
    }

    const timeoutMs = Math.min(execution.timeoutMs, this.config.timeoutMs);
    const watchdog = setTimeout(() => {
      void adapter.close('timed-out');
    }, timeoutMs);
    const onAbort = (): void => {
      void adapter.close('cancelled');
    };
    execution.signal?.addEventListener('abort', onAbort, { once: true });

    let handshake: DshHandshake | undefined;
    let observation: DshRunObservation | undefined;
    let failure: ReturnType<typeof dshFailureOf> | undefined;
    // Resume continuity guard: the first observed root-session event of a
    // GENUINE resume continues the restored log (seq > 0). Seq 0 means the
    // runtime silently created the session empty — stop before any work.
    let continuityChecked = false;
    const onNotification = (notification: DshNotification): void => {
      if (!session.resume || continuityChecked) return;
      const parsed = parseDshNotification(notification);
      if (parsed.method !== 'session.event' || parsed.sessionId !== session.sessionId) return;
      if (parsed.event === undefined) return;
      continuityChecked = true;
      if (parsed.event.seq === 0) {
        void adapter.close('session-unavailable');
      }
    };
    try {
      handshake = await adapter.open();
      observation = await adapter.runPrompt({
        sessionId: session.sessionId,
        prompt,
        onNotification,
      });
    } catch (error) {
      failure = dshFailureOf(error);
    } finally {
      clearTimeout(watchdog);
      execution.signal?.removeEventListener('abort', onAbort);
      // Bounded, idempotent teardown — no orphaned runtimes, ever.
      await adapter.close();
    }

    const notifications = observation?.notifications ?? adapter.partialObservation.notifications;
    const dropped = observation?.droppedNotifications ?? adapter.partialObservation.droppedNotifications;
    if (dropped > 0) {
      warnings.push(`the notification stream exceeded the retention cap; ${dropped} notifications were dropped`);
    }

    if (failure !== undefined) {
      return this.failureResult(started, session, warnings, handshake, notifications, failure);
    }
    return this.successResult(
      started,
      session,
      warnings,
      handshake as DshHandshake,
      observation as DshRunObservation,
    );
  }

  private observationRecord(
    started: number,
    notifications: readonly DshNotification[],
    flags: { timedOut: boolean; cancelled: boolean; truncated: boolean },
  ): ProcessObservation {
    const retained = redactDshNotificationsForRetention(notifications, this.config.maxNotificationBytes);
    return {
      executable: this.config.command.executable,
      redactedArgv: [this.config.command.executable, ...this.config.command.args],
      startedAt: new Date(started).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - started),
      // The SDK owns the child's stdio; exit codes surface only through
      // transport errors, so none is recorded rather than guessed.
      exitCode: undefined,
      signal: undefined,
      timedOut: flags.timedOut,
      cancelled: flags.cancelled,
      stdoutBytes: Buffer.byteLength(retained, 'utf8'),
      stderrBytes: 0,
      stdoutTruncated: flags.truncated,
      stderrTruncated: false,
    };
  }

  private baseResult(
    started: number,
    session: { sessionId: string; resume: boolean },
    warnings: string[],
    handshake: DshHandshake | undefined,
    notifications: readonly DshNotification[],
    collection: DshRunCollection,
    flags: { timedOut: boolean; cancelled: boolean },
  ): Omit<TaskExecutionResult, 'outcome' | 'resumeSupported'> {
    const normalizedEvents: NormalizedRunnerEvent[] = [
      normalizedRunnerEventSchema.parse({
        type: 'runner.started',
        timestamp: new Date(started).toISOString(),
        runner: this.name,
        profile: this.name,
        runId: 'pending',
        attemptId: 'pending',
        providerSessionId: session.sessionId,
        providerEventType: 'specbridge:launch',
        payload: {
          sdkVersion: DSH_SDK_TESTED_VERSION,
          runtime: DSH_RUNTIME_SERVER_NAME,
          runtimeVersion: handshake?.serverVersion ?? null,
          resume: session.resume,
        },
      }),
      ...normalizeDshEvents(
        notifications,
        session.sessionId,
        { runner: this.name, profile: this.name, runId: 'pending', attemptId: 'pending', providerSessionId: session.sessionId },
        () => new Date().toISOString(),
      ),
    ];
    if (collection.unparseableEvents > 0) {
      warnings.push(`${collection.unparseableEvents} session events did not match the known envelope and were skipped`);
    }
    if (collection.sawMaxTokens) {
      warnings.push('at least one runtime step reached its output-token ceiling (max-tokens)');
    }
    const usage: RunnerUsage | undefined =
      collection.usage !== undefined
        ? {
            model: collection.effectiveModel ?? this.config.model,
            inputTokens: collection.usage.inputTokens,
            cachedInputTokens: collection.usage.cachedInputTokens,
            outputTokens: collection.usage.outputTokens,
            reasoningTokens: collection.usage.reasoningTokens,
            requestCount: collection.usage.requestCount,
            durationMs: Math.max(0, Date.now() - started),
          }
        : undefined;
    return {
      runner: this.name,
      // The retained "stdout" is the redacted notification log — the only
      // form in which raw DSH output is kept (reasoning already stripped).
      rawStdout: redactDshNotificationsForRetention(notifications, this.config.maxNotificationBytes),
      rawStderr: '',
      process: this.observationRecord(started, notifications, {
        ...flags,
        truncated: warnings.some((warning) => warning.includes('retention cap')),
      }),
      sessionId: session.sessionId,
      durationMs: Math.max(0, Date.now() - started),
      warnings,
      normalizedEvents,
      ...(usage !== undefined ? { usage } : {}),
      cost: unavailableCost(),
    };
  }

  private failureResult(
    started: number,
    session: { sessionId: string; resume: boolean },
    warnings: string[],
    handshake: DshHandshake | undefined,
    notifications: readonly DshNotification[],
    failure: ReturnType<typeof dshFailureOf>,
  ): TaskExecutionResult {
    const collection = collectDshRun(notifications, session.sessionId);
    const classified = classifyDshFailure(failure, collection.errors);
    const flags = {
      timedOut: failure.closeCause === 'timed-out',
      cancelled: failure.closeCause === 'cancelled',
    };
    const base = this.baseResult(started, session, warnings, handshake, notifications, collection, flags);
    return {
      ...base,
      outcome: classified.outcome,
      failureReason: classified.error.message,
      error: classified.error,
      // A dead/lost/cancelled run is not resumable as-is; continuation goes
      // through the SpecBridge checkpoint (fresh attempt), or a genuine
      // session resume decided by orchestration on the NEXT attempt.
      resumeSupported: false,
    };
  }

  private successResult(
    started: number,
    session: { sessionId: string; resume: boolean },
    warnings: string[],
    handshake: DshHandshake,
    observation: DshRunObservation,
  ): TaskExecutionResult {
    const collection = collectDshRun(observation.notifications, session.sessionId);
    const base = this.baseResult(started, session, warnings, handshake, observation.notifications, collection, {
      timedOut: false,
      cancelled: false,
    });
    const resumeSupported = this.config.sessionPersistence === 'runtime-managed';

    // Strict structured final result: the complete final assistant message
    // must be a bare JSON document matching the task report schema. JSON is
    // never extracted from surrounding prose and malformed output is never
    // repaired (§structured-output policy).
    const finalText = observation.finalResponse.trim();
    if (finalText.length === 0) {
      return {
        ...base,
        outcome: 'malformed-output',
        failureReason:
          collection.errors.length > 0
            ? `the runtime reported: ${collection.errors[0]}`
            : 'the run produced no final assistant message',
        error: runnerError({
          code: 'structured_output_invalid',
          message: 'The DSH run produced no final structured result.',
          remediation: ['Inspect the retained notification log in the run directory.'],
        }),
        resumeSupported,
      };
    }
    const parsed = strictJsonParse(finalText);
    if (parsed === undefined) {
      return {
        ...base,
        outcome: 'malformed-output',
        failureReason: 'the final assistant message is not a bare JSON document (extra prose is not accepted)',
        error: runnerError({
          code: 'structured_output_invalid',
          message: 'The final DSH message did not parse as a JSON document.',
        }),
        resumeSupported,
      };
    }
    const validated = taskRunnerReportSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        ...base,
        outcome: 'malformed-output',
        failureReason: `structured result does not match the report schema: ${validated.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')}`,
        error: runnerError({
          code: 'structured_output_invalid',
          message: 'The final DSH message did not match the required report schema.',
        }),
        resumeSupported,
      };
    }
    const report = validated.data as TaskRunnerReport;
    const outcome: ExecutionOutcome = report.outcome;
    return {
      ...base,
      outcome,
      report,
      ...(outcome === 'completed' || outcome === 'no-change'
        ? {}
        : { failureReason: `the agent reported "${outcome}"` }),
      resumeSupported,
    };
  }

  /** Minimal bounded self test (`runner test deepseek-harness --network`). */
  async selfTest(execution: RunnerExecutionOptions): Promise<RunnerSelfTestResult> {
    const preflight = this.preflightFailure(Date.now());
    if (preflight !== undefined) {
      return { ok: false, detail: preflight.failureReason ?? 'the profile cannot execute' };
    }
    const result = await this.runTask(
      'This is a connectivity self test. Do not read or modify any file and do not run any command. ' +
        'Reply with exactly one JSON document: {"schemaVersion":"1.0.0","outcome":"no-change",' +
        '"summary":"self test"} and nothing else.',
      { ...execution, timeoutMs: Math.min(execution.timeoutMs, 120_000) },
      { sessionId: randomUUID(), resume: false },
    );
    return {
      ok: result.outcome === 'no-change' || result.outcome === 'completed',
      detail:
        result.outcome === 'no-change' || result.outcome === 'completed'
          ? 'structured output validated'
          : (result.failureReason ?? `self test failed (${result.outcome})`),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
      ...(result.process !== undefined ? { process: result.process } : {}),
    };
  }
}

function strictJsonParse(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
