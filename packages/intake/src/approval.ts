import { sha256Hex } from '@specbridge/core';
import type { MissionState, ProductContract } from '@specbridge/mission';
import type { DeltaAuthorityAnalysis, IntakeApproval, ProductQuestion, SpecSource } from './state.js';
import { INTAKE_APPROVAL_SCHEMA_VERSION, INTAKE_LIMITS } from './state.js';
import { clip } from './text.js';

/**
 * The single human authority operation.
 *
 * One person, one decision, one record:
 *
 *   "I approve this discovered specification and authorize SpecBridge to
 *    build it."
 *
 * Everything downstream cites this record: the MissionSeal is drafted from
 * it, the derived stage approvals prove themselves against its digest, the
 * telemetry boundary starts at its timestamp, and the product baseline
 * lineage names it. That is a lot of weight for one file, which is why the
 * store refuses to overwrite it and why every field here is a REFERENCE or a
 * DIGEST rather than prose.
 *
 * The distinction is worth stating plainly, because it is the difference
 * between an authorization and a summary. A record that restated the
 * approved requirements in its own words would be a NEW set of requirements
 * that nobody read. So the approval names decision ids, contract ids and
 * revisions, criterion text as it was compiled, and the answers the human
 * actually typed. The one piece of prose it carries verbatim — the goal — is
 * the user's own sentence.
 */

// ---------------------------------------------------------------------------
// The authority digest
// ---------------------------------------------------------------------------

export interface CanonicalTruth {
  goal: string;
  nonGoals: readonly string[];
  decisionIds: readonly string[];
  constitutionRuleIds: readonly string[];
  adrIds: readonly string[];
  contracts: readonly {
    contractId: string;
    revision: number;
    requirementIds: readonly string[];
    invariantIds: readonly string[];
  }[];
  acceptanceCriteria: readonly string[];
  resolvedAnswers: readonly { questionId: string; answer: string }[];
}

/**
 * Hash over exactly the product truth a human approved.
 *
 * Timestamps, record ids of the approval itself, and everything about HOW
 * the intake ran are excluded, so the digest answers "is this the same
 * product truth?" rather than "is this the same file?". That is what lets a
 * derived approval detect drift: if a contract gained a revision or a
 * decision was superseded between the approval and the projection, the
 * digest moves and the derived approval refuses.
 *
 * The same construction as `computeAuthorityDigest` in the seal service, and
 * deliberately a SEPARATE function rather than a shared one — the two hash
 * different things (a seal covers autonomy policy and resource ceilings; an
 * intake approval covers the product truth and the human's answers) and
 * merging them would silently couple two authorizations that must be able to
 * differ.
 */
export function computeIntakeAuthorityDigest(truth: CanonicalTruth): string {
  const canonical = {
    goal: truth.goal,
    nonGoals: [...truth.nonGoals].sort(),
    decisionIds: [...truth.decisionIds].sort(),
    constitutionRuleIds: [...truth.constitutionRuleIds].sort(),
    adrIds: [...truth.adrIds].sort(),
    contracts: truth.contracts
      .map((contract) => ({
        contractId: contract.contractId,
        revision: contract.revision,
        requirementIds: [...contract.requirementIds].sort(),
        invariantIds: [...contract.invariantIds].sort(),
      }))
      .sort((a, b) => a.contractId.localeCompare(b.contractId)),
    acceptanceCriteria: [...truth.acceptanceCriteria].sort(),
    resolvedAnswers: truth.resolvedAnswers
      .map((answer) => ({ questionId: answer.questionId, answer: answer.answer }))
      .sort((a, b) => a.questionId.localeCompare(b.questionId)),
  };
  return sha256Hex(JSON.stringify(canonical)).slice(0, 32);
}

/** Build the canonical truth from durable mission state. */
export function canonicalTruthOf(input: {
  mission: MissionState;
  contracts: readonly ProductContract[];
  decisionIds: readonly string[];
  constitutionRuleIds: readonly string[];
  adrIds: readonly string[];
  questions: readonly ProductQuestion[];
}): CanonicalTruth {
  return {
    goal: input.mission.goal,
    nonGoals: input.mission.nonGoals,
    decisionIds: input.decisionIds,
    constitutionRuleIds: input.constitutionRuleIds,
    adrIds: input.adrIds,
    contracts: input.contracts
      .filter((contract) => contract.status !== 'superseded')
      .map((contract) => ({
        contractId: contract.contractId,
        revision: contract.revision,
        requirementIds: contract.requirements.map((requirement) => requirement.requirementId),
        invariantIds: contract.invariants.map((invariant) => invariant.invariantId),
      })),
    acceptanceCriteria: input.mission.successCriteria,
    resolvedAnswers: input.questions
      .filter((question) => question.status === 'answered' && question.answer !== undefined)
      .map((question) => ({ questionId: question.questionId, answer: question.answer ?? '' })),
  };
}

// ---------------------------------------------------------------------------
// Building the approval record
// ---------------------------------------------------------------------------

export interface BuildApprovalRequest {
  approvalId: string;
  intakeId: string;
  missionId: string;
  approvedAt: string;
  approvedVia: string;
  source: SpecSource;
  mission: MissionState;
  contracts: readonly ProductContract[];
  analysis: DeltaAuthorityAnalysis;
  questions: readonly ProductQuestion[];
  decisionIds: readonly string[];
  constitutionRuleIds: readonly string[];
  adrIds: readonly string[];
  maxApiSpendUsd: number | null;
  allowedLanes: readonly ('LOCAL' | 'SUBSCRIPTION' | 'API')[];
}

/**
 * Compile the approval record from durable state.
 *
 * PURE with respect to the workspace: it reads what it was handed and
 * returns a record. Writing it — and refusing to overwrite an existing one —
 * is the store's job, and keeping the two apart means the record a test
 * asserts against is the record that gets written.
 */
export function buildIntakeApproval(request: BuildApprovalRequest): IntakeApproval {
  const truth = canonicalTruthOf({
    mission: request.mission,
    contracts: request.contracts,
    decisionIds: request.decisionIds,
    constitutionRuleIds: request.constitutionRuleIds,
    adrIds: request.adrIds,
    questions: request.questions,
  });

  const newContractIds = request.contracts
    .filter((contract) => contract.status !== 'superseded')
    .map((contract) => contract.contractId);

  return {
    schemaVersion: INTAKE_APPROVAL_SCHEMA_VERSION,
    approvalId: request.approvalId,
    intakeId: request.intakeId,
    missionId: request.missionId,
    approvedAt: request.approvedAt,
    approvedVia: clip(request.approvedVia, INTAKE_LIMITS.maxShortTextChars),
    sourceContentHash: request.source.contentHash,
    authorityDigest: computeIntakeAuthorityDigest(truth),
    deltaBasisDigest: request.analysis.basisDigest,
    goal: clip(request.mission.goal, INTAKE_LIMITS.maxTextChars),
    nonGoals: request.mission.nonGoals.slice(0, INTAKE_LIMITS.maxItems),
    decisionIds: [...request.decisionIds].slice(0, INTAKE_LIMITS.maxItems),
    constitutionRuleIds: [...request.constitutionRuleIds].slice(0, INTAKE_LIMITS.maxItems),
    adrIds: [...request.adrIds].slice(0, INTAKE_LIMITS.maxItems),
    newContractIds: newContractIds.slice(0, INTAKE_LIMITS.maxItems),
    extendedContractIds: [...request.analysis.extendedContractIds].slice(0, INTAKE_LIMITS.maxItems),
    changedContractIds: [...request.analysis.modifiedContractIds].slice(0, INTAKE_LIMITS.maxItems),
    acceptanceCriteria: request.mission.successCriteria.slice(0, INTAKE_LIMITS.maxItems),
    resolvedQuestions: request.questions
      .filter((question) => question.status === 'answered')
      .slice(0, INTAKE_LIMITS.maxQuestions)
      .map((question) => ({
        questionId: question.questionId,
        question: clip(question.question, INTAKE_LIMITS.maxTextChars),
        answer: clip(question.answer ?? '', INTAKE_LIMITS.maxTextChars),
        ...(question.decisionId !== undefined ? { decisionId: question.decisionId } : {}),
      })),
    maxApiSpendUsd: request.maxApiSpendUsd,
    allowedLanes: [...request.allowedLanes],
  };
}

// ---------------------------------------------------------------------------
// The approval summary
// ---------------------------------------------------------------------------

/**
 * What the human sees before they approve.
 *
 * Deliberately short and in product language. Dumping three generated
 * documents back at somebody and calling it an approval gate is how a
 * workflow trains people to click through; the useful summary is what
 * CHANGES: which promises are new, which existing ones are affected, what
 * was decided, and what is explicitly not being built.
 */
export interface ApprovalSummary {
  goal: string;
  newSurfaces: string[];
  newContracts: { contractId: string; title: string; requirements: number }[];
  extendedContractIds: string[];
  /** Existing sealed contracts this specification would CHANGE. */
  changedContractIds: string[];
  /**
   * The same contracts, qualified by the mission that owns them.
   *
   * What a person actually reads. A bare "CTR-001 would be extended" sitting
   * above the feature's own "CTR-001 Observable Behaviour" names two
   * different contracts with one label.
   */
  affectedContracts: {
    contractId: string;
    missionId: string;
    missionName?: string | undefined;
    title: string;
    revision: number;
    relation: 'EXTENDED' | 'CHANGED';
  }[];
  decisions: { questionId: string; question: string; answer: string }[];
  nonGoals: string[];
  acceptanceCriteriaCount: number;
  openBlockers: number;
  /** Statements classified as ordinary delegated engineering. */
  delegatedItemCount: number;
}

export function buildApprovalSummary(input: {
  mission: MissionState;
  contracts: readonly ProductContract[];
  analysis: DeltaAuthorityAnalysis;
  questions: readonly ProductQuestion[];
}): ApprovalSummary {
  return {
    goal: clip(input.mission.goal, 600),
    newSurfaces: [...input.analysis.newSurfaces].slice(0, 20),
    newContracts: input.contracts
      .filter((contract) => contract.status !== 'superseded')
      .map((contract) => ({
        contractId: contract.contractId,
        title: contract.title,
        requirements: contract.requirements.length,
      })),
    extendedContractIds: [...input.analysis.extendedContractIds],
    changedContractIds: [...input.analysis.modifiedContractIds],
    affectedContracts: input.analysis.affectedContracts.map((contract) => ({
      contractId: contract.contractId,
      missionId: contract.missionId,
      ...(contract.missionName !== undefined ? { missionName: contract.missionName } : {}),
      title: contract.title,
      revision: contract.revision,
      relation: contract.relation as 'EXTENDED' | 'CHANGED',
    })),
    decisions: input.questions
      .filter((question) => question.status === 'answered')
      .map((question) => ({
        questionId: question.questionId,
        question: clip(question.question, 400),
        answer: clip(question.answer ?? '', 400),
      })),
    nonGoals: input.mission.nonGoals.slice(0, 20).map((goal) => clip(goal, 300)),
    acceptanceCriteriaCount: input.mission.successCriteria.length,
    openBlockers: input.questions.filter((question) => question.status === 'open').length,
    delegatedItemCount:
      (input.analysis.counts['IMPLEMENTATION_DETAIL'] ?? 0) +
      (input.analysis.counts['NEW_DELEGATED_SURFACE'] ?? 0),
  };
}
