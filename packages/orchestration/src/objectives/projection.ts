import { sha256Hex } from '@specbridge/core';
import type {
  ConstitutionRule,
  DiscoveryDecision,
  MissionAdr,
  ProductContract,
} from '@specbridge/mission';
import type { ContextProjection, WorkUnit } from './state.js';
import { CONTEXT_PROJECTION_SCHEMA_VERSION, OBJECTIVE_LIMITS, contextProjectionSchema } from './state.js';

/**
 * The ContextProjector.
 *
 *   WorkerContext = Mission Constitution Snapshot
 *                 + Current Objective
 *                 + Relevant Contract Versions
 *                 + Relevant ADRs
 *                 + Relevant Approved Spec Excerpts
 *                 + Relevant Prior Decisions
 *                 + Current Work Evidence
 *
 * "Share truth, not context": a projection carries APPROVED, VERSIONED
 * artifacts only, filtered to what the work unit declares relevant. It is
 * immutable, hashed, bounded, reconstructable, and bound to exactly one
 * (workUnit, attempt). It can answer, forever: exactly what approved truth
 * did this worker see?
 *
 * Staleness is structural: the projection records a hash over the ACTIVE
 * contract revisions and constitution version it saw; when any referenced
 * contract gains a revision, `evaluateProjectionFreshness` reports stale
 * and affected work replans or stops — never continues silently.
 */

export interface ProjectionSource {
  missionId?: string | undefined;
  constitutionVersion: number;
  constitutionRules: readonly ConstitutionRule[];
  /** The ACTIVE registry view (highest revision per contract). */
  contracts: readonly ProductContract[];
  adrs: readonly MissionAdr[];
  decisions: readonly DiscoveryDecision[];
}

export interface BuildProjectionInput {
  jobId: string;
  objectiveNodeId: string;
  objective: { taskId: string; title: string; acceptance: readonly string[] };
  workUnit: WorkUnit;
  attempt: number;
  source: ProjectionSource;
  /** Bounded approved-spec excerpts (requirements/design fragments). */
  specExcerpts?: readonly string[] | undefined;
  /** Bounded summaries of verified dependency candidates. */
  workEvidence?: readonly string[] | undefined;
  createdAt: string;
  maxProjectionChars: number;
}

/**
 * Deterministic identity of the active contract registry a worker saw:
 * sorted (contractId, revision) pairs plus the constitution version. Any
 * revision bump anywhere changes the hash.
 */
export function contractSnapshotHashOf(
  contracts: readonly { contractId: string; revision: number }[],
  constitutionVersion: number,
): string {
  const canonical = [...contracts]
    .map((contract) => `${contract.contractId}@${contract.revision}`)
    .sort()
    .join(',');
  return sha256Hex(`constitution@${constitutionVersion};${canonical}`);
}

/** Stable stringify: sorted keys at every level (hash input). */
function stableStringify(value: unknown): string {
  const sorted = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sorted);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.keys(input as Record<string, unknown>)
          .sort()
          .map((key) => [key, sorted((input as Record<string, unknown>)[key])]),
      );
    }
    return input;
  };
  return JSON.stringify(sorted(value));
}

const bounded = (value: string, max: number): string => value.slice(0, max);

/**
 * Build one immutable projection. Pure given its inputs — the same inputs
 * always produce the same contentHash, which tests rely on.
 */
export function buildContextProjection(input: BuildProjectionInput): ContextProjection {
  const { workUnit, source } = input;
  const relevantContractIds = new Set(workUnit.relevantContractIds);
  const relevantAdrIds = new Set(workUnit.relevantAdrIds);
  const relevantRuleIds = new Set(workUnit.relevantConstitutionRuleIds);

  // Contracts: the declared-relevant subset of the ACTIVE registry. A unit
  // declaring nothing gets nothing — unrelated project content is excluded
  // by default, not by luck.
  const contracts = source.contracts
    .filter((contract) => relevantContractIds.has(contract.contractId))
    .slice(0, OBJECTIVE_LIMITS.maxProjectionContracts)
    .map((contract) => ({
      contractId: contract.contractId,
      revision: contract.revision,
      title: bounded(contract.title, OBJECTIVE_LIMITS.maxShortTextChars),
      summary: bounded(contract.summary, OBJECTIVE_LIMITS.maxTextChars),
      requirements: contract.requirements
        .slice(0, OBJECTIVE_LIMITS.maxListItems)
        .map((requirement) => bounded(`${requirement.requirementId}: ${requirement.statement}`, OBJECTIVE_LIMITS.maxTextChars)),
      invariants: contract.invariants
        .slice(0, OBJECTIVE_LIMITS.maxListItems)
        .map((invariant) => bounded(`${invariant.invariantId}: ${invariant.statement}`, OBJECTIVE_LIMITS.maxTextChars)),
    }));

  // The constitution travels whole: it is small by design and every rule is
  // binding for every worker. Explicitly-relevant rules sort first.
  const activeRules = source.constitutionRules.filter((rule) => rule.status === 'active');
  const rules = [
    ...activeRules.filter((rule) => relevantRuleIds.has(rule.ruleId)),
    ...activeRules.filter((rule) => !relevantRuleIds.has(rule.ruleId)),
  ]
    .slice(0, 40)
    .map((rule) => ({
      ruleId: rule.ruleId,
      version: rule.version,
      statement: bounded(rule.statement, OBJECTIVE_LIMITS.maxTextChars),
    }));

  const adrs = source.adrs
    .filter((adr) => adr.status === 'accepted' && relevantAdrIds.has(adr.adrId))
    .slice(0, OBJECTIVE_LIMITS.maxListItems)
    .map((adr) => ({
      adrId: adr.adrId,
      title: bounded(adr.title, OBJECTIVE_LIMITS.maxShortTextChars),
      decision: bounded(adr.decision, OBJECTIVE_LIMITS.maxTextChars),
    }));

  // Prior decisions: only those touching the unit's relevant contracts'
  // provenance or explicitly requested; bounded to the most recent.
  const contractDecisionIds = new Set(
    source.contracts
      .filter((contract) => relevantContractIds.has(contract.contractId))
      .flatMap((contract) => contract.decisionIds),
  );
  const decisions = source.decisions
    .filter((decision) => decision.status === 'active' && contractDecisionIds.has(decision.decisionId))
    .slice(-OBJECTIVE_LIMITS.maxListItems)
    .map((decision) => ({
      decisionId: decision.decisionId,
      decision: bounded(decision.decision, OBJECTIVE_LIMITS.maxTextChars),
    }));

  const contractSnapshotHash = contractSnapshotHashOf(
    source.contracts.map((contract) => ({ contractId: contract.contractId, revision: contract.revision })),
    source.constitutionVersion,
  );

  const body = {
    schemaVersion: CONTEXT_PROJECTION_SCHEMA_VERSION,
    projectionId: `${input.workUnit.workUnitId}-a${String(input.attempt).padStart(2, '0')}`,
    jobId: input.jobId,
    objectiveNodeId: input.objectiveNodeId,
    workUnitId: input.workUnit.workUnitId,
    attempt: input.attempt,
    createdAt: input.createdAt,
    ...(input.source.missionId !== undefined ? { missionId: input.source.missionId } : {}),
    constitution: { version: source.constitutionVersion, rules },
    objective: {
      taskId: input.objective.taskId,
      title: bounded(input.objective.title, OBJECTIVE_LIMITS.maxTextChars),
      acceptance: input.objective.acceptance
        .slice(0, OBJECTIVE_LIMITS.maxListItems)
        .map((item) => bounded(item, OBJECTIVE_LIMITS.maxTextChars)),
    },
    workUnit: {
      title: workUnit.title,
      goal: workUnit.goal,
      kind: workUnit.kind,
      expectedArtifacts: workUnit.expectedArtifacts,
      expectedAreas: workUnit.expectedAreas,
    },
    contracts,
    adrs,
    decisions,
    specExcerpts: (input.specExcerpts ?? [])
      .slice(0, 5)
      .map((excerpt) => bounded(excerpt, OBJECTIVE_LIMITS.maxProjectionExcerptChars)),
    workEvidence: (input.workEvidence ?? [])
      .slice(0, OBJECTIVE_LIMITS.maxListItems)
      .map((item) => bounded(item, OBJECTIVE_LIMITS.maxTextChars)),
    contractSnapshotHash,
  };

  // The whole projection is bounded as one unit: an oversized projection is
  // trimmed from the least-load-bearing end (spec excerpts) rather than
  // shipped unbounded.
  let serialized = stableStringify(body);
  while (serialized.length > input.maxProjectionChars && body.specExcerpts.length > 0) {
    body.specExcerpts.pop();
    serialized = stableStringify(body);
  }

  return contextProjectionSchema.parse({ ...body, contentHash: sha256Hex(serialized) });
}

export interface ProjectionFreshness {
  fresh: boolean;
  reasons: string[];
}

/**
 * Is a stored projection still an honest picture of approved truth? Stale
 * exactly when the ACTIVE registry hash moved — a contract revision, a new
 * contract, or a constitution change since projection time.
 */
export function evaluateProjectionFreshness(
  projection: Pick<ContextProjection, 'contractSnapshotHash' | 'contracts'>,
  current: {
    contracts: readonly { contractId: string; revision: number }[];
    constitutionVersion: number;
  },
): ProjectionFreshness {
  const currentHash = contractSnapshotHashOf(current.contracts, current.constitutionVersion);
  if (currentHash === projection.contractSnapshotHash) return { fresh: true, reasons: [] };
  const reasons: string[] = [];
  const currentById = new Map(current.contracts.map((contract) => [contract.contractId, contract.revision]));
  for (const seen of projection.contracts) {
    const now = currentById.get(seen.contractId);
    if (now === undefined) {
      reasons.push(`contract ${seen.contractId} no longer exists in the active registry`);
    } else if (now !== seen.revision) {
      reasons.push(`contract ${seen.contractId} moved from revision ${seen.revision} to ${now}`);
    }
  }
  if (reasons.length === 0) {
    reasons.push('the active contract registry or constitution changed since this projection was built');
  }
  return { fresh: false, reasons };
}
