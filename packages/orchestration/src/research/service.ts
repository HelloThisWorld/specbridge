import type { AgentConfig, ResearchPolicy, WorkspaceInfo } from '@specbridge/core';
import type {
  ResearchBridge,
  ResearchExecutionResult,
  ResearchFailure,
  ResearchGateInput,
  ResearchGateResult,
  ResearchProviderHealth,
  ResearchRecord,
  ResearchRequest,
} from './contracts.js';
import {
  RESEARCH_RECORD_SCHEMA_VERSION,
  researchReportSchema,
  researchRequestSchema,
} from './contracts.js';
import { DeerFlowResearchBridge } from './deerflow.js';
import { evaluateResearchGate } from './gate.js';
import { findResearchReuse, normalizedQuestionHash, researchRequestHash } from './reuse.js';
import { listResearchRecords, writeResearchRecord } from './store.js';
import {
  recordResearchBudgetRefusalTelemetry,
  recordResearchGateTelemetry,
  recordResearchProviderTelemetry,
  recordResearchReuseTelemetry,
} from './telemetry.js';

export interface ResearchServiceDeps {
  workspace: WorkspaceInfo;
  config: AgentConfig | { research: ResearchPolicy };
  clock?: () => Date;
  bridge?: ResearchBridge;
}

export interface ResearchScope {
  operationId?: string;
  jobId?: string;
}

function nowOf(deps: ResearchServiceDeps): Date {
  return deps.clock?.() ?? new Date();
}

function failure(
  classification: ResearchFailure['classification'],
  failureSource: ResearchFailure['failureSource'],
  message: string,
  retryable = false,
): ResearchFailure {
  return { classification, failureSource, message, retryable };
}

function selectedBridge(deps: ResearchServiceDeps): ResearchBridge | undefined {
  if (deps.bridge !== undefined) return deps.bridge;
  if (deps.config.research.provider === 'deerflow') {
    return new DeerFlowResearchBridge(deps.config.research.providers.deerflow, {
      clock: () => nowOf(deps),
    });
  }
  return undefined;
}

function providerEnabled(policy: ResearchPolicy): boolean {
  if (policy.provider === 'deerflow') return policy.providers.deerflow.enabled;
  return false;
}

function countedRecords(records: readonly ResearchRecord[]): ResearchRecord[] {
  return records.filter((record) => record.status !== 'PENDING');
}

function budgetFailure(
  policy: ResearchPolicy,
  records: readonly ResearchRecord[],
  request: ResearchRequest,
  scope: ResearchScope,
): ResearchFailure | undefined {
  const counted = countedRecords(records);
  if (scope.operationId !== undefined) {
    const matching = counted.filter((record) => record.scope?.operationId === scope.operationId);
    const used = matching.filter((record) => record.depth === request.depth).length;
    const limit =
      request.depth === 'QUICK' ? policy.maxQuickPerOperation : policy.maxDeepPerOperation;
    if (used >= limit) {
      return failure(
        'BUDGET_EXHAUSTED',
        'BUDGET',
        `${request.depth} research budget exhausted for operation ${scope.operationId} (${used}/${limit}); provider was not called.`,
      );
    }
  }
  if (scope.jobId !== undefined) {
    const used = counted.filter((record) => record.scope?.jobId === scope.jobId).length;
    if (used >= policy.maxResearchPerJob) {
      return failure(
        'BUDGET_EXHAUSTED',
        'BUDGET',
        `research budget exhausted for job ${scope.jobId} (${used}/${policy.maxResearchPerJob}); provider was not called.`,
      );
    }
  }
  return undefined;
}

/** Gate evaluation plus durable aggregate telemetry; no provider is contacted. */
export function evaluateAndRecordResearchGate(
  deps: ResearchServiceDeps,
  input: ResearchGateInput,
): ResearchGateResult {
  const result = evaluateResearchGate(input);
  recordResearchGateTelemetry(deps.workspace, result.decision, nowOf(deps));
  return result;
}

export async function getResearchProviderHealth(
  deps: ResearchServiceDeps,
  signal?: AbortSignal,
): Promise<ResearchProviderHealth> {
  const now = nowOf(deps).toISOString();
  const policy = deps.config.research;
  if (!policy.enabled) {
    return {
      provider: policy.provider,
      status: 'UNKNOWN',
      checkedAt: now,
      detail: 'research is disabled; no provider health request was made',
    };
  }
  if (!providerEnabled(policy)) {
    return {
      provider: policy.provider,
      status: 'UNKNOWN',
      checkedAt: now,
      detail: 'the selected research provider is disabled; no health request was made',
    };
  }
  const bridge = selectedBridge(deps);
  if (bridge === undefined || bridge.providerId() !== policy.provider) {
    return {
      provider: policy.provider,
      status: 'UNKNOWN',
      checkedAt: now,
      detail: `no ResearchBridge is registered for provider ${policy.provider}`,
    };
  }
  return bridge.health(signal);
}

/**
 * Execute one explicit research request. This function has no Mission,
 * Contract, approval, WorkUnit, Completion Oracle, or closure dependency;
 * its only durable mutation is a ResearchRecord plus diagnostic telemetry.
 */
export async function startResearch(
  deps: ResearchServiceDeps,
  raw: ResearchRequest,
  scope: ResearchScope = {},
  signal?: AbortSignal,
): Promise<ResearchExecutionResult> {
  const request = researchRequestSchema.parse(raw);
  const policy = deps.config.research;
  const existing = listResearchRecords(deps.workspace).records;
  const reuse = findResearchReuse(existing, request);
  if (reuse.exact?.report !== undefined) {
    recordResearchReuseTelemetry(deps.workspace, nowOf(deps));
    return { ok: true, reused: true, record: reuse.exact, report: reuse.exact.report };
  }
  if (existing.some((record) => record.researchId === request.researchId)) {
    return {
      ok: false,
      failure: failure(
        'INVALID_REQUEST',
        'UNKNOWN',
        `research id ${request.researchId} already belongs to a different request; choose a new id`,
      ),
    };
  }

  if (!policy.enabled) {
    return { ok: false, failure: failure('DISABLED', 'AUTHORIZATION', 'research is disabled by configuration') };
  }
  if (!providerEnabled(policy)) {
    return {
      ok: false,
      failure: failure('PROVIDER_UNAVAILABLE', 'PROVIDER', `research provider ${policy.provider} is disabled`),
    };
  }
  const refused = budgetFailure(policy, existing, request, scope);
  if (refused !== undefined) {
    recordResearchBudgetRefusalTelemetry(deps.workspace, nowOf(deps));
    return { ok: false, failure: refused };
  }
  const bridge = selectedBridge(deps);
  if (bridge === undefined || bridge.providerId() !== policy.provider) {
    return {
      ok: false,
      failure: failure(
        'PROVIDER_UNAVAILABLE',
        'PROVIDER',
        `no ResearchBridge is registered for provider ${policy.provider}`,
      ),
    };
  }

  const createdAt = nowOf(deps).toISOString();
  const baseRecord: ResearchRecord = {
    schemaVersion: RESEARCH_RECORD_SCHEMA_VERSION,
    researchId: request.researchId,
    provider: bridge.providerId(),
    depth: request.depth,
    status: 'RUNNING',
    requestHash: researchRequestHash(request),
    normalizedQuestionHash: normalizedQuestionHash(request.question),
    topicTags: request.topicTags,
    request,
    ...(scope.operationId !== undefined || scope.jobId !== undefined
      ? {
          scope: {
            ...(scope.operationId !== undefined ? { operationId: scope.operationId } : {}),
            ...(scope.jobId !== undefined ? { jobId: scope.jobId } : {}),
          },
        }
      : {}),
    createdAt,
    updatedAt: createdAt,
  };
  writeResearchRecord(deps.workspace, baseRecord);

  const started = Date.now();
  let providerResult = await bridge.investigate(request, signal);
  if (providerResult.ok) {
    const checked = researchReportSchema.safeParse(providerResult.report);
    if (
      !checked.success ||
      checked.data.researchId !== request.researchId ||
      checked.data.provider !== bridge.providerId() ||
      checked.data.depth !== request.depth ||
      checked.data.question !== request.question
    ) {
      providerResult = {
        ok: false,
        failure: failure(
          'MALFORMED_RESPONSE',
          'PROVIDER',
          'the research provider returned a report with invalid or mismatched control-plane identity',
        ),
        ...(providerResult.providerRefs !== undefined
          ? { providerRefs: providerResult.providerRefs }
          : {}),
      };
    }
  }
  const completed = nowOf(deps);
  recordResearchProviderTelemetry(
    deps.workspace,
    providerResult,
    Math.max(0, Date.now() - started),
    completed,
  );

  if (!providerResult.ok) {
    const record = writeResearchRecord(deps.workspace, {
      ...baseRecord,
      status: providerResult.failure.classification === 'CANCELLED' ? 'CANCELLED' : 'FAILED',
      failure: providerResult.failure,
      ...(providerResult.providerRefs !== undefined
        ? { providerRefs: providerResult.providerRefs }
        : {}),
      updatedAt: completed.toISOString(),
    });
    return { ok: false, failure: providerResult.failure, record };
  }

  const record = writeResearchRecord(deps.workspace, {
    ...baseRecord,
    status: providerResult.report.status === 'COMPLETED' ? 'COMPLETED' : 'INCONCLUSIVE',
    report: providerResult.report,
    ...(providerResult.providerRefs !== undefined ? { providerRefs: providerResult.providerRefs } : {}),
    ...(providerResult.report.usage !== undefined ? { usage: providerResult.report.usage } : {}),
    updatedAt: completed.toISOString(),
  });
  return { ok: true, reused: false, record, report: providerResult.report };
}
