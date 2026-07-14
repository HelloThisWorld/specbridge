import type { StageGenerationResult, TaskExecutionResult } from '../contract.js';
import type { RunnerCategory, RunnerSupportLevel } from './capabilities.js';
import type { RunnerOperation } from './operations.js';
import type { NormalizedExecutionOutcome, NormalizedExecutionResult } from './result.js';
import { NORMALIZED_RESULT_SCHEMA_VERSION, normalizedExecutionResultSchema } from './result.js';
import { emptyUsage, unavailableCost } from './usage.js';

/**
 * Compose the shared, validated NormalizedExecutionResult from a raw runner
 * result. This is the ONLY path provider output takes into orchestration
 * artifacts — reported files/commands/tests stay clearly labeled claims.
 */

export interface NormalizeResultContext {
  profile: string;
  category: RunnerCategory;
  supportLevel: RunnerSupportLevel;
  operation: RunnerOperation;
}

function normalizedOutcome(
  result: StageGenerationResult | TaskExecutionResult,
): NormalizedExecutionOutcome {
  switch (result.error?.code) {
    case 'authentication_required':
      return 'authentication-required';
    case 'quota_exceeded':
      return 'quota-exceeded';
    case 'rate_limited':
      return 'rate-limited';
    case 'executable_not_found':
    case 'endpoint_unreachable':
      return 'unavailable';
    case 'runner_incompatible':
      return 'incompatible';
    default:
      return result.outcome;
  }
}

export function composeNormalizedResult(
  context: NormalizeResultContext,
  result: StageGenerationResult | TaskExecutionResult,
): NormalizedExecutionResult {
  const report = result.report;
  const taskReport =
    report !== undefined && 'changedFiles' in report ? report : undefined;
  const stageReport =
    report !== undefined && 'markdown' in report ? report : undefined;
  return normalizedExecutionResultSchema.parse({
    schemaVersion: NORMALIZED_RESULT_SCHEMA_VERSION,
    runner: result.runner,
    profile: context.profile,
    category: context.category,
    supportLevel: context.supportLevel,
    operation: context.operation,
    outcome: normalizedOutcome(result),
    summary: report?.summary ?? result.failureReason ?? '',
    ...(result.sessionId !== undefined ? { providerSessionId: result.sessionId } : {}),
    reportedChangedFiles: taskReport?.changedFiles ?? [],
    reportedCommands: taskReport?.commandsReported ?? [],
    reportedTests: (taskReport?.testsReported ?? []).map((test) => ({
      name: test.name,
      status: test.status,
    })),
    blockingQuestions: taskReport?.blockingQuestions ?? stageReport?.openQuestions ?? [],
    remainingRisks: taskReport?.remainingRisks ?? [],
    usage: result.usage ?? emptyUsage(result.durationMs),
    cost: result.cost ?? unavailableCost(),
    ...(result.error !== undefined ? { error: result.error } : {}),
    warnings: result.warnings,
  });
}
