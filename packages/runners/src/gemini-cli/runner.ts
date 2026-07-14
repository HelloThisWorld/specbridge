import type {
  ExecutionOutcome,
  GeminiProfileConfig,
  StageRunnerReport,
  TaskRunnerReport,
} from '@specbridge/core';
import {
  geminiProfileSchema,
  stageRunnerReportSchema,
  taskRunnerReportSchema,
} from '@specbridge/core';
import type {
  AgentRunner,
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
import { effectiveSupportLevel } from '../contracts/capabilities.js';
import type { NormalizedRunnerError } from '../contracts/errors.js';
import { runnerError } from '../contracts/errors.js';
import type { NormalizedRunnerEvent } from '../contracts/events.js';
import type { RunnerUsage } from '../contracts/usage.js';
import type { SafeProcessResult } from '../safe-process.js';
import type { GeminiProbe } from './detection.js';
import { GEMINI_DECLARED_CAPABILITIES, geminiCapabilitySet, probeGemini } from './detection.js';
import type { GeminiInvocationPlan } from './invocation.js';
import {
  buildGeminiInvocation,
  isExplicitGeminiSessionId,
  runGeminiInvocation,
} from './invocation.js';
import type { GeminiEventStream } from './events.js';
import {
  geminiJsonEnvelopeSchema,
  normalizeGeminiEvents,
  parseGeminiEventStream,
  redactGeminiStdoutForRetention,
} from './events.js';

/**
 * Gemini CLI runner (v0.6.1): invokes the locally installed `gemini` CLI in
 * headless mode with machine-readable output.
 *
 * The local user installs and authenticates the Gemini CLI independently.
 * SpecBridge only spawns the configured executable — it never collects,
 * stores, proxies, or prints credentials, never reads Google credential
 * files, never triggers an interactive login, never trusts a folder, and
 * never uses YOLO or any other unrestricted approval mode (enforced at
 * three layers: config schema, argv assembly, pre-spawn assertion).
 *
 * Boundaries:
 *   - stage generation / refinement: plan approval mode plus a read-only
 *     tool allowlist where supported (repository inspection only)
 *   - task execution / resume: auto_edit approval mode with a bounded tool
 *     set that excludes every shell-execution tool
 *   - provider-reported file changes and completion claims are CLAIMS;
 *     evidence comes from SpecBridge's own Git snapshots and trusted
 *     verification commands
 */

interface GeminiMappedResult {
  runner: string;
  outcome: ExecutionOutcome;
  failureReason?: string;
  rawStdout: string;
  rawStderr: string;
  process?: SafeProcessResult['observation'];
  sessionId?: string;
  durationMs: number;
  warnings: string[];
  normalizedEvents?: NormalizedRunnerEvent[];
  error?: NormalizedRunnerError;
  usage?: RunnerUsage;
  report?: StageRunnerReport | TaskRunnerReport;
  invalidStructuredOutput?: string;
}

/** Classify a nonzero-exit / stream failure into a normalized error. */
export function classifyGeminiFailure(
  stderr: string,
  streamErrors: string[],
): NormalizedRunnerError {
  const haystack = `${stderr}\n${streamErrors.join('\n')}`.toLowerCase();
  if (/please sign in|not logged in|login required|unauthorized|unauthenticated|401/.test(haystack)) {
    return runnerError({
      code: 'authentication_required',
      message: 'The Gemini CLI reported an authentication failure.',
      remediation: [
        'Authenticate the Gemini CLI yourself (SpecBridge never handles credentials and never starts a login flow).',
      ],
    });
  }
  if (/resource_exhausted|quota exceeded|out of quota|usage limit/.test(haystack)) {
    return runnerError({
      code: 'quota_exceeded',
      message: 'The provider reported an exhausted quota or usage limit.',
      remediation: ['Check your provider plan and usage, then retry explicitly.'],
    });
  }
  if (/rate limit|too many requests|429/.test(haystack)) {
    return runnerError({
      code: 'rate_limited',
      message: 'The provider reported a rate limit.',
      remediation: ['Wait and retry explicitly.'],
      providerCode: '429',
    });
  }
  if (/permission denied|approval (required|denied)|call rejected|not permitted/.test(haystack)) {
    return runnerError({
      code: 'permission_denied',
      message: 'The Gemini CLI reported a permission denial.',
      remediation: [
        'SpecBridge never bypasses approvals (and never uses YOLO); narrow the task so it needs only repository reads and file edits.',
      ],
    });
  }
  if (/network|connection|dns|econn|etimedout/.test(haystack)) {
    return runnerError({
      code: 'network_error',
      message: 'The Gemini CLI reported a network failure.',
      remediation: ['Check connectivity and retry explicitly.'],
    });
  }
  return runnerError({
    code: 'process_failed',
    message: 'The Gemini CLI exited with a failure.',
    remediation: ['Inspect the retained stderr and event log in the run directory.'],
  });
}

const TASK_EXECUTION_REMEDIATION = [
  'Authoring may remain available through the read-only boundary.',
  'Use a claude-code or codex-cli profile for task execution ("specbridge runner list" shows compatible profiles).',
];

export class GeminiCliRunner implements AgentRunner {
  readonly name = 'gemini-cli';
  readonly kind = 'gemini-cli';
  readonly category = 'agent-cli';
  readonly declaredCapabilities = GEMINI_DECLARED_CAPABILITIES;
  /** Orchestration may perform ONE structured-output correction retry. */
  readonly supportsStructuredOutputCorrection = true;
  private readonly config: GeminiProfileConfig;
  private probePromise: Promise<GeminiProbe> | undefined;

  constructor(config?: Partial<GeminiProfileConfig>) {
    this.config = geminiProfileSchema.parse({ runner: 'gemini-cli', ...(config ?? {}) });
  }

  /** Probe once per runner instance; detection is read-only but not free. */
  private probe(timeoutMs?: number): Promise<GeminiProbe> {
    this.probePromise ??= probeGemini(
      this.config,
      timeoutMs !== undefined ? { timeoutMs } : undefined,
    );
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
              'This Gemini profile is disabled in .specbridge/config.json (enabled = false). ' +
              'Enable it explicitly to use the Gemini CLI.',
          },
        ],
        category: this.category,
        capabilitySet: this.declaredCapabilities,
        supportLevel: effectiveSupportLevel('production', 'misconfigured'),
        networkBacked: false,
      };
    }
    const probe = await this.probe(context.timeoutMs);
    return {
      runner: this.name,
      kind: this.kind,
      status: probe.status,
      executable: probe.executable,
      ...(probe.version !== undefined ? { version: probe.version } : {}),
      authentication: probe.authState,
      capabilities: probe.capabilities,
      diagnostics: probe.diagnostics,
      category: this.category,
      capabilitySet: geminiCapabilitySet(probe),
      supportLevel: effectiveSupportLevel('production', probe.status),
      // The Gemini CLI talks to its provider itself; SpecBridge's own
      // transport is a local child process.
      networkBacked: false,
    };
  }

  executionBoundaryNote(policy: RunnerToolPolicy): string {
    if (policy !== 'implementation') {
      return 'Gemini plan mode / read-only tool allowlist: repository inspection only; no file writes; YOLO is never used.';
    }
    return (
      `Gemini ${this.config.approvalModeForExecution} boundary: repository reads and file edits only; ` +
      'no arbitrary shell access; extensions disabled where supported; YOLO is never used.'
    );
  }

  listModels(_context: RunnerDetectionContext): Promise<RunnerModelListResult> {
    return Promise.resolve({
      supported: false,
      models: [],
      detail:
        'The Gemini CLI has no officially supported local model-listing command that avoids a model request; ' +
        'SpecBridge never guesses provider model names. Configure "model" on the profile explicitly.',
    });
  }

  async generateStage(
    input: StageGenerationInput,
    execution: RunnerExecutionOptions,
  ): Promise<StageGenerationResult> {
    const started = Date.now();
    const probe = await this.probe();
    const unavailable = this.unavailableResult(probe, started);
    if (unavailable !== undefined) {
      const { report: _report, ...rest } = unavailable;
      return rest;
    }
    const detected = geminiCapabilitySet(probe);
    if (!detected.stageGeneration) {
      const { report: _refusalReport, ...refusal } = this.capabilityRefusal(
        started,
        'authoring needs a proven read-only boundary (plan approval mode or a tool allowlist)',
        ['Update the Gemini CLI to a version with plan mode or --allowed-tools.'],
      );
      return refusal;
    }
    let prompt = input.prompt;
    if (input.correction !== undefined) {
      prompt =
        `${input.prompt}\n\n` +
        'Your previous response was not a valid structured result. ' +
        `Validation problems: ${input.correction.problems}. ` +
        'Return ONLY one corrected JSON document matching the required schema — no prose, no code fences.';
    }
    const plan = buildGeminiInvocation({
      config: this.config,
      probe,
      prompt,
      toolPolicy: input.toolPolicy,
      execution,
    });
    const processResult = await runGeminiInvocation(plan, this.config, execution);
    const mapped = this.mapResult(processResult, plan, started, 'stage');
    const { report, ...rest } = mapped;
    const stageReport = report as StageRunnerReport | undefined;
    return { ...rest, ...(stageReport !== undefined ? { report: stageReport } : {}) };
  }

  async executeTask(
    input: TaskExecutionInput,
    execution: RunnerExecutionOptions,
  ): Promise<TaskExecutionResult> {
    return this.runTask(input.prompt, execution, {});
  }

  async resumeTask(
    input: TaskResumeInput,
    execution: RunnerExecutionOptions,
  ): Promise<TaskExecutionResult> {
    if (!isExplicitGeminiSessionId(input.sessionId)) {
      return {
        runner: this.name,
        outcome: 'failed',
        failureReason: `"${input.sessionId}" is not an explicit Gemini session UUID; "latest", indexes, and ambiguous identifiers are never resumed`,
        rawStdout: '',
        rawStderr: '',
        durationMs: 0,
        warnings: [],
        resumeSupported: false,
        error: runnerError({
          code: 'unsupported_operation',
          message: 'Gemini resume requires the explicit session UUID captured from the original run.',
        }),
      };
    }
    return this.runTask(input.prompt, execution, { resumeSessionId: input.sessionId });
  }

  private async runTask(
    prompt: string,
    execution: RunnerExecutionOptions,
    session: { resumeSessionId?: string },
  ): Promise<TaskExecutionResult> {
    const started = Date.now();
    const probe = await this.probe();
    const unavailable = this.unavailableResult(probe, started);
    if (unavailable !== undefined) {
      const { report: _report, ...rest } = unavailable;
      return { ...rest, resumeSupported: false };
    }
    const detected = geminiCapabilitySet(probe);
    if (!detected.taskExecution) {
      const refusal = this.capabilityRefusal(
        started,
        'file edits cannot be permitted without also permitting arbitrary shell commands ' +
          '(needs the auto_edit approval mode plus a tool allowlist or sandbox); SpecBridge never relaxes ' +
          'this policy and never uses YOLO',
        TASK_EXECUTION_REMEDIATION,
      );
      const { report: _report, ...rest } = refusal;
      return { ...rest, resumeSupported: false };
    }
    if (session.resumeSessionId !== undefined && !detected.taskResume) {
      const refusal = this.capabilityRefusal(
        started,
        'this Gemini CLI version does not support explicit session resume; start a fresh attempt instead',
        ['Re-run the task without --resume; a new attempt is recorded append-only.'],
      );
      const { report: _report, ...rest } = refusal;
      return { ...rest, resumeSupported: false };
    }
    const plan = buildGeminiInvocation({
      config: this.config,
      probe,
      prompt,
      toolPolicy: 'implementation',
      ...(session.resumeSessionId !== undefined
        ? { resumeSessionId: session.resumeSessionId }
        : {}),
      execution,
    });
    const processResult = await runGeminiInvocation(plan, this.config, execution);
    const mapped = this.mapResult(processResult, plan, started, 'task');

    // Resume must continue the SAME session: a different reported identity is
    // a discrepancy, never silently accepted as a successful resume.
    if (
      session.resumeSessionId !== undefined &&
      mapped.sessionId !== undefined &&
      mapped.sessionId !== session.resumeSessionId
    ) {
      const { report: _report, ...rest } = mapped;
      return {
        ...rest,
        outcome: 'failed',
        failureReason:
          `the provider continued session ${mapped.sessionId} instead of the requested ` +
          `${session.resumeSessionId}; the resume is not claimed as successful`,
        error: runnerError({
          code: 'api_error',
          message: 'The Gemini session identity changed unexpectedly during resume.',
          remediation: [
            'Inspect the retained events, then start a fresh attempt (run lineage is preserved).',
          ],
          retryable: false,
          providerCode: 'session-mismatch',
        }),
        resumeSupported: false,
      };
    }

    const { report, sessionId, ...rest } = mapped;
    const taskReport = report as TaskRunnerReport | undefined;
    const effectiveSession = sessionId ?? session.resumeSessionId;
    return {
      ...rest,
      ...(taskReport !== undefined ? { report: taskReport } : {}),
      ...(effectiveSession !== undefined ? { sessionId: effectiveSession } : {}),
      resumeSupported:
        detected.taskResume &&
        effectiveSession !== undefined &&
        isExplicitGeminiSessionId(effectiveSession),
    };
  }

  /** Minimal bounded structured-output probe (`runner test --network`). */
  async selfTest(execution: RunnerExecutionOptions): Promise<RunnerSelfTestResult> {
    const probe = await this.probe();
    if (probe.status !== 'available') {
      return { ok: false, detail: `gemini-cli is not available (status: ${probe.status})` };
    }
    const result = await this.generateStage(
      {
        specName: 'runner-self-test',
        stage: 'requirements',
        intent: 'generate',
        prompt:
          'This is a connectivity self test. Do not read or modify any file. ' +
          'Reply with exactly one JSON document: {"schemaVersion":"1.0.0","stage":"requirements",' +
          '"markdown":"# Self Test","summary":"self test"} and nothing else.\n\nStage to produce: requirements\n',
        promptVersion: 'self-test',
        toolPolicy: 'read-only',
      },
      { ...execution, timeoutMs: Math.min(execution.timeoutMs, 120_000) },
    );
    return {
      ok: result.outcome === 'completed' && result.report !== undefined,
      detail:
        result.outcome === 'completed'
          ? 'structured output validated'
          : (result.failureReason ?? `self test failed (${result.outcome})`),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
      ...(result.process !== undefined ? { process: result.process } : {}),
    };
  }

  private capabilityRefusal(
    started: number,
    reason: string,
    remediation: string[],
  ): GeminiMappedResult {
    return {
      runner: this.name,
      outcome: 'failed',
      failureReason: `the installed Gemini CLI is incompatible with this operation: ${reason}`,
      rawStdout: '',
      rawStderr: '',
      durationMs: Math.max(0, Date.now() - started),
      warnings: [],
      error: runnerError({
        code: 'runner_incompatible',
        message: `The installed Gemini CLI lacks required safety capabilities: ${reason}.`,
        remediation,
      }),
    };
  }

  private unavailableResult(probe: GeminiProbe, started: number): GeminiMappedResult | undefined {
    if (probe.status === 'available') return undefined;
    const error =
      probe.status === 'incompatible'
        ? runnerError({
            code: 'runner_incompatible',
            message: 'The installed Gemini CLI version lacks required capabilities.',
            remediation: ['Run "specbridge runner doctor" for the exact missing capabilities.'],
          })
        : probe.status === 'misconfigured'
          ? runnerError({
              code: 'runner_disabled',
              message: 'This Gemini profile is disabled.',
              remediation: ['Enable the profile in .specbridge/config.json explicitly.'],
            })
          : probe.status === 'error'
            ? runnerError({
                code: 'process_failed',
                message: 'The Gemini CLI could not be probed.',
                remediation: ['Run "specbridge runner doctor" for details.'],
              })
            : runnerError({
                code: 'executable_not_found',
                message: `The Gemini CLI executable "${this.config.command.executable}" was not found.`,
                remediation: ['Install the Gemini CLI or fix the profile command.'],
              });
    return {
      runner: this.name,
      outcome: 'failed',
      failureReason: `the gemini-cli runner is not available (status: ${probe.status}); run "specbridge runner doctor" for details`,
      rawStdout: '',
      rawStderr: '',
      durationMs: Date.now() - started,
      warnings: probe.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message),
      error,
    };
  }

  /** Map a finished process + machine-readable output to a structured result. */
  private mapResult(
    processResult: SafeProcessResult,
    plan: GeminiInvocationPlan,
    started: number,
    reportKind: 'stage' | 'task',
  ): GeminiMappedResult {
    const warnings: string[] = plan.skippedFlags.map(
      (flag) => `flag ${flag} is unsupported by this Gemini CLI version and was skipped`,
    );

    let stream: GeminiEventStream | undefined;
    let finalText: string | undefined;
    let sessionId: string | undefined;
    let usage: RunnerUsage | undefined;
    let retainedStdout = processResult.stdout;

    if (plan.outputFormat === 'stream-json') {
      stream = parseGeminiEventStream(processResult.stdout);
      if (stream.truncated) {
        warnings.push('the provider event stream exceeded the retention limit; older events were dropped');
      }
      finalText = stream.finalResponse;
      sessionId = stream.sessionId;
      if (stream.usage !== undefined) {
        usage = {
          model: this.config.model,
          inputTokens: stream.usage.inputTokens,
          cachedInputTokens: stream.usage.cachedInputTokens,
          outputTokens: stream.usage.outputTokens,
          reasoningTokens: stream.usage.reasoningTokens,
          requestCount: stream.usage.requestCount,
          durationMs: Math.max(0, processResult.observation.durationMs),
        };
      }
      // Parsing already happened on the pristine stream; the RETAINED bytes
      // carry only safe status metadata for thought items.
      retainedStdout = redactGeminiStdoutForRetention(processResult.stdout);
    } else {
      const envelope = geminiJsonEnvelopeSchema.safeParse(safeJson(processResult.stdout));
      if (envelope.success) {
        finalText = envelope.data.response;
        sessionId = envelope.data.stats?.session_id;
        if (envelope.data.stats !== undefined) {
          usage = {
            model: this.config.model,
            inputTokens: envelope.data.stats.input_tokens ?? null,
            cachedInputTokens: envelope.data.stats.cached_input_tokens ?? null,
            outputTokens: envelope.data.stats.output_tokens ?? null,
            reasoningTokens: null,
            requestCount: 1,
            durationMs: Math.max(0, processResult.observation.durationMs),
          };
        }
      }
    }

    const normalizedEvents =
      stream !== undefined
        ? normalizeGeminiEvents(
            stream,
            { runner: this.name, profile: this.name, runId: 'pending', attemptId: 'pending' },
            () => new Date().toISOString(),
          )
        : undefined;

    const base = {
      runner: this.name,
      rawStdout: retainedStdout,
      rawStderr: processResult.stderr,
      process: processResult.observation,
      durationMs: Math.max(0, Date.now() - started),
      warnings,
      ...(normalizedEvents !== undefined ? { normalizedEvents } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    };

    switch (processResult.status) {
      case 'timeout':
        return {
          ...base,
          outcome: 'timed-out',
          failureReason: processResult.failureReason ?? 'timeout',
          error: runnerError({
            code: 'timed_out',
            message: 'The Gemini process exceeded the configured timeout and was terminated.',
            remediation: ['Increase the profile timeoutMs or narrow the task.'],
          }),
        };
      case 'cancelled':
        return {
          ...base,
          outcome: 'cancelled',
          failureReason: processResult.failureReason ?? 'cancelled',
          error: runnerError({
            code: 'cancelled',
            message: 'The Gemini process was cancelled and terminated.',
          }),
        };
      case 'output-limit':
        return {
          ...base,
          outcome: 'failed',
          failureReason: processResult.failureReason ?? 'output limit exceeded',
          error: runnerError({
            code: 'output_limit_exceeded',
            message: 'The Gemini process exceeded the configured output limit and was terminated.',
            remediation: ['Raise maxStdoutBytes/maxStderrBytes on the profile if this was legitimate.'],
          }),
        };
      case 'spawn-failed':
        return {
          ...base,
          outcome: 'failed',
          failureReason: processResult.failureReason ?? 'spawn failed',
          error: runnerError({
            code: 'executable_not_found',
            message: `The Gemini CLI executable could not be started: ${processResult.failureReason ?? 'unknown spawn failure'}.`,
            remediation: ['Install the Gemini CLI or fix the profile command.'],
          }),
        };
      case 'ok':
      case 'nonzero-exit':
        break;
    }

    if (processResult.status === 'nonzero-exit') {
      const error = classifyGeminiFailure(processResult.stderr, stream?.errors ?? []);
      return {
        ...base,
        outcome: error.code === 'permission_denied' ? 'permission-denied' : 'failed',
        failureReason: `${error.message} (exit ${processResult.observation.exitCode ?? 'unknown'})`,
        error,
      };
    }

    // Exit 0: require a strict structured final result. Prose around the
    // JSON document is NOT accepted — the prompt contract requires JSON-only
    // final responses, and the complete text is validated with Zod. JSON is
    // never extracted from a substring or a Markdown fence.
    if (finalText === undefined || finalText.trim().length === 0) {
      return {
        ...base,
        outcome: 'malformed-output',
        failureReason:
          stream !== undefined && stream.errors.length > 0
            ? `the provider reported: ${stream.errors[0]}`
            : 'the runner returned no final structured result',
        error: runnerError({
          code: 'structured_output_invalid',
          message: 'The Gemini run produced no final structured result.',
          remediation: ['Inspect the retained output in the run directory.'],
        }),
      };
    }
    const parsed = strictJsonParse(finalText);
    if (parsed === undefined) {
      return {
        ...base,
        outcome: 'malformed-output',
        failureReason: 'the final response is not a bare JSON document (extra prose is not accepted)',
        error: runnerError({
          code: 'structured_output_invalid',
          message: 'The final Gemini response did not parse as a JSON document.',
        }),
        ...(reportKind === 'stage'
          ? { invalidStructuredOutput: finalText.length > 100_000 ? finalText.slice(0, 100_000) : finalText }
          : {}),
      };
    }
    const schema = reportKind === 'stage' ? stageRunnerReportSchema : taskRunnerReportSchema;
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      const problems = validated.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      return {
        ...base,
        outcome: 'malformed-output',
        failureReason: `structured result does not match the report schema: ${problems}`,
        error: runnerError({
          code: 'structured_output_invalid',
          message: 'The final Gemini response did not match the required report schema.',
          details: { problems: problems.slice(0, 2000) },
        }),
        ...(reportKind === 'stage'
          ? { invalidStructuredOutput: finalText.length > 100_000 ? finalText.slice(0, 100_000) : finalText }
          : {}),
      };
    }

    const report = validated.data as StageRunnerReport | TaskRunnerReport;
    const outcome: ExecutionOutcome =
      'outcome' in report ? (report.outcome as ExecutionOutcome) : 'completed';
    return {
      ...base,
      outcome,
      report,
      ...(outcome === 'completed' || outcome === 'no-change'
        ? {}
        : { failureReason: `the agent reported "${outcome}"` }),
    };
  }
}

function safeJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
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
