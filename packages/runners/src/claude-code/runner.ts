import type {
  ClaudeRunnerConfig,
  ExecutionOutcome,
  StageRunnerReport,
  TaskRunnerReport,
} from '@specbridge/core';
import {
  STAGE_RUNNER_REPORT_JSON_SCHEMA,
  TASK_RUNNER_REPORT_JSON_SCHEMA,
  claudeRunnerConfigSchema,
  parseStageRunnerReport,
  parseTaskRunnerReport,
  stageRunnerReportSchema,
  taskRunnerReportSchema,
} from '@specbridge/core';
import type {
  AgentRunner,
  ProcessObservation,
  RunnerDetectionContext,
  RunnerDetectionResult,
  RunnerExecutionOptions,
  RunnerSelfTestResult,
  RunnerToolPolicy,
  StageGenerationInput,
  StageGenerationResult,
  TaskExecutionInput,
  TaskExecutionResult,
  TaskResumeInput,
} from '../contract.js';
import { effectiveSupportLevel } from '../contracts/capabilities.js';
import type { RunnerCost, RunnerUsage } from '../contracts/usage.js';
import { emptyUsage } from '../contracts/usage.js';
import type { SafeProcessResult } from '../safe-process.js';
import type { ClaudeProbe } from './detection.js';
import { CLAUDE_DECLARED_CAPABILITIES, claudeCapabilitySet, probeClaude } from './detection.js';
import type { ClaudeEnvelope, ClaudeInvocationPlan } from './invocation.js';
import {
  buildClaudeInvocation,
  cleanupTempFiles,
  parseClaudeEnvelope,
  runClaudeInvocation,
} from './invocation.js';

/** Internal result shape before it is narrowed to stage/task results. */
interface MappedResult {
  runner: string;
  outcome: ExecutionOutcome;
  failureReason?: string;
  rawStdout: string;
  rawStderr: string;
  process?: ProcessObservation;
  sessionId?: string;
  durationMs: number;
  warnings: string[];
  usage?: RunnerUsage;
  cost?: RunnerCost;
  report?: StageRunnerReport | TaskRunnerReport;
}

/**
 * Claude Code runner (v0.3): invokes the locally installed `claude` CLI in
 * non-interactive print mode.
 *
 * The local user installs and authenticates Claude Code independently.
 * SpecBridge only spawns the configured executable — it never collects,
 * stores, proxies, or prints credentials, and it never passes a
 * permission-bypass flag (enforced and tested at three layers: config
 * schema, argv assembly, and pre-spawn assertion).
 */
export class ClaudeCodeRunner implements AgentRunner {
  readonly name = 'claude-code';
  readonly kind = 'claude-code';
  readonly category = 'agent-cli';
  readonly declaredCapabilities = CLAUDE_DECLARED_CAPABILITIES;
  private readonly config: ClaudeRunnerConfig;
  private probePromise: Promise<ClaudeProbe> | undefined;

  constructor(config?: Partial<ClaudeRunnerConfig>) {
    this.config = claudeRunnerConfigSchema.parse(config ?? {});
  }

  /** Probe once per runner instance; detection is read-only but not free. */
  private probe(timeoutMs?: number): Promise<ClaudeProbe> {
    this.probePromise ??= probeClaude(
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
        executable: this.config.command,
        authentication: 'unknown',
        capabilities: [],
        diagnostics: [
          {
            severity: 'error',
            code: 'RUNNER_DISABLED',
            message:
              'The claude-code runner is disabled in .specbridge/config.json (runners.claude-code.enabled = false).',
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
      capabilitySet: claudeCapabilitySet(probe),
      supportLevel: effectiveSupportLevel('production', probe.status),
      // The Claude Code CLI talks to its provider itself; SpecBridge's own
      // transport is a local child process.
      networkBacked: false,
    };
  }

  executionBoundaryNote(policy: RunnerToolPolicy): string {
    if (policy !== 'implementation') {
      return 'Allowed tools: Read, Glob, Grep (read-only repository access). Permission bypasses are never used.';
    }
    return `Allowed tools: ${this.config.tools.join(', ')} (Bash limited to the configured allow rules); permission mode: ${this.config.permissionMode}. Permission bypasses are never used.`;
  }

  /** Minimal bounded structured-output probe (`runner test --network`). */
  async selfTest(execution: RunnerExecutionOptions): Promise<RunnerSelfTestResult> {
    const probe = await this.probe();
    if (probe.status !== 'available') {
      return { ok: false, detail: `claude-code is not available (status: ${probe.status})` };
    }
    const plan = buildClaudeInvocation({
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
    const result = await runClaudeInvocation(plan, this.config, execution);
    cleanupTempFiles(plan);
    if (result.status !== 'ok') {
      return {
        ok: false,
        detail: result.failureReason ?? `self test failed (${result.status})`,
        process: result.observation,
      };
    }
    const parsed = parseClaudeEnvelope(result.stdout);
    const report =
      parsed.structuredResult !== undefined
        ? stageRunnerReportSchema.safeParse(parsed.structuredResult)
        : parsed.reportText !== undefined
          ? stageRunnerReportSchema.safeParse(safeJsonParse(parsed.reportText))
          : undefined;
    const usage = usageFromEnvelope(parsed.envelope, result.observation.durationMs);
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

    const plan = buildClaudeInvocation({
      config: this.config,
      probe,
      prompt: input.prompt,
      toolPolicy: input.toolPolicy,
      outputJsonSchema: STAGE_RUNNER_REPORT_JSON_SCHEMA,
      execution,
    });
    const processResult = await runClaudeInvocation(plan, this.config, execution);
    const mapped = this.mapResult(processResult, plan, started, 'stage');
    if (mapped.outcome === 'completed' || mapped.outcome === 'no-change') {
      cleanupTempFiles(plan);
    }
    const { report, ...rest } = mapped;
    const stageReport = report as StageRunnerReport | undefined;
    return { ...rest, ...(stageReport !== undefined ? { report: stageReport } : {}) };
  }

  async executeTask(
    input: TaskExecutionInput,
    execution: RunnerExecutionOptions,
  ): Promise<TaskExecutionResult> {
    return this.runTask(input.prompt, execution, {
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    });
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
    session: { sessionId?: string; resumeSessionId?: string },
  ): Promise<TaskExecutionResult> {
    const started = Date.now();
    const probe = await this.probe();
    const unavailable = this.unavailableResult(probe, started);
    if (unavailable !== undefined) {
      const { report: _report, ...rest } = unavailable;
      return { ...rest, resumeSupported: false };
    }

    const plan = buildClaudeInvocation({
      config: this.config,
      probe,
      prompt,
      toolPolicy: 'implementation',
      outputJsonSchema: TASK_RUNNER_REPORT_JSON_SCHEMA,
      ...(session.sessionId !== undefined ? { sessionId: session.sessionId } : {}),
      ...(session.resumeSessionId !== undefined
        ? { resumeSessionId: session.resumeSessionId }
        : {}),
      execution,
    });
    const processResult = await runClaudeInvocation(plan, this.config, execution);
    const mapped = this.mapResult(processResult, plan, started, 'task');
    if (mapped.outcome === 'completed' || mapped.outcome === 'no-change') {
      cleanupTempFiles(plan);
    }

    const resumeCapable =
      probe.capabilities.find((c) => c.id === 'resume')?.available === true;
    const { report, sessionId, ...rest } = mapped;
    const taskReport = report as TaskRunnerReport | undefined;
    const effectiveSession = sessionId ?? session.sessionId ?? session.resumeSessionId;
    return {
      ...rest,
      ...(taskReport !== undefined ? { report: taskReport } : {}),
      ...(effectiveSession !== undefined ? { sessionId: effectiveSession } : {}),
      resumeSupported: resumeCapable && effectiveSession !== undefined,
    };
  }

  private unavailableResult(probe: ClaudeProbe, started: number): MappedResult | undefined {
    if (probe.status === 'available') return undefined;
    return {
      runner: this.name,
      outcome: 'failed',
      failureReason:
        `the claude-code runner is not available (status: ${probe.status}); ` +
        'run "specbridge runner doctor claude-code" for details',
      rawStdout: '',
      rawStderr: '',
      durationMs: Date.now() - started,
      warnings: probe.diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => d.message),
    };
  }

  /** Map a finished process to a structured runner result. */
  private mapResult(
    processResult: SafeProcessResult,
    plan: ClaudeInvocationPlan,
    started: number,
    reportKind: 'stage' | 'task',
  ): MappedResult {
    const warnings: string[] = plan.skippedFlags.map(
      (flag) => `flag ${flag} is unsupported by this Claude Code version and was skipped`,
    );
    const base = {
      runner: this.name,
      rawStdout: processResult.stdout,
      rawStderr: processResult.stderr,
      process: processResult.observation,
      durationMs: Math.max(0, Date.now() - started),
      warnings,
    };

    switch (processResult.status) {
      case 'timeout':
        return { ...base, outcome: 'timed-out', failureReason: processResult.failureReason ?? 'timeout' };
      case 'cancelled':
        return { ...base, outcome: 'cancelled', failureReason: processResult.failureReason ?? 'cancelled' };
      case 'output-limit':
      case 'spawn-failed':
        return { ...base, outcome: 'failed', failureReason: processResult.failureReason ?? processResult.status };
      case 'ok':
      case 'nonzero-exit':
        break;
    }

    const parsed = parseClaudeEnvelope(processResult.stdout);
    const sessionId = parsed.envelope?.session_id;
    const usage = usageFromEnvelope(parsed.envelope, processResult.observation.durationMs);
    const cost = costFromEnvelope(parsed.envelope);
    const withSession = {
      ...base,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(cost !== undefined ? { cost } : {}),
    };

    if (this.looksPermissionDenied(processResult, parsed.envelope?.subtype, parsed.envelope)) {
      return {
        ...withSession,
        outcome: 'permission-denied',
        failureReason:
          'Claude Code reported a permission denial. SpecBridge never bypasses permissions; ' +
          'adjust runners.claude-code.tools / allowedBashRules if the denied action should be allowed.',
      };
    }

    if (processResult.status === 'nonzero-exit') {
      return {
        ...withSession,
        outcome: 'failed',
        failureReason: processResult.failureReason ?? 'nonzero exit',
      };
    }

    // Exit 0: extract and validate the structured report.
    let report: StageRunnerReport | TaskRunnerReport | undefined;
    let parseProblem = parsed.problem;
    if (parsed.structuredResult !== undefined) {
      const schema = reportKind === 'stage' ? stageRunnerReportSchema : taskRunnerReportSchema;
      const validated = schema.safeParse(parsed.structuredResult);
      if (validated.success) report = validated.data;
      else {
        parseProblem = `structured result does not match the report schema: ${validated.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')}`;
      }
    } else if (parsed.reportText !== undefined) {
      const result =
        reportKind === 'stage'
          ? parseStageRunnerReport(parsed.reportText)
          : parseTaskRunnerReport(parsed.reportText);
      if (result.ok) report = result.report;
      else parseProblem = result.reason;
    }

    if (report === undefined) {
      if (parsed.envelope?.is_error === true) {
        return {
          ...withSession,
          outcome: 'failed',
          failureReason: `Claude Code reported an error result${parsed.envelope.subtype !== undefined ? ` (${parsed.envelope.subtype})` : ''}`,
        };
      }
      return {
        ...withSession,
        outcome: 'malformed-output',
        failureReason: parseProblem ?? 'the runner returned no parseable structured result',
      };
    }

    const outcome: ExecutionOutcome =
      'outcome' in report && report.outcome !== undefined
        ? mapReportedOutcome(report.outcome)
        : 'completed';
    return {
      ...withSession,
      outcome,
      report,
      ...(outcome === 'completed' || outcome === 'no-change'
        ? {}
        : { failureReason: `the agent reported "${outcome}"` }),
    };
  }

  private looksPermissionDenied(
    processResult: SafeProcessResult,
    subtype: string | undefined,
    envelope: { permission_denials?: unknown[] | undefined } | undefined,
  ): boolean {
    if (subtype !== undefined && /permission/i.test(subtype)) return true;
    if (envelope?.permission_denials !== undefined && envelope.permission_denials.length > 0) {
      // Denials happen legitimately mid-run; only treat them as the outcome
      // when the process also failed.
      return processResult.status === 'nonzero-exit';
    }
    if (
      processResult.status === 'nonzero-exit' &&
      /permission[^\n]{0,40}denied|denied[^\n]{0,40}permission/i.test(processResult.stderr)
    ) {
      return true;
    }
    return false;
  }
}

function mapReportedOutcome(
  reported: 'completed' | 'blocked' | 'failed' | 'no-change',
): ExecutionOutcome {
  return reported;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function tolerantCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Provider-reported usage from the result envelope, when the installed CLI
 * emits it (`usage`, `num_turns`, `total_cost_usd` are envelope passthrough
 * fields). Absent fields stay null — never guessed.
 */
export function usageFromEnvelope(
  envelope: ClaudeEnvelope | undefined,
  durationMs: number,
): RunnerUsage | undefined {
  if (envelope === undefined) return undefined;
  const usage = (envelope as Record<string, unknown>)['usage'];
  const numTurns = tolerantCount((envelope as Record<string, unknown>)['num_turns']);
  if (usage === null || typeof usage !== 'object') {
    if (numTurns === null) return undefined;
    return { ...emptyUsage(durationMs), requestCount: numTurns };
  }
  const record = usage as Record<string, unknown>;
  return {
    model: null,
    inputTokens: tolerantCount(record['input_tokens']),
    cachedInputTokens: tolerantCount(record['cache_read_input_tokens']),
    outputTokens: tolerantCount(record['output_tokens']),
    reasoningTokens: null,
    requestCount: numTurns,
    durationMs: Math.max(0, Math.round(durationMs)),
  };
}

/** Provider-reported cost from the envelope (`total_cost_usd`), when present. */
export function costFromEnvelope(envelope: ClaudeEnvelope | undefined): RunnerCost | undefined {
  if (envelope === undefined) return undefined;
  const cost = (envelope as Record<string, unknown>)['total_cost_usd'];
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return undefined;
  return { currency: 'USD', amount: cost, source: 'provider-reported' };
}
