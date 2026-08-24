import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ToolsmithCapability, WorkspaceInfo } from '@specbridge/core';
import { assertInsideWorkspace } from '@specbridge/core';
import { recordJobEvent } from '@specbridge/orchestration';
import { AutonomyError } from '../errors.js';
import type { AutonomyDeps } from '../deps.js';
import { autonomyPolicyOf, jobDepsOf, newRecordId, nowIso } from '../deps.js';
import {
  assertAutonomyId,
  autonomyPath,
  listJsonRecords,
  readJsonRecord,
  writeJsonRecord,
} from '../store.js';
import type { ToolInstallScope } from '../vocabulary.js';
import type { BrokerDecision } from './broker.js';
import { decideToolsmithRequest, preferredScopeFor } from './broker.js';
import type { ToolsmithLedger, ToolsmithRequest } from './state.js';
import { TOOLSMITH_SCHEMA_VERSION, toolsmithLedgerSchema, toolsmithRequestSchema } from './state.js';

/**
 * The Toolsmith service: request, decide, apply, record.
 *
 * The APPLY step is deliberately narrow. This service performs exactly one
 * kind of action itself — writing a project-local file — and hands everything
 * else to an injected `ToolsmithExecutor`. That split is not squeamishness;
 * it is where the safety lives. Installing a package, pulling an image, and
 * downloading a browser are process invocations with wildly different shapes,
 * and burying them in a service that also owns the ledger would make the
 * ledger's honesty depend on getting all three right.
 *
 * So: the broker decides, the ledger records, and the executor does. A
 * workspace with no executor still gets grants and still gets an accurate
 * record of what was granted and that nothing was applied — which is exactly
 * what an offline certification needs to assert against.
 */

export interface ToolsmithExecutor {
  readonly label: string;
  /**
   * Perform one granted action. Returns what it produced, or throws for a
   * genuine failure — the service records FAILED and the caller decides
   * whether to try a different route.
   */
  apply(input: {
    capability: ToolsmithCapability;
    target: string;
    scope: ToolInstallScope;
    workspaceRoot: string;
    timeoutMs: number;
  }): Promise<{ outcome: string; bytes?: number | null; createdPaths?: string[] }>;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function toolsmithDir(workspace: WorkspaceInfo, jobId: string): string {
  assertAutonomyId('job', jobId);
  return autonomyPath(workspace, 'toolsmith', jobId);
}

function requestFile(workspace: WorkspaceInfo, jobId: string, requestId: string): string {
  assertAutonomyId('toolsmith request', requestId);
  return autonomyPath(workspace, 'toolsmith', jobId, `${requestId}.json`);
}

function ledgerFile(workspace: WorkspaceInfo, jobId: string): string {
  return autonomyPath(workspace, 'toolsmith', jobId, 'ledger.json');
}

export function readToolsmithLedger(
  workspace: WorkspaceInfo,
  jobId: string,
): ToolsmithLedger | undefined {
  return readJsonRecord(ledgerFile(workspace, jobId), (raw) => toolsmithLedgerSchema.parse(raw));
}

export function listToolsmithRequests(
  workspace: WorkspaceInfo,
  jobId: string,
): ToolsmithRequest[] {
  return listJsonRecords(toolsmithDir(workspace, jobId), (raw) =>
    toolsmithRequestSchema.parse(raw),
  ).sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

// ---------------------------------------------------------------------------
// Requesting
// ---------------------------------------------------------------------------

export interface ToolsmithRequestInput {
  jobId: string;
  capability: ToolsmithCapability;
  target: string;
  purpose: string;
  scope?: ToolInstallScope | undefined;
  nodeId?: string | undefined;
  estimatedBytes?: number | null | undefined;
  /** Explicit id (deterministic tests). */
  requestId?: string | undefined;
}

export interface ToolsmithDecisionResult {
  request: ToolsmithRequest;
  decision: BrokerDecision;
}

/**
 * Ask the broker for a capability and record the answer.
 *
 * Records a DENIED request as durably as a granted one. A denial is the
 * interesting record: it is the moment the runtime wanted something and did
 * not take it, and an operator reading the morning report needs to see that
 * as clearly as they see what was installed.
 */
export function requestToolsmithCapability(
  deps: AutonomyDeps,
  input: ToolsmithRequestInput,
): ToolsmithDecisionResult {
  const policy = autonomyPolicyOf(deps);
  const ledger = loadLedger(deps, input.jobId);
  const scope = input.scope ?? preferredScopeFor(input.capability);
  const decision = decideToolsmithRequest(
    {
      capability: input.capability,
      target: input.target,
      scope,
      purpose: input.purpose,
      estimatedBytes: input.estimatedBytes ?? null,
    },
    {
      policy,
      workspaceRoot: deps.workspace.rootDir,
      protectedPaths: deps.config.execution.protectedPaths,
      grantsUsed: ledger.granted,
    },
  );

  const at = nowIso(deps);
  const request = toolsmithRequestSchema.parse({
    schemaVersion: TOOLSMITH_SCHEMA_VERSION,
    requestId: input.requestId ?? newRecordId(deps, 'ts'),
    jobId: input.jobId,
    capability: input.capability,
    purpose: input.purpose.slice(0, 4_000),
    target: input.target.slice(0, 200),
    scope: decision.granted ? decision.scope : scope,
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    requestedAt: at,
    status: decision.granted ? 'GRANTED' : 'DENIED',
    decidedAt: at,
    ...(decision.granted
      ? {}
      : {
          denialReason: decision.reason,
          denialDetail: decision.detail,
          ...(decision.suggestedAlternative !== undefined
            ? { suggestedAlternative: decision.suggestedAlternative }
            : {}),
        }),
  });

  writeJsonRecord(requestFile(deps.workspace, input.jobId, request.requestId), request);
  saveLedger(deps, input.jobId, {
    ...ledger,
    granted: ledger.granted + (decision.granted ? 1 : 0),
    denied: ledger.denied + (decision.granted ? 0 : 1),
  });
  recordToolsmithEvent(deps, input.jobId, request, decision);
  return { request, decision };
}

function recordToolsmithEvent(
  deps: AutonomyDeps,
  jobId: string,
  request: ToolsmithRequest,
  decision: BrokerDecision,
): void {
  try {
    recordJobEvent(
      jobDepsOf(deps),
      jobId,
      decision.granted ? 'toolsmith_grant_issued' : 'toolsmith_grant_denied',
      {
        requestId: request.requestId,
        capability: request.capability,
        target: request.target,
        scope: request.scope,
        ...(decision.granted ? {} : { reason: decision.reason }),
      },
    );
  } catch {
    // A Toolsmith request may legitimately be made for a job that does not
    // exist yet (preflight, certification fixtures). The ledger is the
    // authority; the job timeline is a convenience.
  }
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/**
 * Apply a granted request.
 *
 * `PROJECT_LOCAL_SCRIPT` and `CODE_GENERATION` are handled here because they
 * are pure file writes inside the workspace and the boundary check has
 * already happened; anything that touches a package manager, a registry, or
 * a container daemon needs the executor.
 */
export async function applyToolsmithGrant(
  deps: AutonomyDeps,
  input: {
    jobId: string;
    requestId: string;
    /** File content, for the capabilities this service writes itself. */
    content?: string | undefined;
    executor?: ToolsmithExecutor | undefined;
  },
): Promise<ToolsmithRequest> {
  const existing = readJsonRecord(
    requestFile(deps.workspace, input.jobId, input.requestId),
    (raw) => toolsmithRequestSchema.parse(raw),
  );
  if (existing === undefined) {
    throw new AutonomyError('SBA024', `No Toolsmith request "${input.requestId}" exists.`, {
      details: { jobId: input.jobId, requestId: input.requestId },
    });
  }
  if (existing.status !== 'GRANTED') {
    throw new AutonomyError(
      'SBA012',
      `Toolsmith request ${input.requestId} is ${existing.status}; only a GRANTED request may be applied.`,
      {
        remediation:
          existing.suggestedAlternative !== undefined
            ? [existing.suggestedAlternative]
            : ['Request the capability again with a target the policy allows.'],
      },
    );
  }

  const ledger = loadLedger(deps, input.jobId);
  const policy = autonomyPolicyOf(deps).toolsmith;
  try {
    const result =
      writesFileDirectly(existing.capability) && input.content !== undefined
        ? writeProjectFile(deps.workspace, existing.target, input.content)
        : await requireExecutor(input.executor).apply({
            capability: existing.capability as ToolsmithCapability,
            target: existing.target,
            scope: existing.scope,
            workspaceRoot: deps.workspace.rootDir,
            timeoutMs: policy.timeoutMs,
          });
    const applied = toolsmithRequestSchema.parse({
      ...existing,
      status: 'APPLIED',
      appliedAt: nowIso(deps),
      outcome: result.outcome.slice(0, 4_000),
      bytes: result.bytes ?? null,
      createdPaths: (result.createdPaths ?? []).slice(0, 50),
    });
    writeJsonRecord(requestFile(deps.workspace, input.jobId, applied.requestId), applied);
    saveLedger(deps, input.jobId, {
      ...ledger,
      applied: ledger.applied + 1,
      bytesFetched: ledger.bytesFetched + (result.bytes ?? 0),
    });
    return applied;
  } catch (cause) {
    const failed = toolsmithRequestSchema.parse({
      ...existing,
      status: 'FAILED',
      appliedAt: nowIso(deps),
      outcome: (cause instanceof Error ? cause.message : String(cause)).slice(0, 4_000),
    });
    writeJsonRecord(requestFile(deps.workspace, input.jobId, failed.requestId), failed);
    saveLedger(deps, input.jobId, { ...ledger, failed: ledger.failed + 1 });
    return failed;
  }
}

function writesFileDirectly(capability: string): boolean {
  return capability === 'PROJECT_LOCAL_SCRIPT' || capability === 'CODE_GENERATION';
}

function requireExecutor(executor: ToolsmithExecutor | undefined): ToolsmithExecutor {
  if (executor !== undefined) return executor;
  throw new AutonomyError(
    'SBA012',
    'This capability needs a Toolsmith executor and none is configured in this process.',
    {
      remediation: [
        'Run the grant from a context with an executor (the driver supplies one), or apply a ' +
          'capability this service writes itself.',
      ],
    },
  );
}

function writeProjectFile(
  workspace: WorkspaceInfo,
  relativeTarget: string,
  content: string,
): { outcome: string; bytes: number; createdPaths: string[] } {
  const absolute = assertInsideWorkspace(
    workspace.rootDir,
    path.resolve(workspace.rootDir, relativeTarget),
  );
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
  return {
    outcome: `wrote ${relativeTarget} (${Buffer.byteLength(content, 'utf8')} bytes)`,
    bytes: Buffer.byteLength(content, 'utf8'),
    createdPaths: [relativeTarget],
  };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

function loadLedger(deps: AutonomyDeps, jobId: string): ToolsmithLedger {
  return (
    readToolsmithLedger(deps.workspace, jobId) ??
    toolsmithLedgerSchema.parse({
      schemaVersion: TOOLSMITH_SCHEMA_VERSION,
      jobId,
      updatedAt: nowIso(deps),
    })
  );
}

function saveLedger(deps: AutonomyDeps, jobId: string, ledger: ToolsmithLedger): ToolsmithLedger {
  const next = toolsmithLedgerSchema.parse({ ...ledger, updatedAt: nowIso(deps) });
  writeJsonRecord(ledgerFile(deps.workspace, jobId), next);
  return next;
}

/**
 * How many tools this job created for itself.
 *
 * Reported in the autonomy telemetry as `selfCreatedTools`, and deliberately
 * counting APPLIED rather than GRANTED: a grant that was never used did not
 * create a tool, and the morning report should say what exists.
 */
export function countSelfCreatedTools(workspace: WorkspaceInfo, jobId: string): number {
  return listToolsmithRequests(workspace, jobId).filter(
    (request) => request.status === 'APPLIED' && writesFileDirectly(request.capability),
  ).length;
}
