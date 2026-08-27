import type { WorkspaceInfo } from '@specbridge/core';
import { readContractRegistry, requireMissionState } from '@specbridge/mission';
import {
  acceptanceForObjective,
  contractsForObjective,
  readGraphRevision,
  recordJobEvent,
  requireJobState,
} from '@specbridge/orchestration';
import { AutonomyError } from '../errors.js';
import type { AutonomyDeps } from '../deps.js';
import { autonomyPolicyOf, jobDepsOf, newRecordId, now, nowIso } from '../deps.js';
import {
  assertAutonomyId,
  autonomyPath,
  listJsonRecords,
  readJsonRecord,
  writeJsonRecord,
} from '../store.js';
import type { MissionSeal } from '../seal/state.js';
import { latestExecutableSeal } from '../seal/service.js';
import type { ClosureEvidenceKind, ClosureGapKind, ClosurePhase } from '../vocabulary.js';
import type {
  ClosureAudit,
  ClosureEntry,
  ClosureLedger,
  GapWorkItem,
} from './state.js';
import {
  CLOSURE_SCHEMA_VERSION,
  closureAuditSchema,
  closureLedgerSchema,
  gapWorkItemSchema,
} from './state.js';
import {
  assessItemClosure,
  closingEvidenceForGap,
  closureRatio,
  decideClosure,
  missionMayComplete,
  summarizeClosure,
} from './oracle.js';

/**
 * The closure service: build the ledger, register evidence, audit, generate
 * gap work.
 *
 * The ledger is built ONCE from the seal and then only ever gains evidence
 * and attribution. It is never rebuilt from live mission state mid-run, and
 * that is deliberate: a mission whose contracts keep evolving must not
 * silently change what a running job is being judged against. A genuinely
 * changed contract is a new seal, which is a human decision.
 */

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function closureLedgerFile(workspace: WorkspaceInfo, jobId: string): string {
  assertAutonomyId('job', jobId);
  return autonomyPath(workspace, 'closure', jobId, 'ledger.json');
}

export function closureAuditsDir(workspace: WorkspaceInfo, jobId: string): string {
  assertAutonomyId('job', jobId);
  return autonomyPath(workspace, 'closure', jobId, 'audits');
}

export function gapWorkDir(workspace: WorkspaceInfo, jobId: string): string {
  assertAutonomyId('job', jobId);
  return autonomyPath(workspace, 'closure', jobId, 'gaps');
}

export function readClosureLedger(
  workspace: WorkspaceInfo,
  jobId: string,
): ClosureLedger | undefined {
  return readJsonRecord(closureLedgerFile(workspace, jobId), (raw) =>
    closureLedgerSchema.parse(raw),
  );
}

export function listClosureAudits(workspace: WorkspaceInfo, jobId: string): ClosureAudit[] {
  return listJsonRecords(closureAuditsDir(workspace, jobId), (raw) =>
    closureAuditSchema.parse(raw),
  ).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function listGapWork(workspace: WorkspaceInfo, jobId: string): GapWorkItem[] {
  return listJsonRecords(gapWorkDir(workspace, jobId), (raw) => gapWorkItemSchema.parse(raw));
}

// ---------------------------------------------------------------------------
// Building the ledger
// ---------------------------------------------------------------------------

/**
 * Build the closure ledger from a sealed intent.
 *
 * Every sealed requirement, invariant, and acceptance criterion becomes one
 * entry. Nothing is filtered, summarized, or grouped: an item that made it
 * into the seal is an item a human approved, and the whole value of this
 * ledger is that it is exhaustive over exactly that set.
 *
 * The `impliesSystemScenario` / `impliesBrowserScenario` flags are copied
 * from the seal, where they were computed deterministically at seal time
 * from text the human wrote. Copying them here freezes them: no agent later
 * in the run can decide the browser scenario was optional.
 */
export function buildClosureLedger(
  deps: AutonomyDeps,
  input: { jobId: string; seal: MissionSeal },
): ClosureLedger {
  const at = nowIso(deps);
  const entries: ClosureEntry[] = [];

  // Contract requirements and invariants carry their statements in the
  // mission registry rather than in the seal (the seal pins ids and
  // revisions). Reading them here keeps the ledger readable without
  // duplicating contract text into the authorization record.
  const registry = readContractRegistry(deps.workspace, input.seal.missionId);
  const byContract = new Map(registry.map((contract) => [contract.contractId, contract]));

  for (const ref of input.seal.contracts) {
    const contract = byContract.get(ref.contractId);
    for (const requirementId of ref.requirementIds) {
      const statement =
        contract?.requirements.find((r) => r.requirementId === requirementId)?.statement ??
        `${ref.contractId} requirement ${requirementId}`;
      entries.push(
        entry(at, {
          itemId: `${ref.contractId}/${requirementId}`,
          kind: 'requirement',
          statement,
          contractId: ref.contractId,
        }),
      );
    }
    for (const invariantId of ref.invariantIds) {
      const statement =
        contract?.invariants.find((i) => i.invariantId === invariantId)?.statement ??
        `${ref.contractId} invariant ${invariantId}`;
      entries.push(
        entry(at, {
          itemId: `${ref.contractId}#${invariantId}`,
          kind: 'invariant',
          statement,
          contractId: ref.contractId,
        }),
      );
    }
  }

  for (const criterion of input.seal.acceptanceCriteria) {
    entries.push(
      entry(at, {
        itemId: criterion.criterionId,
        kind: 'acceptance-criterion',
        statement: criterion.statement,
        requiresSystemScenario: criterion.impliesSystemScenario,
        requiresBrowserScenario: criterion.impliesBrowserScenario,
      }),
    );
  }

  const ledger = closureLedgerSchema.parse({
    schemaVersion: CLOSURE_SCHEMA_VERSION,
    jobId: input.jobId,
    sealId: input.seal.sealId,
    missionId: input.seal.missionId,
    createdAt: at,
    updatedAt: at,
    phase: 'IMPLEMENTATION',
    entries,
  });
  writeJsonRecord(closureLedgerFile(deps.workspace, input.jobId), ledger);
  return ledger;
}

function entry(
  at: string,
  input: {
    itemId: string;
    kind: ClosureEntry['kind'];
    statement: string;
    contractId?: string;
    requiresSystemScenario?: boolean;
    requiresBrowserScenario?: boolean;
  },
): ClosureEntry {
  return {
    itemId: input.itemId,
    kind: input.kind,
    statement: input.statement.slice(0, 4_000),
    ...(input.contractId !== undefined ? { contractId: input.contractId } : {}),
    status: 'NOT_STARTED',
    attributedNodeIds: [],
    attributedTaskIds: [],
    evidence: [],
    requiresSystemScenario: input.requiresSystemScenario ?? false,
    requiresBrowserScenario: input.requiresBrowserScenario ?? false,
    gaps: ['NO_IMPLEMENTATION'],
    updatedAt: at,
  };
}

// ---------------------------------------------------------------------------
// Attribution and evidence
// ---------------------------------------------------------------------------

/**
 * Record that a job node claims to implement one or more contract items.
 *
 * Attribution is a CLAIM, not evidence: it moves an item from NOT_STARTED to
 * IN_PROGRESS or IMPLEMENTED and no further. Something has to demonstrate it
 * before it closes.
 */
export function attributeNodeToItems(
  deps: AutonomyDeps,
  input: { jobId: string; nodeId: string; taskId: string; itemIds: readonly string[] },
): ClosureLedger {
  const ledger = requireLedger(deps.workspace, input.jobId);
  const at = nowIso(deps);
  const entries = ledger.entries.map((existing) => {
    if (!input.itemIds.includes(existing.itemId)) return existing;
    if (existing.attributedNodeIds.includes(input.nodeId)) return existing;
    return {
      ...existing,
      attributedNodeIds: [...existing.attributedNodeIds, input.nodeId].slice(0, 50),
      attributedTaskIds: [...new Set([...existing.attributedTaskIds, input.taskId])].slice(0, 50),
      updatedAt: at,
    };
  });
  return saveLedger(deps, { ...ledger, entries });
}

export interface RegisterEvidenceInput {
  jobId: string;
  itemIds: readonly string[];
  kind: ClosureEvidenceKind;
  ref: string;
  passed: boolean;
  gitHead?: string | undefined;
  detail?: string | undefined;
}

/**
 * Register evidence against contract items.
 *
 * Accepts FAILING evidence as readily as passing evidence. A failed run is a
 * fact about the item, it is what turns an unclosed item into a specific
 * `EVIDENCE_FAILED` gap rather than a vague one, and hiding it would make
 * the ledger a record of successes rather than a record of what is known.
 */
export function registerClosureEvidence(
  deps: AutonomyDeps,
  input: RegisterEvidenceInput,
): ClosureLedger {
  const ledger = requireLedger(deps.workspace, input.jobId);
  const at = nowIso(deps);
  const entries = ledger.entries.map((existing) => {
    if (!input.itemIds.includes(existing.itemId)) return existing;
    return {
      ...existing,
      evidence: [
        ...existing.evidence.filter(
          (ref) => !(ref.kind === input.kind && ref.ref === input.ref),
        ),
        {
          kind: input.kind,
          ref: input.ref.slice(0, 200),
          passed: input.passed,
          recordedAt: at,
          ...(input.gitHead !== undefined ? { gitHead: input.gitHead } : {}),
          ...(input.detail !== undefined ? { detail: input.detail.slice(0, 4_000) } : {}),
        },
      ].slice(-50),
      updatedAt: at,
    };
  });
  return saveLedger(deps, { ...ledger, entries });
}

/**
 * Record a HUMAN waiver on one item.
 *
 * Deliberately requires a `waivedBy` and a reason, and deliberately has no
 * agent-reachable caller. A waiver is a person deciding a promise no longer
 * applies, which is product authority; the firewall's `sealed-contract-change`
 * surface is the path an agent takes to ask for one.
 */
export function waiveClosureItem(
  deps: AutonomyDeps,
  input: { jobId: string; itemId: string; reason: string; waivedBy: string },
): ClosureLedger {
  const ledger = requireLedger(deps.workspace, input.jobId);
  const at = nowIso(deps);
  const entries = ledger.entries.map((existing) =>
    existing.itemId === input.itemId
      ? {
          ...existing,
          status: 'WAIVED' as const,
          waiver: {
            reason: input.reason.slice(0, 4_000),
            waivedAt: at,
            waivedBy: input.waivedBy.slice(0, 200),
          },
          gaps: [],
          updatedAt: at,
        }
      : existing,
  );
  return saveLedger(deps, { ...ledger, entries });
}

// ---------------------------------------------------------------------------
// Auditing
// ---------------------------------------------------------------------------

export interface AuditInput {
  jobId: string;
  /** Node ids the job has COMPLETED, for attribution resolution. */
  completedNodeIds: readonly string[];
  /** Whether the planned implementation graph is finished. */
  implementationComplete: boolean;
  gitHead?: string | undefined;
  auditId?: string | undefined;
  /** Evidence older than this is stale even at the same head. */
  maxEvidenceAgeMs?: number | undefined;
}

export interface AuditResult {
  ledger: ClosureLedger;
  audit: ClosureAudit;
}

/**
 * Recompute every item's closure and record the verdict.
 *
 * The audit is the moment the runtime is not allowed to be optimistic. It
 * runs the pure oracle over the whole ledger, writes an append-only record of
 * what it found, and returns a directive the lifecycle obeys.
 */
export function runClosureAudit(deps: AutonomyDeps, input: AuditInput): AuditResult {
  const policy = autonomyPolicyOf(deps).closure;
  const ledger = requireLedger(deps.workspace, input.jobId);
  const completed = new Set(input.completedNodeIds);
  const at = nowIso(deps);

  const entries = ledger.entries.map((existing) => {
    const attributedNodesComplete =
      existing.attributedNodeIds.length > 0 &&
      existing.attributedNodeIds.every((nodeId) => completed.has(nodeId));
    const assessment = assessItemClosure(
      existing,
      {
        now: now(deps),
        ...(input.gitHead !== undefined ? { gitHead: input.gitHead } : {}),
        ...(input.maxEvidenceAgeMs !== undefined ? { maxEvidenceAgeMs: input.maxEvidenceAgeMs } : {}),
      },
      { attributedNodesComplete },
    );
    return { ...existing, status: assessment.status, gaps: assessment.gaps, updatedAt: at };
  });

  const verdict = decideClosure({ ...ledger, entries }, policy, {
    implementationComplete: input.implementationComplete,
  });
  const totals = summarizeClosure(entries);
  const audit = closureAuditSchema.parse({
    schemaVersion: CLOSURE_SCHEMA_VERSION,
    auditId: input.auditId ?? newRecordId(deps, 'ca'),
    jobId: input.jobId,
    sealId: ledger.sealId,
    createdAt: at,
    phase: verdict.nextPhase,
    directive: verdict.directive,
    totals,
    closureRatio: closureRatio(totals),
    unclosed: verdict.unclosed.map((unclosed) => ({
      itemId: unclosed.itemId,
      status: unclosed.status,
      gaps: unclosed.gaps,
      statement: unclosed.statement,
    })),
    rationale: verdict.rationale,
  });

  const saved = saveLedger(deps, { ...ledger, entries, phase: verdict.nextPhase });
  writeJsonRecord(
    autonomyPath(deps.workspace, 'closure', input.jobId, 'audits', `${audit.auditId}.json`),
    audit,
  );
  try {
    recordJobEvent(jobDepsOf(deps), input.jobId, 'closure_audit_completed', {
      auditId: audit.auditId,
      directive: audit.directive,
      phase: audit.phase,
      verified: totals.verified,
      total: totals.total,
      unclosed: audit.unclosed.length,
    });
  } catch {
    // Certification fixtures audit ledgers with no job record.
  }
  return { ledger: saved, audit };
}

// ---------------------------------------------------------------------------
// Gap work
// ---------------------------------------------------------------------------

/**
 * Turn unclosed items into work.
 *
 * The objective text is derived from the SEALED statement plus the specific
 * gap. It never invents a requirement: an agent that could author new
 * objectives from an audit would be writing product intent, which is exactly
 * the authority the seal reserves.
 */

/**
 * Attribute every COMPLETED node's work and trusted verification to the
 * sealed items it implements. Idempotent: attribution and evidence both
 * dedup, so running it on every audit costs nothing and heals everything.
 *
 * This closes the loop the dogfood found open. Five objectives completed on
 * real trusted verification — and the ledger stayed at 53 items NOT_STARTED,
 * because nothing ever carried the evidence from the job to the ledger:
 * `attributeNodeToItems` and `registerClosureEvidence` existed with no
 * caller on the implementation path. The closure audit then saw an empty
 * ledger over a finished job, generated gap work no executor could run, and
 * regenerated it every cycle. Evidence that is earned but never attributed
 * is indistinguishable from evidence that never existed.
 *
 * Attribution is by contract: a node's task maps to contract ids
 * (`contractsForObjective`), and an item belongs to a contract via its
 * itemId (`CTR-x/Rn`, `CTR-x#In`) or, for acceptance criteria, its
 * declared contractIds. Items with no contract linkage are left for the
 * scenario phases, which own them.
 */
export function attributeCompletedWork(
  deps: AutonomyDeps,
  input: { jobId: string; missionId: string },
): { attributed: number } {
  const mission = requireMissionState(deps.workspace, input.missionId);
  const graph =
    requireJobState(deps.workspace, input.jobId).graphRevision > 0
      ? readGraphRevision(
          deps.workspace,
          input.jobId,
          requireJobState(deps.workspace, input.jobId).graphRevision,
        )
      : undefined;
  if (graph === undefined) return { attributed: 0 };
  const ledger = requireLedger(deps.workspace, input.jobId);
  const seal = latestExecutableSeal(deps.workspace, input.missionId);
  const criterionContracts = new Map(
    (seal?.acceptanceCriteria ?? []).map((criterion) => [criterion.criterionId, criterion.contractIds]),
  );
  let attributed = 0;
  for (const node of graph.nodes) {
    if (node.status !== 'COMPLETED') continue;
    const contractIds = contractsForObjective(deps.workspace, mission, node.parentTaskId);
    // Acceptance criteria often declare no contract; their linkage to a task
    // is the acceptance STATEMENT itself, which the intake compiled from the
    // very same criteria. Statement identity is the provenance.
    const acceptance = acceptanceForObjective(deps.workspace, mission, node.parentTaskId)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length >= 12);
    const itemIds = ledger.entries
      .filter((entry) => {
        const owner = entry.itemId.split(/[/#]/)[0] ?? '';
        if (contractIds.includes(owner)) return true;
        const declared = criterionContracts.get(entry.itemId);
        if (declared !== undefined && declared.some((id) => contractIds.includes(id))) return true;
        if (entry.kind !== 'acceptance-criterion') return false;
        // CONTAINMENT, not equality: the ledger holds the compiled sentence
        // ("The demo must cover edge cases including at least: passport
        // present, boarding pass missing;") while the task plan carries the
        // raw fragment it was compiled from. Either direction counts, and
        // short fragments are excluded above so nothing trivial matches.
        const statement = entry.statement.trim().toLowerCase();
        return acceptance.some(
          (line) => statement.includes(line) || line.includes(statement),
        );
      })
      .map((entry) => entry.itemId);
    if (itemIds.length === 0) continue;
    attributeNodeToItems(deps, {
      jobId: input.jobId,
      nodeId: node.nodeId,
      taskId: node.parentTaskId,
      itemIds,
    });
    registerClosureEvidence(deps, {
      jobId: input.jobId,
      itemIds,
      kind: 'TRUSTED_VERIFICATION',
      ref: `node:${node.nodeId}`,
      passed: true,
      detail: `Task ${node.parentTaskId} completed through the trusted verification pipeline.`,
    });
    attributed += itemIds.length;
  }
  return { attributed };
}

export function generateGapWork(
  deps: AutonomyDeps,
  input: { jobId: string; audit: ClosureAudit },
): GapWorkItem[] {
  const policy = autonomyPolicyOf(deps).closure;
  const ledger = requireLedger(deps.workspace, input.jobId);
  const byId = new Map(ledger.entries.map((existing) => [existing.itemId, existing]));
  const at = nowIso(deps);
  const generated: GapWorkItem[] = [];

  for (const unclosed of input.audit.unclosed.slice(0, policy.maxGapWorkPerCycle)) {
    const existing = byId.get(unclosed.itemId);
    if (existing === undefined) continue;
    const gap: ClosureGapKind = unclosed.gaps[0] ?? 'NO_EVIDENCE';
    const item = gapWorkItemSchema.parse({
      gapId: newRecordId(deps, 'gap'),
      itemId: unclosed.itemId,
      gapKind: gap,
      objective: objectiveFor(existing.statement, gap),
      closingEvidence: closingEvidenceForGap(existing, gap),
      createdAt: at,
      auditId: input.audit.auditId,
    });
    writeJsonRecord(
      autonomyPath(deps.workspace, 'closure', input.jobId, 'gaps', `${item.gapId}.json`),
      item,
    );
    generated.push(item);
  }

  saveLedger(deps, { ...ledger, gapCycles: ledger.gapCycles + 1 });
  try {
    recordJobEvent(jobDepsOf(deps), input.jobId, 'gap_work_generated', {
      auditId: input.audit.auditId,
      generated: generated.length,
      cycle: ledger.gapCycles + 1,
    });
  } catch {
    // As above.
  }
  return generated;
}

function objectiveFor(statement: string, gap: ClosureGapKind): string {
  const prefix: Record<ClosureGapKind, string> = {
    NO_IMPLEMENTATION: 'Implement and prove:',
    NO_EVIDENCE: 'Produce trusted evidence for:',
    EVIDENCE_FAILED: 'Repair the implementation until this holds:',
    EVIDENCE_STALE: 'Re-verify against the current repository state:',
    EVIDENCE_UNTRUSTED: 'Replace an unverified claim with trusted evidence for:',
    SCENARIO_MISSING: 'Build and run the scenario that demonstrates:',
    SCENARIO_FAILED: 'Repair until the scenario demonstrates:',
    CRITIC_MATERIAL_FINDING: 'Fix the material UI problem blocking:',
    REPRODUCIBILITY_FAILED: 'Make this reproducible from a clean environment:',
  };
  return `${prefix[gap]} ${statement}`.slice(0, 4_000);
}

// ---------------------------------------------------------------------------
// Phase bookkeeping and completion
// ---------------------------------------------------------------------------

export function advanceClosurePhase(
  deps: AutonomyDeps,
  input: { jobId: string; phase: ClosurePhase; systemCycle?: boolean; reproducibilityPassed?: boolean },
): ClosureLedger {
  const ledger = requireLedger(deps.workspace, input.jobId);
  return saveLedger(deps, {
    ...ledger,
    phase: input.phase,
    systemCycles: ledger.systemCycles + (input.systemCycle === true ? 1 : 0),
    reproducibilityPassed: input.reproducibilityPassed ?? ledger.reproducibilityPassed,
  });
}

/**
 * The completion gate.
 *
 * Throws rather than returning false, because the caller of this is the code
 * path that would otherwise write COMPLETED. A boolean would be a value
 * somebody could forget to check; an exception is not.
 */
export function assertMissionMayComplete(workspace: WorkspaceInfo, jobId: string): void {
  const ledger = readClosureLedger(workspace, jobId);
  if (ledger === undefined) {
    throw new AutonomyError(
      'SBA020',
      `Job ${jobId} has no closure ledger, so completion cannot be demonstrated.`,
      {
        remediation: [
          'A sealed mission builds its ledger when the job is created. An unsealed job completes ' +
            'through the ordinary v1.2 path instead.',
        ],
      },
    );
  }
  const verdict = missionMayComplete(ledger);
  if (verdict.mayComplete) return;
  throw new AutonomyError('SBA020', `Mission is not complete: ${verdict.reason}.`, {
    remediation: [
      ...verdict.unclosedIds.slice(0, 10).map((id) => `unclosed: ${id}`),
      'Run the closure audit to generate the work that would close them.',
    ],
    details: { unclosed: verdict.unclosedIds.length },
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function requireLedger(workspace: WorkspaceInfo, jobId: string): ClosureLedger {
  const ledger = readClosureLedger(workspace, jobId);
  if (ledger === undefined) {
    throw new AutonomyError('SBA020', `Job ${jobId} has no closure ledger.`, {
      remediation: ['Build one from the bound seal before auditing closure.'],
    });
  }
  return ledger;
}

function saveLedger(deps: AutonomyDeps, ledger: ClosureLedger): ClosureLedger {
  const next = closureLedgerSchema.parse({ ...ledger, updatedAt: nowIso(deps) });
  writeJsonRecord(closureLedgerFile(deps.workspace, next.jobId), next);
  return next;
}
