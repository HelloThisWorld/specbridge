import type {
  ExtensionRunnerProfileConfig,
  StageRunnerReport,
  TaskRunnerReport,
  WorkspaceInfo,
} from '@specbridge/core';
import { parseStageRunnerReport, parseTaskRunnerReport } from '@specbridge/core';
import type {
  AgentRunner,
  NormalizedRunnerError,
  RunnerCapabilitySet,
  RunnerCost,
  RunnerDetectionContext,
  RunnerDetectionResult,
  RunnerExecutionOptions,
  RunnerModelListResult,
  RunnerUsage,
  StageGenerationInput,
  StageGenerationResult,
  TaskExecutionInput,
  TaskExecutionResult,
  TaskResumeInput,
} from '@specbridge/runners';
import { capabilitySet, runnerError } from '@specbridge/runners';
import {
  runnerDetectOutputSchema,
  runnerModelListOutputSchema,
  runnerStageOutputSchema,
  runnerTaskOutputSchema,
  type ExtensionManifest,
  type RunnerStageOutput,
  type RunnerTaskOutput,
} from '@specbridge/extension-sdk';
import { requireEnabledExtension, type EnabledExtension } from './enablement.js';
import { isExtensionError } from './errors.js';
import { invokeExtensionOperation } from './protocol-client.js';

/**
 * Extension-backed AgentRunner proxy.
 *
 * Implements the frozen v0.6.0 runner contract by translating each call into
 * the versioned extension protocol. The contract is untouched: extension
 * runners remain subject to runner selection, capability requirements, git
 * snapshots, trusted verification, evidence evaluation, protected paths, and
 * verified-only task completion. Everything the extension reports is a
 * provider *claim* — never evidence, never task-completion authority.
 *
 * Extension runners always declare support level `preview` (they are never
 * selected automatically and can never be confirmed production by
 * conformance) and category `experimental`.
 */
function deriveDeclaredCapabilities(manifest: ExtensionManifest | undefined): RunnerCapabilitySet {
  if (manifest === undefined) {
    return capabilitySet([]);
  }
  const operations = new Set(manifest.capabilities.operations);
  const permissions = manifest.permissions;
  const enabled: Parameters<typeof capabilitySet>[0] = [];
  if (operations.has('runner.generateStage')) enabled.push('stageGeneration');
  if (operations.has('runner.refineStage')) enabled.push('stageRefinement');
  if (operations.has('runner.executeTask')) enabled.push('taskExecution');
  if (operations.has('runner.resumeTask')) enabled.push('taskResume');
  if (operations.has('runner.generateStage') || operations.has('runner.executeTask')) {
    enabled.push('structuredFinalOutput');
  }
  if (operations.has('runner.executeTask')) {
    // The protocol passes the tool policy through; honoring it is part of the
    // extension contract and checked by conformance where observable. This is
    // a declared claim, not an enforcement guarantee — evidence evaluation
    // and protected-path checks remain the authority either way.
    enabled.push('toolRestriction');
  }
  if (permissions.repositoryRead) enabled.push('repositoryRead');
  if (permissions.repositoryWrite) enabled.push('repositoryWrite');
  if (permissions.network) enabled.push('requiresNetwork');
  else enabled.push('localOnly');
  enabled.push('supportsCancellation');
  return capabilitySet(enabled);
}

function usageFrom(output: RunnerStageOutput | RunnerTaskOutput, durationMs: number): RunnerUsage | undefined {
  const usage = output.usage;
  if (usage === undefined) {
    return undefined;
  }
  return {
    model: usage.model ?? null,
    inputTokens: usage.inputTokens ?? null,
    cachedInputTokens: usage.cachedInputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    reasoningTokens: usage.reasoningTokens ?? null,
    requestCount: usage.requestCount ?? null,
    durationMs: Math.max(0, Math.round(durationMs)),
  };
}

function costFrom(output: RunnerStageOutput | RunnerTaskOutput): RunnerCost | undefined {
  const cost = output.cost;
  if (cost === undefined) {
    return undefined;
  }
  const amount = cost.amount ?? null;
  return {
    currency: cost.currency ?? null,
    amount,
    source: amount !== null ? 'provider-reported' : 'unavailable',
  };
}

function failureError(cause: unknown): NormalizedRunnerError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = isExtensionError(cause)
    ? cause.extensionCode === 'SBE023'
      ? 'timed_out'
      : cause.extensionCode === 'SBE024'
        ? 'cancelled'
        : 'process_failed'
    : 'process_failed';
  return runnerError({
    code,
    message,
    remediation: ['Run `specbridge extension doctor` for the extension and check its stderr logs.'],
  });
}

function failureOutcome(cause: unknown): 'timed-out' | 'cancelled' | 'failed' {
  if (isExtensionError(cause)) {
    if (cause.extensionCode === 'SBE023') return 'timed-out';
    if (cause.extensionCode === 'SBE024') return 'cancelled';
  }
  return 'failed';
}

export class ExtensionRunnerProxy implements AgentRunner {
  readonly name = 'extension';
  readonly kind = 'extension' as const;
  readonly category = 'experimental' as const;
  readonly declaredCapabilities: RunnerCapabilitySet;
  readonly declaredSupportLevel = 'preview' as const;

  constructor(
    private readonly workspace: WorkspaceInfo,
    private readonly config: ExtensionRunnerProfileConfig,
  ) {
    this.declaredCapabilities = deriveDeclaredCapabilities(this.tryResolve()?.manifest);
  }

  private tryResolve(): EnabledExtension | undefined {
    try {
      return this.resolve();
    } catch {
      return undefined;
    }
  }

  private resolve(): EnabledExtension {
    const enabled = requireEnabledExtension(this.workspace, this.config.extensionId);
    if (enabled.manifest.kind !== 'runner') {
      throw new Error(
        `extension "${this.config.extensionId}" is a ${enabled.manifest.kind} extension, not a runner`,
      );
    }
    return enabled;
  }

  private executionEnvelope(
    enabled: EnabledExtension,
    execution: RunnerExecutionOptions,
  ): Record<string, unknown> {
    const permissions = enabled.manifest.permissions;
    return {
      timeoutMs: execution.timeoutMs,
      ...(execution.model !== undefined || this.config.model !== undefined
        ? { model: execution.model ?? this.config.model }
        : {}),
      ...(execution.maxTurns !== undefined ? { maxTurns: execution.maxTurns } : {}),
      ...(execution.maxBudgetUsd !== undefined ? { maxBudgetUsd: execution.maxBudgetUsd } : {}),
      // Repository locations cross the boundary only with repository access.
      ...(permissions.repositoryRead || permissions.repositoryWrite
        ? { workspaceRoot: execution.workspaceRoot }
        : {}),
      ...(permissions.repositoryWrite ? { runDir: execution.runDir } : {}),
    };
  }

  async detect(context: RunnerDetectionContext): Promise<RunnerDetectionResult> {
    let enabled: EnabledExtension;
    try {
      enabled = this.resolve();
    } catch (cause) {
      return {
        runner: this.name,
        kind: this.kind,
        status: 'misconfigured',
        authentication: 'unknown',
        capabilities: [],
        diagnostics: [
          {
            severity: 'error',
            code: 'EXTENSION_RUNNER_UNAVAILABLE',
            message: cause instanceof Error ? cause.message : String(cause),
          },
        ],
        category: this.category,
        capabilitySet: capabilitySet([]),
        supportLevel: 'unavailable',
        networkBacked: false,
      };
    }

    try {
      const permissions = enabled.manifest.permissions;
      const outcome = await invokeExtensionOperation(enabled, {
        operation: 'runner.detect',
        payload: {
          ...(context.probeCapabilities !== undefined
            ? { probeCapabilities: context.probeCapabilities }
            : {}),
          ...(context.timeoutMs !== undefined ? { timeoutMs: context.timeoutMs } : {}),
          ...(permissions.repositoryRead || permissions.repositoryWrite
            ? { workspaceRoot: context.workspaceRoot }
            : {}),
        },
        ...(Object.keys(this.config.configuration).length > 0
          ? { configuration: this.config.configuration }
          : {}),
        timeoutMs: context.timeoutMs ?? 30_000,
      });
      const detected = runnerDetectOutputSchema.parse(outcome.output);
      // Detection may downgrade declared capabilities, never add to them.
      const effective = Object.fromEntries(
        Object.entries(this.declaredCapabilities).map(([key, declared]) => [
          key,
          declared && detected.capabilitySet[key as keyof typeof detected.capabilitySet],
        ]),
      ) as RunnerCapabilitySet;
      const status = detected.available
        ? 'available'
        : detected.authentication === 'unauthenticated'
          ? 'unauthenticated'
          : 'unavailable';
      return {
        runner: this.name,
        kind: this.kind,
        status,
        ...(enabled.manifest.entrypoint !== undefined
          ? { executable: enabled.manifest.entrypoint }
          : {}),
        version: enabled.manifest.version,
        authentication: detected.authentication,
        capabilities: [],
        diagnostics: detected.diagnostics.map((diagnostic) => ({
          severity: diagnostic.severity,
          code: diagnostic.code,
          message: diagnostic.message,
        })),
        category: this.category,
        capabilitySet: effective,
        supportLevel: status === 'available' ? this.declaredSupportLevel : 'unavailable',
        networkBacked: detected.networkBacked,
      };
    } catch (cause) {
      return {
        runner: this.name,
        kind: this.kind,
        status: 'error',
        version: enabled.manifest.version,
        authentication: 'unknown',
        capabilities: [],
        diagnostics: [
          {
            severity: 'error',
            code: 'EXTENSION_RUNNER_DETECT_FAILED',
            message: cause instanceof Error ? cause.message : String(cause),
          },
        ],
        category: this.category,
        capabilitySet: capabilitySet([]),
        supportLevel: 'unavailable',
        networkBacked: false,
      };
    }
  }

  async generateStage(
    input: StageGenerationInput,
    execution: RunnerExecutionOptions,
  ): Promise<StageGenerationResult> {
    const startedAt = Date.now();
    try {
      const enabled = this.resolve();
      const operation =
        input.intent === 'refine' &&
        enabled.manifest.capabilities.operations.includes('runner.refineStage')
          ? 'runner.refineStage'
          : 'runner.generateStage';
      const outcome = await invokeExtensionOperation(enabled, {
        operation,
        payload: {
          specName: input.specName,
          stage: input.stage,
          intent: input.intent,
          prompt: input.prompt,
          promptVersion: input.promptVersion,
          toolPolicy: input.toolPolicy,
          ...(input.correction !== undefined ? { correction: input.correction } : {}),
          execution: this.executionEnvelope(enabled, execution),
        },
        ...(Object.keys(this.config.configuration).length > 0
          ? { configuration: this.config.configuration }
          : {}),
        timeoutMs: execution.timeoutMs,
        ...(execution.signal !== undefined ? { signal: execution.signal } : {}),
      });
      const output = runnerStageOutputSchema.parse(outcome.output);
      return this.stageResult(output, Date.now() - startedAt);
    } catch (cause) {
      return {
        runner: this.name,
        outcome: failureOutcome(cause),
        failureReason: cause instanceof Error ? cause.message : String(cause),
        rawStdout: '',
        rawStderr: '',
        durationMs: Date.now() - startedAt,
        warnings: [],
        error: failureError(cause),
      };
    }
  }

  private stageResult(output: RunnerStageOutput, durationMs: number): StageGenerationResult {
    const usage = usageFrom(output, durationMs);
    const cost = costFrom(output);
    let report: StageRunnerReport | undefined;
    const warnings = [...output.warnings];
    let invalidStructuredOutput = output.invalidStructuredOutput;
    if (output.report !== undefined) {
      const parsed = parseStageRunnerReport(JSON.stringify(output.report));
      if (parsed.ok) {
        report = parsed.report;
      } else {
        warnings.push(`extension stage report failed validation: ${parsed.reason}`);
        invalidStructuredOutput = invalidStructuredOutput ?? JSON.stringify(output.report);
      }
    }
    return {
      runner: this.name,
      outcome: output.outcome,
      ...(output.failureReason !== undefined ? { failureReason: output.failureReason } : {}),
      rawStdout: output.rawStdout,
      rawStderr: output.rawStderr,
      ...(output.sessionId !== undefined ? { sessionId: output.sessionId } : {}),
      durationMs,
      warnings,
      ...(report !== undefined ? { report } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(cost !== undefined ? { cost } : {}),
      ...(invalidStructuredOutput !== undefined ? { invalidStructuredOutput } : {}),
    };
  }

  async executeTask(
    input: TaskExecutionInput,
    execution: RunnerExecutionOptions,
  ): Promise<TaskExecutionResult> {
    return this.runTaskOperation('runner.executeTask', input, execution);
  }

  async resumeTask(
    input: TaskResumeInput,
    execution: RunnerExecutionOptions,
  ): Promise<TaskExecutionResult> {
    return this.runTaskOperation('runner.resumeTask', input, execution);
  }

  private async runTaskOperation(
    operation: 'runner.executeTask' | 'runner.resumeTask',
    input: TaskExecutionInput | TaskResumeInput,
    execution: RunnerExecutionOptions,
  ): Promise<TaskExecutionResult> {
    const startedAt = Date.now();
    try {
      const enabled = this.resolve();
      const outcome = await invokeExtensionOperation(enabled, {
        operation,
        payload: {
          specName: input.specName,
          taskId: input.taskId,
          prompt: input.prompt,
          promptVersion: input.promptVersion,
          toolPolicy: input.toolPolicy,
          ...('sessionId' in input && input.sessionId !== undefined
            ? { sessionId: input.sessionId }
            : {}),
          execution: this.executionEnvelope(enabled, execution),
        },
        ...(Object.keys(this.config.configuration).length > 0
          ? { configuration: this.config.configuration }
          : {}),
        timeoutMs: execution.timeoutMs,
        ...(execution.signal !== undefined ? { signal: execution.signal } : {}),
      });
      const output = runnerTaskOutputSchema.parse(outcome.output);
      const durationMs = Date.now() - startedAt;
      const usage = usageFrom(output, durationMs);
      const cost = costFrom(output);
      let report: TaskRunnerReport | undefined;
      const warnings = [...output.warnings];
      let invalidStructuredOutput = output.invalidStructuredOutput;
      if (output.report !== undefined) {
        const parsed = parseTaskRunnerReport(JSON.stringify(output.report));
        if (parsed.ok) {
          report = parsed.report;
        } else {
          warnings.push(`extension task report failed validation: ${parsed.reason}`);
          invalidStructuredOutput = invalidStructuredOutput ?? JSON.stringify(output.report);
        }
      }
      return {
        runner: this.name,
        outcome: output.outcome,
        ...(output.failureReason !== undefined ? { failureReason: output.failureReason } : {}),
        rawStdout: output.rawStdout,
        rawStderr: output.rawStderr,
        ...(output.sessionId !== undefined ? { sessionId: output.sessionId } : {}),
        durationMs,
        warnings,
        ...(report !== undefined ? { report } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(cost !== undefined ? { cost } : {}),
        ...(invalidStructuredOutput !== undefined ? { invalidStructuredOutput } : {}),
        resumeSupported: output.resumeSupported,
      };
    } catch (cause) {
      return {
        runner: this.name,
        outcome: failureOutcome(cause),
        failureReason: cause instanceof Error ? cause.message : String(cause),
        rawStdout: '',
        rawStderr: '',
        durationMs: Date.now() - startedAt,
        warnings: [],
        error: failureError(cause),
        resumeSupported: false,
      };
    }
  }

  async listModels(context: RunnerDetectionContext): Promise<RunnerModelListResult> {
    try {
      const enabled = this.resolve();
      if (!enabled.manifest.capabilities.operations.includes('runner.listModels')) {
        return {
          supported: false,
          models: [],
          detail: 'this runner extension does not declare model listing',
        };
      }
      const outcome = await invokeExtensionOperation(enabled, {
        operation: 'runner.listModels',
        payload: {},
        timeoutMs: context.timeoutMs ?? 30_000,
      });
      const output = runnerModelListOutputSchema.parse(outcome.output);
      return {
        supported: output.supported,
        models: output.models.map((model) => ({
          name: model.name,
          ...(model.sizeBytes !== undefined ? { sizeBytes: model.sizeBytes } : {}),
          ...(model.family !== undefined ? { family: model.family } : {}),
          ...(model.parameterSize !== undefined ? { parameterSize: model.parameterSize } : {}),
          ...(model.quantization !== undefined ? { quantization: model.quantization } : {}),
          ...(model.modifiedAt !== undefined ? { modifiedAt: model.modifiedAt } : {}),
          ...(model.location !== undefined ? { location: model.location } : {}),
        })),
        ...(output.detail !== undefined ? { detail: output.detail } : {}),
      };
    } catch (cause) {
      return {
        supported: false,
        models: [],
        detail: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  executionBoundaryNote(): string {
    return (
      'Runner extension: executes out of process behind the versioned extension protocol; ' +
      'its report is a claim — git evidence, verification, and protected-path checks remain authoritative.'
    );
  }
}

/** Factory in the shape `createDefaultRunnerRegistry` expects. */
export function createExtensionRunnerFactory(
  workspace: WorkspaceInfo,
): (config: ExtensionRunnerProfileConfig) => AgentRunner {
  return (config) => new ExtensionRunnerProxy(workspace, config);
}
