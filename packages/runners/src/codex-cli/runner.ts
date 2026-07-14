import type {
  CodexProfileConfig,
  ExecutionOutcome,
  StageRunnerReport,
  TaskRunnerReport,
} from '@specbridge/core';
import {
  STAGE_RUNNER_REPORT_JSON_SCHEMA,
  TASK_RUNNER_REPORT_JSON_SCHEMA,
  codexProfileSchema,
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
import type { CodexProbe } from './detection.js';
import { CODEX_DECLARED_CAPABILITIES, codexCapabilitySet, probeCodex } from './detection.js';
import type { CodexInvocationPlan } from './invocation.js';
import {
  buildCodexInvocation,
  cleanupCodexTempFiles,
  readLastMessage,
  runCodexInvocation,
} from './invocation.js';
import type { CodexEventStream } from './events.js';
import { normalizeCodexEvents, parseCodexEventStream } from './events.js';

/**
 * Codex CLI runner (v0.6): invokes the locally installed `codex` CLI in
 * non-interactive `exec` mode with machine-readable events.
 *
 * The local user installs and authenticates Codex independently. SpecBridge
 * only spawns the configured executable — it never collects, stores,
 * proxies, or prints credentials, never reads provider credential files, and
 * never enables an unrestricted sandbox mode (enforced at three layers:
 * config schema, argv assembly, pre-spawn assertion).
 *
 * Boundaries:
 *   - stage generation / refinement: `--sandbox read-only`
 *   - task execution / resume:       `--sandbox workspace-write`
 *   - provider-reported file changes, commands, and completion claims are
 *     CLAIMS; evidence comes from SpecBridge's own Git snapshots and trusted
 *     verification commands
 */

interface CodexMappedResult {
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
}

/** Classify a nonzero-exit / stream failure into a normalized error. */
export function classifyCodexFailure(
  stderr: string,
  streamErrors: string[],
): NormalizedRunnerError {
  const haystack = `${stderr}\n${streamErrors.join('\n')}`.toLowerCase();
  if (/not logged in|login required|unauthorized|authentication|401/.test(haystack)) {
    return runnerError({
      code: 'authentication_required',
      message: 'The Codex CLI reported an authentication failure.',
      remediation: ['Run "codex login" yourself (SpecBridge never handles credentials).'],
    });
  }
  if (/insufficient_quota|quota exceeded|usage limit|out of credits/.test(haystack)) {
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
  if (/sandbox (is )?unavailable|sandbox unsupported|landlock|seatbelt.*(unavailable|failed)/.test(haystack)) {
    return runnerError({
      code: 'sandbox_unavailable',
      message: 'The Codex CLI could not establish its sandbox on this system.',
      remediation: [
        'SpecBridge never disables sandboxing; fix the sandbox support (see the Codex documentation for your platform).',
      ],
    });
  }
  if (/permission denied|approval (required|denied)|not permitted/.test(haystack)) {
    return runnerError({
      code: 'permission_denied',
      message: 'The Codex CLI reported a permission denial.',
      remediation: [
        'SpecBridge never bypasses approvals; narrow the task or adjust the profile sandbox (read-only vs workspace-write).',
      ],
    });
  }
  if (/network|connection|dns|econn|etimedout/.test(haystack)) {
    return runnerError({
      code: 'network_error',
      message: 'The Codex CLI reported a network failure.',
      remediation: ['Check connectivity and retry explicitly.'],
    });
  }
  return runnerError({
    code: 'process_failed',
    message: 'The Codex CLI exited with a failure.',
    remediation: ['Inspect the retained stderr and event log in the run directory.'],
  });
}

export class CodexCliRunner implements AgentRunner {
  readonly name = 'codex-cli';
  readonly kind = 'codex-cli';
  readonly category = 'agent-cli';
  readonly declaredCapabilities = CODEX_DECLARED_CAPABILITIES;
  private readonly config: CodexProfileConfig;
  private probePromise: Promise<CodexProbe> | undefined;

  constructor(config?: Partial<CodexProfileConfig>) {
    this.config = codexProfileSchema.parse({ runner: 'codex-cli', ...(config ?? {}) });
  }

  /** Probe once per runner instance; detection is read-only but not free. */
  private probe(timeoutMs?: number): Promise<CodexProbe> {
    this.probePromise ??= probeCodex(
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
              'This Codex profile is disabled in .specbridge/config.json (enabled = false). ' +
              'Enable it explicitly to use Codex.',
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
      capabilitySet: codexCapabilitySet(probe),
      supportLevel: effectiveSupportLevel('production', probe.status),
      // The Codex CLI talks to its provider itself; SpecBridge's own
      // transport is a local child process.
      networkBacked: false,
    };
  }

  executionBoundaryNote(policy: RunnerToolPolicy): string {
    if (policy !== 'implementation') {
      return 'Execution sandbox: read-only (repository inspection only; no file writes, approvals never bypassed).';
    }
    const mode = this.config.sandbox === 'read-only' ? 'read-only' : 'workspace-write';
    return `Execution sandbox: ${mode} (writes limited to this repository; no unrestricted filesystem access; approvals and sandbox checks are never disabled).`;
  }

  listModels(_context: RunnerDetectionContext): Promise<RunnerModelListResult> {
    return Promise.resolve({
      supported: false,
      models: [],
      detail:
        'The Codex CLI has no officially supported local model-listing command; ' +
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
    const plan = buildCodexInvocation({
      config: this.config,
      probe,
      prompt: input.prompt,
      toolPolicy: input.toolPolicy,
      outputJsonSchema: STAGE_RUNNER_REPORT_JSON_SCHEMA,
      execution,
    });
    const processResult = await runCodexInvocation(plan, this.config, execution);
    const mapped = this.mapResult(processResult, plan, started, 'stage');
    cleanupCodexTempFiles(plan);
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
    const plan = buildCodexInvocation({
      config: this.config,
      probe,
      prompt,
      toolPolicy: 'implementation',
      outputJsonSchema: TASK_RUNNER_REPORT_JSON_SCHEMA,
      ...(session.resumeSessionId !== undefined
        ? { resumeSessionId: session.resumeSessionId }
        : {}),
      execution,
    });
    const processResult = await runCodexInvocation(plan, this.config, execution);
    const mapped = this.mapResult(processResult, plan, started, 'task');
    cleanupCodexTempFiles(plan);

    const resumeCapable =
      this.config.persistSessions &&
      probe.capabilities.find((capability) => capability.id === 'resume')?.available === true;
    const { report, sessionId, ...rest } = mapped;
    const taskReport = report as TaskRunnerReport | undefined;
    const effectiveSession = sessionId ?? session.resumeSessionId;
    return {
      ...rest,
      ...(taskReport !== undefined ? { report: taskReport } : {}),
      ...(effectiveSession !== undefined ? { sessionId: effectiveSession } : {}),
      resumeSupported: resumeCapable && effectiveSession !== undefined,
    };
  }

  /** Minimal bounded structured-output probe (`runner test --network`). */
  async selfTest(execution: RunnerExecutionOptions): Promise<RunnerSelfTestResult> {
    const probe = await this.probe();
    if (probe.status !== 'available') {
      return { ok: false, detail: `codex-cli is not available (status: ${probe.status})` };
    }
    const plan = buildCodexInvocation({
      config: this.config,
      probe,
      prompt:
        'This is a connectivity self test. Do not read or modify any file. ' +
        'Reply with exactly one JSON document: {"schemaVersion":"1.0.0","stage":"requirements",' +
        '"markdown":"# Self Test","summary":"self test"} and nothing else.',
      toolPolicy: 'read-only',
      outputJsonSchema: STAGE_RUNNER_REPORT_JSON_SCHEMA,
      execution,
    });
    const result = await runCodexInvocation(plan, this.config, execution);
    const stream = parseCodexEventStream(result.stdout);
    const finalText = readLastMessage(plan) ?? stream.lastAgentMessage;
    cleanupCodexTempFiles(plan);
    if (result.status !== 'ok') {
      return {
        ok: false,
        detail: result.failureReason ?? `self test failed (${result.status})`,
        process: result.observation,
      };
    }
    const report =
      finalText !== undefined
        ? stageRunnerReportSchema.safeParse(strictJsonParse(finalText))
        : undefined;
    const usage = usageFromStream(stream, result.observation.durationMs, this.config.model);
    return report !== undefined && report.success
      ? {
          ok: true,
          detail: 'structured output validated',
          process: result.observation,
          ...(usage !== undefined ? { usage } : {}),
        }
      : {
          ok: false,
          detail: 'the runner responded but did not return a valid structured result',
          process: result.observation,
        };
  }

  private unavailableResult(probe: CodexProbe, started: number): CodexMappedResult | undefined {
    if (probe.status === 'available') return undefined;
    const error =
      probe.status === 'unauthenticated'
        ? runnerError({
            code: 'authentication_required',
            message: 'The Codex CLI is installed but not authenticated.',
            remediation: ['Run "codex login" yourself (SpecBridge never handles credentials).'],
          })
        : probe.status === 'incompatible'
          ? runnerError({
              code: 'runner_incompatible',
              message: 'The installed Codex CLI version lacks required capabilities.',
              remediation: ['Run "specbridge runner doctor" for the exact missing capabilities.'],
            })
          : probe.status === 'misconfigured'
            ? runnerError({
                code: 'runner_disabled',
                message: 'This Codex profile is disabled.',
                remediation: ['Enable the profile in .specbridge/config.json explicitly.'],
              })
            : runnerError({
                code: 'executable_not_found',
                message: `The Codex CLI executable "${this.config.command.executable}" was not found.`,
                remediation: ['Install the Codex CLI or fix the profile command.'],
              });
    return {
      runner: this.name,
      outcome: 'failed',
      failureReason: `the codex-cli runner is not available (status: ${probe.status}); run "specbridge runner doctor" for details`,
      rawStdout: '',
      rawStderr: '',
      durationMs: Date.now() - started,
      warnings: probe.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message),
      error,
    };
  }

  /** Map a finished process + event stream to a structured runner result. */
  private mapResult(
    processResult: SafeProcessResult,
    plan: CodexInvocationPlan,
    started: number,
    reportKind: 'stage' | 'task',
  ): CodexMappedResult {
    const warnings: string[] = plan.skippedFlags.map(
      (flag) => `flag ${flag} is unsupported by this Codex CLI version and was skipped`,
    );
    const stream = parseCodexEventStream(processResult.stdout);
    if (stream.truncated) {
      warnings.push('the provider event stream exceeded the retention limit; older events were dropped');
    }
    const normalizedEvents = normalizeCodexEvents(
      stream,
      {
        runner: this.name,
        profile: this.name,
        runId: 'pending',
        attemptId: 'pending',
      },
      () => new Date().toISOString(),
    );
    const usage = usageFromStream(stream, processResult.observation.durationMs, this.config.model);
    const base = {
      runner: this.name,
      rawStdout: processResult.stdout,
      rawStderr: processResult.stderr,
      process: processResult.observation,
      durationMs: Math.max(0, Date.now() - started),
      warnings,
      normalizedEvents,
      ...(usage !== undefined ? { usage } : {}),
      ...(stream.threadId !== undefined ? { sessionId: stream.threadId } : {}),
    };

    switch (processResult.status) {
      case 'timeout':
        return {
          ...base,
          outcome: 'timed-out',
          failureReason: processResult.failureReason ?? 'timeout',
          error: runnerError({
            code: 'timed_out',
            message: 'The Codex process exceeded the configured timeout and was terminated.',
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
            message: 'The Codex process was cancelled and terminated.',
          }),
        };
      case 'output-limit':
        return {
          ...base,
          outcome: 'failed',
          failureReason: processResult.failureReason ?? 'output limit exceeded',
          error: runnerError({
            code: 'output_limit_exceeded',
            message: 'The Codex process exceeded the configured output limit and was terminated.',
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
            message: `The Codex CLI executable could not be started: ${processResult.failureReason ?? 'unknown spawn failure'}.`,
            remediation: ['Install the Codex CLI or fix the profile command.'],
          }),
        };
      case 'ok':
      case 'nonzero-exit':
        break;
    }

    if (processResult.status === 'nonzero-exit') {
      const error = classifyCodexFailure(processResult.stderr, stream.errors);
      return {
        ...base,
        outcome: error.code === 'permission_denied' ? 'permission-denied' : 'failed',
        failureReason: `${error.message} (exit ${processResult.observation.exitCode ?? 'unknown'})`,
        error,
      };
    }

    // Exit 0: require a strict structured final result. Prose around the
    // JSON document is NOT accepted — with --output-schema the final message
    // is schema-constrained, and the prompt contract requires JSON-only
    // final messages in the degraded mode too.
    const finalText = readLastMessage(plan) ?? stream.lastAgentMessage;
    if (finalText === undefined || finalText.trim().length === 0) {
      return {
        ...base,
        outcome: 'malformed-output',
        failureReason:
          stream.errors.length > 0
            ? `the provider reported: ${stream.errors[0]}`
            : 'the runner returned no final agent message',
        error: runnerError({
          code: 'structured_output_invalid',
          message: 'The Codex run produced no final structured result.',
          remediation: ['Inspect the retained event log in the run directory.'],
        }),
      };
    }
    const parsed = strictJsonParse(finalText);
    if (parsed === undefined) {
      return {
        ...base,
        outcome: 'malformed-output',
        failureReason: 'the final agent message is not a bare JSON document (extra prose is not accepted)',
        error: runnerError({
          code: 'structured_output_invalid',
          message: 'The final Codex message did not parse as a JSON document.',
        }),
      };
    }
    const schema = reportKind === 'stage' ? stageRunnerReportSchema : taskRunnerReportSchema;
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      return {
        ...base,
        outcome: 'malformed-output',
        failureReason: `structured result does not match the report schema: ${validated.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')}`,
        error: runnerError({
          code: 'structured_output_invalid',
          message: 'The final Codex message did not match the required report schema.',
        }),
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

function strictJsonParse(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function usageFromStream(
  stream: CodexEventStream,
  durationMs: number,
  model: string | null,
): RunnerUsage | undefined {
  if (stream.usage === undefined) return undefined;
  return {
    model,
    inputTokens: stream.usage.inputTokens,
    cachedInputTokens: stream.usage.cachedInputTokens,
    outputTokens: stream.usage.outputTokens,
    reasoningTokens: stream.usage.reasoningTokens,
    requestCount: stream.usage.requestCount,
    durationMs: Math.max(0, Math.round(durationMs)),
  };
}
