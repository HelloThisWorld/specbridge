import { randomUUID } from 'node:crypto';
import type { WorkspaceInfo } from '@specbridge/core';
import type { Clock } from '@specbridge/workflow';
import { systemClock } from '@specbridge/workflow';
import { computeCoverage } from './coverage.js';
import { MissionError } from './errors.js';
import { assessMateriality } from './materiality.js';
import type {
  ContractChangeRequest,
  ConversationTurn,
  DiscoveryDecision,
  DiscoveryQuestion,
  MissionAdr,
  MissionCheckpoint,
  MissionConstitution,
  MissionCoverage,
  MissionFact,
  MissionState,
  ProductContract,
} from './state.js';
import {
  MISSION_ADR_SCHEMA_VERSION,
  MISSION_CCR_SCHEMA_VERSION,
  MISSION_CHECKPOINT_SCHEMA_VERSION,
  MISSION_CONSTITUTION_SCHEMA_VERSION,
  MISSION_CONTRACT_SCHEMA_VERSION,
  MISSION_LIMITS,
  MISSION_STATE_SCHEMA_VERSION,
  contractChangeRequestSchema,
  missionAdrSchema,
  missionCheckpointSchema,
  missionStateSchema,
  productContractSchema,
} from './state.js';
import { assertMissionTransition } from './state-machine.js';
import {
  appendDecision,
  appendFact,
  appendMissionEvent,
  appendQuestion,
  appendTurn,
  findTurn,
  initializeMissionRecord,
  readCcr,
  readCcrs,
  readConstitution,
  readContract,
  readContractRegistry,
  readDecisions,
  readFacts,
  readQuestions,
  requireMissionState,
  storeAdr,
  storeContractRevision,
  writeCcr,
  writeConstitution,
  writeCoverage,
  writeMissionCheckpoint,
  writeMissionState,
} from './store.js';
import type {
  CompatibilityPolicy,
  ContractClassification,
  DiscoveryTopic,
  IrreversibleSurface,
  MaterialityLevel,
  MissionEventType,
  MissionProvenanceKind,
  TurnKind,
  TurnSpeaker,
} from './vocabulary.js';
import { UNSAFE_DECISION_PROVENANCE, isFinalMissionStatus } from './vocabulary.js';

/**
 * The mission application service.
 *
 * Every operation is: load state → validate against the state machine and
 * the governance rules → persist atomically → append events → recompute
 * coverage. The CLI, the MCP surface, and the plugin call these functions;
 * none of them re-implements a rule.
 *
 * Governance, structural rather than prompt-based:
 *   - ids are generated here, never accepted from a caller
 *   - a DECISION with unsafe provenance (inferred / unknown / conflicting)
 *     is refused: hypotheses are recorded as facts or questions, never as
 *     commitments
 *   - a decision claiming `known-from-user` must reference a USER turn —
 *     the visible conversation is the provenance root, and an agent cannot
 *     invent a confirmation
 *   - question materiality passes the deterministic irreversibility screen,
 *     which may only RAISE the declared level
 *   - constitution rules and contracts must trace to recorded decisions
 *   - CONTRACT_READY is reachable only through the coverage gate
 *   - nothing here can approve a spec stage, and nothing here approves a
 *     contract change request except the explicitly human-only function
 */

export interface MissionDeps {
  workspace: WorkspaceInfo;
  clock?: Clock | undefined;
  idFactory?: (() => string) | undefined;
  /** Label of the host driving the mission (e.g. "cli", "mcp"). */
  host?: string | undefined;
}

function now(deps: MissionDeps): Date {
  return (deps.clock ?? systemClock)();
}

function record(
  deps: MissionDeps,
  mission: MissionState,
  type: MissionEventType,
  payload: Record<string, unknown> = {},
): MissionState {
  appendMissionEvent(deps.workspace, mission.missionId, {
    at: now(deps).toISOString(),
    type,
    ...payload,
  });
  return {
    ...mission,
    counters: { ...mission.counters, events: mission.counters.events + 1 },
  };
}

function transition(deps: MissionDeps, mission: MissionState, to: MissionState['status']): MissionState {
  assertMissionTransition(mission.status, to);
  const moved: MissionState = { ...mission, status: to, updatedAt: now(deps).toISOString() };
  return record(deps, moved, 'status_changed', { from: mission.status, to });
}

function persist(deps: MissionDeps, mission: MissionState): MissionState {
  return writeMissionState(deps.workspace, {
    ...mission,
    updatedAt: now(deps).toISOString(),
  });
}

function assertNotFinal(mission: MissionState): void {
  if (isFinalMissionStatus(mission.status)) {
    throw new MissionError('SBM004', `Mission ${mission.missionId} is ${mission.status} and read-only.`);
  }
}

const DISCOVERY_STATUSES: readonly MissionState['status'][] = [
  'IDEA',
  'DISCOVERING',
  'NEEDS_DECISION',
  'CONTRACT_READY',
];

function assertDiscoveryOpen(mission: MissionState, what: string): void {
  assertNotFinal(mission);
  if (!DISCOVERY_STATUSES.includes(mission.status)) {
    throw new MissionError(
      'SBM003',
      `Cannot record ${what} while the mission is ${mission.status}. ` +
        'Discovery records are accepted only before synthesis; reopen discovery first.',
      { remediation: ['Reopen discovery with `specbridge mission reopen <id>` (a material change restarts the approval lifecycle).'] },
    );
  }
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

// ---------------------------------------------------------------------------
// Begin
// ---------------------------------------------------------------------------

export interface BeginMissionRequest {
  name: string;
  /** The user's high-level direction, verbatim. Data, never instructions. */
  goal: string;
}

export function beginMission(deps: MissionDeps, request: BeginMissionRequest): MissionState {
  const name = request.name.trim();
  const goal = request.goal.trim();
  if (name.length === 0 || goal.length === 0) {
    throw new MissionError('SBM005', 'A mission needs a name and a stated goal.', {
      remediation: ['Describe the product direction in one or two sentences.'],
    });
  }
  const createdAt = now(deps).toISOString();
  const mission: MissionState = missionStateSchema.parse({
    schemaVersion: MISSION_STATE_SCHEMA_VERSION,
    missionId: `m-${(deps.idFactory ?? randomUUID)()}`,
    name: name.slice(0, MISSION_LIMITS.maxNameChars),
    status: 'IDEA',
    goal: goal.slice(0, MISSION_LIMITS.maxTextChars),
    createdAt,
    updatedAt: createdAt,
    host: deps.host ?? 'cli',
  });
  initializeMissionRecord(deps.workspace, mission);
  writeConstitution(deps.workspace, mission.missionId, {
    schemaVersion: MISSION_CONSTITUTION_SCHEMA_VERSION,
    missionId: mission.missionId,
    version: 0,
    updatedAt: createdAt,
    rules: [],
  });
  const recorded = record(deps, mission, 'mission_created', { name: mission.name });
  const persisted = persist(deps, recorded);
  refreshCoverage(deps, persisted);
  return persisted;
}

// ---------------------------------------------------------------------------
// Conversation turns
// ---------------------------------------------------------------------------

export interface RecordTurnRequest {
  speaker: TurnSpeaker;
  kind: TurnKind;
  text: string;
  /** Ids of records this turn addresses (validated to exist when given). */
  refs?: string[] | undefined;
  inReplyTo?: string | undefined;
}

export interface RecordTurnResult {
  mission: MissionState;
  turn: ConversationTurn;
}

export function recordTurn(
  deps: MissionDeps,
  missionId: string,
  request: RecordTurnRequest,
): RecordTurnResult {
  let mission = requireMissionState(deps.workspace, missionId);
  assertNotFinal(mission);
  if (mission.counters.turns >= MISSION_LIMITS.maxTurns) {
    throw new MissionError('SBM006', `The mission reached its ${MISSION_LIMITS.maxTurns}-turn bound.`);
  }
  const text = request.text.trim();
  if (text.length === 0) {
    throw new MissionError('SBM005', 'A turn needs visible text.');
  }
  if (request.inReplyTo !== undefined && findTurn(deps.workspace, missionId, request.inReplyTo) === undefined) {
    throw new MissionError('SBM005', `Turn "${request.inReplyTo}" does not exist; inReplyTo must reference a recorded turn.`);
  }

  const sequence = mission.sequences.turn + 1;
  const turn: ConversationTurn = {
    turnId: `t-${sequence}`,
    at: now(deps).toISOString(),
    speaker: request.speaker,
    kind: request.kind,
    text: text.slice(0, MISSION_LIMITS.maxTurnTextChars),
    refs: (request.refs ?? []).slice(0, MISSION_LIMITS.maxRefsPerRecord),
    ...(request.inReplyTo !== undefined ? { inReplyTo: request.inReplyTo } : {}),
  };
  appendTurn(deps.workspace, missionId, turn);

  mission = {
    ...mission,
    sequences: { ...mission.sequences, turn: sequence },
    counters: { ...mission.counters, turns: mission.counters.turns + 1 },
  };
  mission = record(deps, mission, 'turn_recorded', {
    turnId: turn.turnId,
    speaker: turn.speaker,
    kind: turn.kind,
  });
  // The first turn opens discovery.
  if (mission.status === 'IDEA') {
    mission = transition(deps, mission, 'DISCOVERING');
  }
  return { mission: persist(deps, mission), turn };
}

// ---------------------------------------------------------------------------
// Assessment: facts, questions, decisions, and durable artifacts
// ---------------------------------------------------------------------------

export interface FactInput {
  statement: string;
  provenance: MissionProvenanceKind;
  sourceTurnId?: string | undefined;
  topics?: DiscoveryTopic[] | undefined;
  supersedesFactId?: string | undefined;
}

export interface QuestionInput {
  question: string;
  whyItMatters: string;
  topics?: DiscoveryTopic[] | undefined;
  affectedSurfaces?: IrreversibleSurface[] | undefined;
  /** Declared level; the deterministic screen may raise it, never lower it. */
  materiality?: MaterialityLevel | undefined;
  options?: string[] | undefined;
  sourceTurnId?: string | undefined;
}

export interface DecisionInput {
  decision: string;
  rationale?: string | undefined;
  provenance: MissionProvenanceKind;
  sourceTurnId?: string | undefined;
  questionId?: string | undefined;
  topics?: DiscoveryTopic[] | undefined;
  marksNotApplicable?: DiscoveryTopic[] | undefined;
  supersedesDecisionId?: string | undefined;
}

export interface ConstitutionRuleInput {
  statement: string;
  rationale?: string | undefined;
  /** Decisions this rule compiles from. At least one is required. */
  decisionIds: string[];
  turnIds?: string[] | undefined;
  affectedContractIds?: string[] | undefined;
  guardPatterns?: string[] | undefined;
  supersedesRuleId?: string | undefined;
}

export interface AdrInput {
  title: string;
  context: string;
  decision: string;
  alternatives?: string[] | undefined;
  rationale: string;
  consequences?: string[] | undefined;
  revisitConditions?: string[] | undefined;
  decisionIds?: string[] | undefined;
  turnIds?: string[] | undefined;
  supersedesAdrId?: string | undefined;
}

export interface ContractRequirementInput {
  statement: string;
  decisionIds?: string[] | undefined;
}

export interface ContractInvariantInput {
  statement: string;
  constitutionRuleIds?: string[] | undefined;
  guardPatterns?: string[] | undefined;
}

export interface ContractInput {
  title: string;
  summary: string;
  classification: ContractClassification;
  compatibilityPolicy: CompatibilityPolicy;
  dependsOn?: string[] | undefined;
  requirements: ContractRequirementInput[];
  invariants?: ContractInvariantInput[] | undefined;
  decisionIds: string[];
  turnIds?: string[] | undefined;
}

export interface MissionFieldUpdates {
  nonGoals?: string[] | undefined;
  targetUsers?: string[] | undefined;
  constraints?: string[] | undefined;
  successCriteria?: string[] | undefined;
  assumptions?:
    | { statement: string; topics?: DiscoveryTopic[] | undefined; questionId?: string | undefined }[]
    | undefined;
}

export interface MissionAssessmentInput {
  facts?: FactInput[] | undefined;
  questions?: QuestionInput[] | undefined;
  decisions?: DecisionInput[] | undefined;
  constitutionRules?: ConstitutionRuleInput[] | undefined;
  adrs?: AdrInput[] | undefined;
  contracts?: ContractInput[] | undefined;
  missionUpdates?: MissionFieldUpdates | undefined;
}

export interface MissionAssessmentResult {
  mission: MissionState;
  coverage: MissionCoverage;
  factIds: string[];
  questionIds: string[];
  decisionIds: string[];
  constitutionRuleIds: string[];
  adrIds: string[];
  contractIds: string[];
  /** Questions whose declared materiality the deterministic screen raised. */
  materialityRaised: { questionId: string; from: MaterialityLevel; to: MaterialityLevel }[];
}

function validateSafeRegex(patterns: readonly string[] | undefined, what: string): string[] {
  const validated: string[] = [];
  for (const source of patterns ?? []) {
    try {
      // Compile check only; bounded length is enforced by the schema.
      void new RegExp(source, 'i');
    } catch {
      throw new MissionError('SBM005', `${what} guard pattern is not a valid regular expression: "${source.slice(0, 80)}".`);
    }
    validated.push(source);
  }
  return validated;
}

function requireUserTurn(deps: MissionDeps, missionId: string, turnId: string | undefined, what: string): void {
  if (turnId === undefined) {
    throw new MissionError(
      'SBM007',
      `${what} claims user provenance but references no conversation turn. ` +
        'A user-provenance decision must point at the visible turn that confirms it.',
    );
  }
  const turn = findTurn(deps.workspace, missionId, turnId);
  if (turn === undefined) {
    throw new MissionError('SBM007', `${what} references turn "${turnId}", which does not exist.`);
  }
  if (turn.speaker !== 'user') {
    throw new MissionError(
      'SBM007',
      `${what} references turn "${turnId}", which is an agent turn. ` +
        'Only a user-visible USER turn can confirm a user-provenance decision.',
    );
  }
}

function requireDecisions(
  activeDecisions: readonly DiscoveryDecision[],
  decisionIds: readonly string[],
  what: string,
): void {
  if (decisionIds.length === 0) {
    throw new MissionError(
      'SBM007',
      `${what} must trace to at least one recorded decision (provenance is not optional for durable artifacts).`,
    );
  }
  for (const id of decisionIds) {
    if (!activeDecisions.some((decision) => decision.decisionId === id)) {
      throw new MissionError('SBM007', `${what} references decision "${id}", which does not exist or is superseded.`);
    }
  }
}

/**
 * Record one structured discovery assessment: the model (or user) PROPOSES
 * facts, questions, decisions, and durable artifacts; this function GOVERNS
 * them. Everything is validated, provenance-checked, id-assigned, bounded,
 * persisted, and folded into coverage in one pass.
 */
export function recordAssessment(
  deps: MissionDeps,
  missionId: string,
  input: MissionAssessmentInput,
): MissionAssessmentResult {
  let mission = requireMissionState(deps.workspace, missionId);
  assertDiscoveryOpen(mission, 'a discovery assessment');
  const at = now(deps).toISOString();

  // Capacity is a property of the whole assessment, not of the next append.
  // Refuse an oversized batch before writing any record or event so callers
  // never observe a facts file ahead of the persisted mission high-water mark.
  const incomingFacts = input.facts?.length ?? 0;
  if (mission.counters.facts + incomingFacts > MISSION_LIMITS.maxFacts) {
    throw new MissionError(
      'SBM006',
      `Recording ${incomingFacts} fact(s) would exceed the mission's ` +
        `${MISSION_LIMITS.maxFacts}-fact bound (${mission.counters.facts} already recorded).`,
    );
  }

  const factIds: string[] = [];
  const questionIds: string[] = [];
  const decisionIds: string[] = [];
  const constitutionRuleIds: string[] = [];
  const adrIds: string[] = [];
  const contractIds: string[] = [];
  const materialityRaised: MissionAssessmentResult['materialityRaised'] = [];

  // --- Facts ---------------------------------------------------------------
  for (const fact of input.facts ?? []) {
    if (mission.counters.facts >= MISSION_LIMITS.maxFacts) {
      throw new MissionError('SBM006', `The mission reached its ${MISSION_LIMITS.maxFacts}-fact bound.`);
    }
    if (fact.sourceTurnId !== undefined && findTurn(deps.workspace, missionId, fact.sourceTurnId) === undefined) {
      throw new MissionError('SBM005', `Fact references turn "${fact.sourceTurnId}", which does not exist.`);
    }
    if (fact.supersedesFactId !== undefined) {
      const existing = readFacts(deps.workspace, missionId).find(
        (candidate) => candidate.factId === fact.supersedesFactId,
      );
      if (existing === undefined) {
        throw new MissionError('SBM009', `Fact "${fact.supersedesFactId}" cannot be superseded: it does not exist.`);
      }
      appendFact(deps.workspace, missionId, { ...existing, status: 'superseded' });
      mission = record(deps, mission, 'fact_superseded', { factId: existing.factId });
    }
    const sequence = mission.sequences.fact + 1;
    const recordFact: MissionFact = {
      factId: `F-${pad(sequence, 3)}`,
      statement: fact.statement.slice(0, MISSION_LIMITS.maxTextChars),
      provenance: fact.provenance,
      ...(fact.sourceTurnId !== undefined ? { sourceTurnId: fact.sourceTurnId } : {}),
      topics: (fact.topics ?? []).slice(0, MISSION_LIMITS.maxRefsPerRecord),
      status: 'active',
      ...(fact.supersedesFactId !== undefined ? { supersedes: fact.supersedesFactId } : {}),
      recordedAt: at,
    };
    appendFact(deps.workspace, missionId, recordFact);
    factIds.push(recordFact.factId);
    mission = {
      ...mission,
      sequences: { ...mission.sequences, fact: sequence },
      counters: { ...mission.counters, facts: mission.counters.facts + 1 },
    };
    mission = record(deps, mission, 'fact_recorded', {
      factId: recordFact.factId,
      provenance: recordFact.provenance,
    });
  }

  // --- Questions -------------------------------------------------------------
  for (const question of input.questions ?? []) {
    if (mission.counters.questions >= MISSION_LIMITS.maxQuestions) {
      throw new MissionError('SBM006', `The mission reached its ${MISSION_LIMITS.maxQuestions}-question bound.`);
    }
    const assessment = assessMateriality({
      questionText: question.question,
      whyItMatters: question.whyItMatters,
      declaredSurfaces: question.affectedSurfaces,
      declaredLevel: question.materiality,
    });
    const sequence = mission.sequences.question + 1;
    const recordQuestion: DiscoveryQuestion = {
      questionId: `Q-${pad(sequence, 3)}`,
      question: question.question.slice(0, MISSION_LIMITS.maxTextChars),
      whyItMatters: question.whyItMatters.slice(0, MISSION_LIMITS.maxTextChars),
      topics: (question.topics ?? []).slice(0, MISSION_LIMITS.maxRefsPerRecord),
      affectedSurfaces: assessment.surfaces,
      materiality: assessment.level,
      ...(assessment.raisedFrom !== undefined ? { materialityRaisedFrom: assessment.raisedFrom } : {}),
      materialityReasons: assessment.reasons.slice(0, MISSION_LIMITS.maxListItems).map((reason) => reason.slice(0, MISSION_LIMITS.maxTextChars)),
      options: (question.options ?? []).slice(0, 10),
      status: 'open',
      ...(question.sourceTurnId !== undefined ? { sourceTurnId: question.sourceTurnId } : {}),
      askedAt: at,
    };
    appendQuestion(deps.workspace, missionId, recordQuestion);
    questionIds.push(recordQuestion.questionId);
    if (assessment.raisedFrom !== undefined) {
      materialityRaised.push({
        questionId: recordQuestion.questionId,
        from: assessment.raisedFrom,
        to: assessment.level,
      });
    }
    mission = {
      ...mission,
      sequences: { ...mission.sequences, question: sequence },
      counters: {
        ...mission.counters,
        questions: mission.counters.questions + 1,
        openQuestions: mission.counters.openQuestions + 1,
      },
    };
    mission = record(deps, mission, 'question_opened', {
      questionId: recordQuestion.questionId,
      materiality: recordQuestion.materiality,
    });
  }

  // --- Decisions --------------------------------------------------------------
  for (const decision of input.decisions ?? []) {
    mission = recordDecisionInternal(deps, missionId, mission, decision, at, decisionIds);
  }

  // --- Constitution rules -------------------------------------------------------
  if ((input.constitutionRules ?? []).length > 0) {
    const activeDecisions = readDecisions(deps.workspace, missionId).filter(
      (decision) => decision.status === 'active',
    );
    let constitution =
      readConstitution(deps.workspace, missionId) ??
      ({
        schemaVersion: MISSION_CONSTITUTION_SCHEMA_VERSION,
        missionId,
        version: 0,
        updatedAt: at,
        rules: [],
      } satisfies MissionConstitution);
    for (const rule of input.constitutionRules ?? []) {
      if (constitution.rules.filter((existing) => existing.status === 'active').length >= MISSION_LIMITS.maxConstitutionRules) {
        throw new MissionError(
          'SBM006',
          `The constitution reached its ${MISSION_LIMITS.maxConstitutionRules}-rule bound; a constitution is a small set of strong invariants.`,
        );
      }
      requireDecisions(activeDecisions, rule.decisionIds, 'A constitution rule');
      const guardPatterns = validateSafeRegex(rule.guardPatterns, 'A constitution rule');
      let rules = constitution.rules;
      if (rule.supersedesRuleId !== undefined) {
        const previous = rules.find((candidate) => candidate.ruleId === rule.supersedesRuleId);
        if (previous === undefined || previous.status !== 'active') {
          throw new MissionError('SBM009', `Constitution rule "${rule.supersedesRuleId}" cannot be superseded: not found or already superseded.`);
        }
        rules = rules.map((candidate) =>
          candidate.ruleId === rule.supersedesRuleId
            ? { ...candidate, status: 'superseded' as const }
            : candidate,
        );
        mission = record(deps, mission, 'constitution_rule_superseded', { ruleId: rule.supersedesRuleId });
      }
      const sequence = mission.sequences.constitutionRule + 1;
      const ruleId = `CON-${pad(sequence, 3)}`;
      rules = [
        ...rules,
        {
          ruleId,
          version: 1,
          statement: rule.statement.slice(0, MISSION_LIMITS.maxTextChars),
          ...(rule.rationale !== undefined ? { rationale: rule.rationale.slice(0, MISSION_LIMITS.maxTextChars) } : {}),
          status: 'active' as const,
          decisionIds: rule.decisionIds.slice(0, MISSION_LIMITS.maxRefsPerRecord),
          turnIds: (rule.turnIds ?? []).slice(0, MISSION_LIMITS.maxRefsPerRecord),
          affectedContractIds: (rule.affectedContractIds ?? []).slice(0, MISSION_LIMITS.maxRefsPerRecord),
          ...(rule.supersedesRuleId !== undefined ? { supersedes: rule.supersedesRuleId } : {}),
          recordedAt: at,
          guardPatterns,
        },
      ];
      constitution = {
        ...constitution,
        version: constitution.version + 1,
        updatedAt: at,
        rules,
      };
      constitutionRuleIds.push(ruleId);
      mission = {
        ...mission,
        sequences: { ...mission.sequences, constitutionRule: sequence },
        counters: { ...mission.counters, constitutionRules: mission.counters.constitutionRules + 1 },
      };
      mission = record(deps, mission, 'constitution_rule_recorded', { ruleId });
    }
    writeConstitution(deps.workspace, missionId, constitution);
  }

  // --- ADRs ---------------------------------------------------------------------
  if ((input.adrs ?? []).length > 0) {
    const activeDecisions = readDecisions(deps.workspace, missionId).filter(
      (decision) => decision.status === 'active',
    );
    for (const adr of input.adrs ?? []) {
      if (mission.counters.adrs >= MISSION_LIMITS.maxAdrs) {
        throw new MissionError('SBM006', `The mission reached its ${MISSION_LIMITS.maxAdrs}-ADR bound.`);
      }
      const provenanceDecisions = adr.decisionIds ?? [];
      const provenanceTurns = adr.turnIds ?? [];
      if (provenanceDecisions.length === 0 && provenanceTurns.length === 0) {
        throw new MissionError('SBM007', 'An ADR must trace to at least one decision or conversation turn.');
      }
      for (const id of provenanceDecisions) {
        if (!activeDecisions.some((decision) => decision.decisionId === id)) {
          throw new MissionError('SBM007', `ADR references decision "${id}", which does not exist or is superseded.`);
        }
      }
      const sequence = mission.sequences.adr + 1;
      const adrId = `ADR-${pad(sequence, 4)}`;
      const document: MissionAdr = missionAdrSchema.parse({
        schemaVersion: MISSION_ADR_SCHEMA_VERSION,
        adrId,
        title: adr.title.slice(0, MISSION_LIMITS.maxShortTextChars),
        context: adr.context.slice(0, MISSION_LIMITS.maxTextChars),
        decision: adr.decision.slice(0, MISSION_LIMITS.maxTextChars),
        alternatives: (adr.alternatives ?? []).slice(0, MISSION_LIMITS.maxListItems),
        rationale: adr.rationale.slice(0, MISSION_LIMITS.maxTextChars),
        consequences: (adr.consequences ?? []).slice(0, MISSION_LIMITS.maxListItems),
        revisitConditions: (adr.revisitConditions ?? []).slice(0, MISSION_LIMITS.maxListItems),
        status: 'accepted',
        decisionIds: provenanceDecisions.slice(0, MISSION_LIMITS.maxRefsPerRecord),
        turnIds: provenanceTurns.slice(0, MISSION_LIMITS.maxRefsPerRecord),
        ...(adr.supersedesAdrId !== undefined ? { supersedes: adr.supersedesAdrId } : {}),
        recordedAt: at,
      });
      storeAdr(deps.workspace, missionId, document);
      adrIds.push(adrId);
      mission = {
        ...mission,
        sequences: { ...mission.sequences, adr: sequence },
        counters: { ...mission.counters, adrs: mission.counters.adrs + 1 },
      };
      mission = record(deps, mission, 'adr_recorded', { adrId });
    }
  }

  // --- Contracts ------------------------------------------------------------------
  if ((input.contracts ?? []).length > 0) {
    const activeDecisions = readDecisions(deps.workspace, missionId).filter(
      (decision) => decision.status === 'active',
    );
    for (const contract of input.contracts ?? []) {
      if (mission.counters.contracts >= MISSION_LIMITS.maxContracts) {
        throw new MissionError('SBM006', `The mission reached its ${MISSION_LIMITS.maxContracts}-contract bound.`);
      }
      requireDecisions(activeDecisions, contract.decisionIds, `Contract "${contract.title}"`);
      if (contract.requirements.length === 0) {
        throw new MissionError('SBM005', `Contract "${contract.title}" needs at least one requirement.`);
      }
      const sequence = mission.sequences.contract + 1;
      const contractId = `CTR-${pad(sequence, 3)}`;
      const document: ProductContract = productContractSchema.parse({
        schemaVersion: MISSION_CONTRACT_SCHEMA_VERSION,
        contractId,
        revision: 1,
        title: contract.title.slice(0, MISSION_LIMITS.maxShortTextChars),
        summary: contract.summary.slice(0, MISSION_LIMITS.maxTextChars),
        classification: contract.classification,
        compatibilityPolicy: contract.compatibilityPolicy,
        dependsOn: (contract.dependsOn ?? []).slice(0, MISSION_LIMITS.maxRefsPerRecord),
        requirements: contract.requirements.slice(0, MISSION_LIMITS.maxContractRequirements).map((requirement, index) => ({
          requirementId: `R${index + 1}`,
          statement: requirement.statement.slice(0, MISSION_LIMITS.maxTextChars),
          decisionIds: (requirement.decisionIds ?? []).slice(0, MISSION_LIMITS.maxRefsPerRecord),
        })),
        invariants: (contract.invariants ?? []).slice(0, MISSION_LIMITS.maxContractRequirements).map((invariant, index) => ({
          invariantId: `I${index + 1}`,
          statement: invariant.statement.slice(0, MISSION_LIMITS.maxTextChars),
          constitutionRuleIds: (invariant.constitutionRuleIds ?? []).slice(0, MISSION_LIMITS.maxRefsPerRecord),
          guardPatterns: validateSafeRegex(invariant.guardPatterns, `Contract "${contract.title}"`),
        })),
        status: 'active',
        decisionIds: contract.decisionIds.slice(0, MISSION_LIMITS.maxRefsPerRecord),
        turnIds: (contract.turnIds ?? []).slice(0, MISSION_LIMITS.maxRefsPerRecord),
        recordedAt: at,
      });
      storeContractRevision(deps.workspace, missionId, document);
      contractIds.push(contractId);
      mission = {
        ...mission,
        sequences: { ...mission.sequences, contract: sequence },
        counters: { ...mission.counters, contracts: mission.counters.contracts + 1 },
      };
      mission = record(deps, mission, 'contract_recorded', { contractId, revision: 1 });
    }
  }

  // --- Mission field updates ---------------------------------------------------------
  const updates = input.missionUpdates;
  if (updates !== undefined) {
    const bounded = (values: string[] | undefined): string[] | undefined =>
      values?.slice(0, MISSION_LIMITS.maxListItems).map((value) => value.slice(0, MISSION_LIMITS.maxTextChars));
    mission = {
      ...mission,
      ...(updates.nonGoals !== undefined ? { nonGoals: bounded(updates.nonGoals) ?? [] } : {}),
      ...(updates.targetUsers !== undefined ? { targetUsers: bounded(updates.targetUsers) ?? [] } : {}),
      ...(updates.constraints !== undefined ? { constraints: bounded(updates.constraints) ?? [] } : {}),
      ...(updates.successCriteria !== undefined
        ? { successCriteria: bounded(updates.successCriteria) ?? [] }
        : {}),
      ...(updates.assumptions !== undefined
        ? {
            assumptions: updates.assumptions.slice(0, MISSION_LIMITS.maxListItems).map((assumption, index) => ({
              id: `A-${pad(index + 1, 3)}`,
              statement: assumption.statement.slice(0, MISSION_LIMITS.maxTextChars),
              topics: (assumption.topics ?? []).slice(0, MISSION_LIMITS.maxRefsPerRecord),
              ...(assumption.questionId !== undefined ? { questionId: assumption.questionId } : {}),
            })),
          }
        : {}),
    };
  }

  // --- Coverage + status reconciliation ------------------------------------------------
  if (mission.status === 'IDEA') {
    mission = transition(deps, mission, 'DISCOVERING');
  }
  const coverage = refreshCoverage(deps, mission);
  mission = reconcileStatusWithCoverage(deps, mission, coverage);

  return {
    mission: persist(deps, mission),
    coverage,
    factIds,
    questionIds,
    decisionIds,
    constitutionRuleIds,
    adrIds,
    contractIds,
    materialityRaised,
  };
}

function recordDecisionInternal(
  deps: MissionDeps,
  missionId: string,
  mission: MissionState,
  input: DecisionInput,
  at: string,
  outIds: string[],
): MissionState {
  if (mission.counters.decisions >= MISSION_LIMITS.maxDecisions) {
    throw new MissionError('SBM006', `The mission reached its ${MISSION_LIMITS.maxDecisions}-decision bound.`);
  }
  if (UNSAFE_DECISION_PROVENANCE.includes(input.provenance)) {
    throw new MissionError(
      'SBM007',
      `A decision cannot rest on "${input.provenance}" provenance. ` +
        'Record it as a fact or an open question; a decision is a durable commitment.',
      { remediation: ['Ask the user, or cite an approved spec, repository evidence, configuration, or a prior confirmed decision.'] },
    );
  }
  if (input.provenance === 'known-from-user') {
    requireUserTurn(deps, missionId, input.sourceTurnId, 'A decision');
  } else if (input.sourceTurnId !== undefined && findTurn(deps.workspace, missionId, input.sourceTurnId) === undefined) {
    throw new MissionError('SBM005', `Decision references turn "${input.sourceTurnId}", which does not exist.`);
  }

  const questions = readQuestions(deps.workspace, missionId);
  let answeredQuestion: DiscoveryQuestion | undefined;
  if (input.questionId !== undefined) {
    answeredQuestion = questions.find((question) => question.questionId === input.questionId);
    if (answeredQuestion === undefined) {
      throw new MissionError('SBM009', `Decision answers question "${input.questionId}", which does not exist.`);
    }
  }

  if (input.supersedesDecisionId !== undefined) {
    const previous = readDecisions(deps.workspace, missionId).find(
      (candidate) => candidate.decisionId === input.supersedesDecisionId,
    );
    if (previous === undefined) {
      throw new MissionError('SBM009', `Decision "${input.supersedesDecisionId}" cannot be superseded: it does not exist.`);
    }
    appendDecision(deps.workspace, missionId, { ...previous, status: 'superseded' });
    mission = record(deps, mission, 'decision_superseded', { decisionId: previous.decisionId });
  }

  const sequence = mission.sequences.decision + 1;
  const decision: DiscoveryDecision = {
    decisionId: `DEC-${pad(sequence, 3)}`,
    ...(input.questionId !== undefined ? { questionId: input.questionId } : {}),
    decision: input.decision.slice(0, MISSION_LIMITS.maxTextChars),
    ...(input.rationale !== undefined ? { rationale: input.rationale.slice(0, MISSION_LIMITS.maxTextChars) } : {}),
    provenance: input.provenance,
    ...(input.sourceTurnId !== undefined ? { sourceTurnId: input.sourceTurnId } : {}),
    topics: [
      ...new Set([...(input.topics ?? []), ...(answeredQuestion?.topics ?? [])]),
    ].slice(0, MISSION_LIMITS.maxRefsPerRecord),
    marksNotApplicable: (input.marksNotApplicable ?? []).slice(0, MISSION_LIMITS.maxRefsPerRecord),
    status: 'active',
    ...(input.supersedesDecisionId !== undefined ? { supersedes: input.supersedesDecisionId } : {}),
    resultingArtifactIds: [],
    decidedAt: at,
  };
  appendDecision(deps.workspace, missionId, decision);
  outIds.push(decision.decisionId);

  mission = {
    ...mission,
    sequences: { ...mission.sequences, decision: sequence },
    counters: { ...mission.counters, decisions: mission.counters.decisions + 1 },
  };
  mission = record(deps, mission, 'decision_recorded', {
    decisionId: decision.decisionId,
    provenance: decision.provenance,
    ...(decision.questionId !== undefined ? { questionId: decision.questionId } : {}),
  });

  if (answeredQuestion !== undefined && answeredQuestion.status === 'open') {
    appendQuestion(deps.workspace, missionId, {
      ...answeredQuestion,
      status: 'answered',
      resolvedByDecisionId: decision.decisionId,
    });
    mission = {
      ...mission,
      counters: { ...mission.counters, openQuestions: Math.max(0, mission.counters.openQuestions - 1) },
    };
    mission = record(deps, mission, 'question_answered', {
      questionId: answeredQuestion.questionId,
      decisionId: decision.decisionId,
    });
  }
  return mission;
}

// ---------------------------------------------------------------------------
// Answering questions directly
// ---------------------------------------------------------------------------

export interface AnswerQuestionRequest {
  questionId: string;
  /** The user's answer, verbatim. */
  answer: string;
  /** Topics this answer explicitly marks not applicable. */
  marksNotApplicable?: DiscoveryTopic[] | undefined;
}

export interface AnswerQuestionResult {
  mission: MissionState;
  decision: DiscoveryDecision;
  coverage: MissionCoverage;
}

/**
 * Record the user's answer to one open question: an answering USER turn, a
 * `known-from-user` decision bound to it, and the coverage/status fold — in
 * one operation, so a CLI answer and an MCP-relayed answer are identical.
 */
export function answerQuestion(
  deps: MissionDeps,
  missionId: string,
  request: AnswerQuestionRequest,
): AnswerQuestionResult {
  const mission = requireMissionState(deps.workspace, missionId);
  assertDiscoveryOpen(mission, 'an answer');
  const question = readQuestions(deps.workspace, missionId).find(
    (candidate) => candidate.questionId === request.questionId,
  );
  if (question === undefined) {
    throw new MissionError('SBM009', `Question "${request.questionId}" does not exist.`);
  }
  if (question.status !== 'open') {
    throw new MissionError('SBM005', `Question "${request.questionId}" is ${question.status}, not open.`);
  }
  const answer = request.answer.trim();
  if (answer.length === 0) {
    throw new MissionError('SBM005', 'An answer needs text.');
  }

  const { turn } = recordTurn(deps, missionId, {
    speaker: 'user',
    kind: 'statement',
    text: answer,
    refs: [question.questionId],
  });
  const assessment = recordAssessment(deps, missionId, {
    decisions: [
      {
        decision: answer,
        provenance: 'known-from-user',
        sourceTurnId: turn.turnId,
        questionId: question.questionId,
        topics: question.topics,
        ...(request.marksNotApplicable !== undefined
          ? { marksNotApplicable: request.marksNotApplicable }
          : {}),
      },
    ],
  });
  const decisionId = assessment.decisionIds[0];
  const decision = readDecisions(deps.workspace, missionId).find(
    (candidate) => candidate.decisionId === decisionId,
  );
  if (decision === undefined) {
    throw new MissionError('SBM002', 'The recorded decision could not be read back.');
  }
  return { mission: assessment.mission, decision, coverage: assessment.coverage };
}

export function withdrawQuestion(
  deps: MissionDeps,
  missionId: string,
  request: { questionId: string; reason: string },
): MissionState {
  let mission = requireMissionState(deps.workspace, missionId);
  assertDiscoveryOpen(mission, 'a question withdrawal');
  const question = readQuestions(deps.workspace, missionId).find(
    (candidate) => candidate.questionId === request.questionId,
  );
  if (question === undefined || question.status !== 'open') {
    throw new MissionError('SBM009', `Question "${request.questionId}" is not open.`);
  }
  appendQuestion(deps.workspace, missionId, { ...question, status: 'withdrawn' });
  mission = {
    ...mission,
    counters: { ...mission.counters, openQuestions: Math.max(0, mission.counters.openQuestions - 1) },
  };
  mission = record(deps, mission, 'question_withdrawn', {
    questionId: question.questionId,
    reason: request.reason.slice(0, 500),
  });
  const coverage = refreshCoverage(deps, mission);
  mission = reconcileStatusWithCoverage(deps, mission, coverage);
  return persist(deps, mission);
}

// ---------------------------------------------------------------------------
// Coverage and status reconciliation
// ---------------------------------------------------------------------------

/** Recompute and persist coverage from the folded current records. */
export function refreshCoverage(deps: MissionDeps, mission: MissionState): MissionCoverage {
  const coverage = computeCoverage({
    missionId: mission.missionId,
    facts: readFacts(deps.workspace, mission.missionId),
    questions: readQuestions(deps.workspace, mission.missionId),
    decisions: readDecisions(deps.workspace, mission.missionId),
    now: now(deps),
  });
  writeCoverage(deps.workspace, mission.missionId, coverage);
  return coverage;
}

/**
 * Fold coverage into the status: open blocking questions move discovery to
 * NEEDS_DECISION; resolving the last one moves it back. A mission that was
 * CONTRACT_READY loses that status the moment the gate no longer holds —
 * the state machine never lies about readiness.
 */
function reconcileStatusWithCoverage(
  deps: MissionDeps,
  mission: MissionState,
  coverage: MissionCoverage,
): MissionState {
  const blocking = coverage.blockingQuestionIds.length > 0;
  if (mission.status === 'DISCOVERING' && blocking) {
    return transition(deps, mission, 'NEEDS_DECISION');
  }
  if (mission.status === 'NEEDS_DECISION' && !blocking) {
    return transition(deps, mission, 'DISCOVERING');
  }
  if (mission.status === 'CONTRACT_READY' && !coverage.contractReady) {
    return transition(deps, mission, blocking ? 'NEEDS_DECISION' : 'DISCOVERING');
  }
  return mission;
}

/**
 * Move the mission to CONTRACT_READY. Explicit — the human (through the
 * plugin or CLI) asks for it; the deterministic coverage gate decides.
 */
export function markContractReady(deps: MissionDeps, missionId: string): { mission: MissionState; coverage: MissionCoverage } {
  let mission = requireMissionState(deps.workspace, missionId);
  assertNotFinal(mission);
  const coverage = refreshCoverage(deps, mission);
  if (!coverage.contractReady) {
    throw new MissionError(
      'SBM008',
      `The mission cannot reach CONTRACT_READY: ${coverage.reasons.join(' ')}`,
      {
        remediation: [
          'Answer the blocking questions with `specbridge mission answer`,',
          'or record decisions covering the unresolved required topics.',
        ],
        details: {
          blockingQuestionIds: coverage.blockingQuestionIds,
          unresolvedRequiredTopics: coverage.unresolvedRequiredTopics,
        },
      },
    );
  }
  if (mission.status !== 'CONTRACT_READY') {
    mission = transition(deps, mission, 'CONTRACT_READY');
    mission = persist(deps, mission);
  }
  return { mission, coverage };
}

/** Reopen discovery after synthesis or approval — a material change surfaced. */
export function reopenDiscovery(deps: MissionDeps, missionId: string, reason: string): MissionState {
  let mission = requireMissionState(deps.workspace, missionId);
  assertNotFinal(mission);
  if (DISCOVERY_STATUSES.includes(mission.status) && mission.status !== 'CONTRACT_READY') {
    return mission;
  }
  mission = transition(deps, mission, 'DISCOVERING');
  mission = record(deps, mission, 'status_changed', { reason: reason.slice(0, 500), reopened: true });
  return persist(deps, mission);
}

export function abandonMission(deps: MissionDeps, missionId: string, reason: string): MissionState {
  let mission = requireMissionState(deps.workspace, missionId);
  if (isFinalMissionStatus(mission.status)) return mission; // idempotent
  const at = now(deps).toISOString();
  mission = transition(deps, mission, 'ABANDONED');
  mission = record(deps, mission, 'mission_abandoned', { reason: reason.slice(0, 500) });
  return persist(deps, { ...mission, abandonedAt: at, abandonReason: reason.slice(0, MISSION_LIMITS.maxTextChars) });
}

// ---------------------------------------------------------------------------
// Contract change requests
// ---------------------------------------------------------------------------

export interface CreateCcrRequest {
  contractId: string;
  problem: string;
  proposal: string;
  affected?: string[] | undefined;
  /** Audit label of the creator: a worker id, "cli", or "mcp". */
  raisedBy: string;
  originWorkUnitId?: string | undefined;
  originJobId?: string | undefined;
}

export interface CreateCcrResult {
  mission: MissionState;
  ccr: ContractChangeRequest;
  /** True when the request is material and execution must stop for a human. */
  material: boolean;
}

/**
 * Create a ContractChangeRequest. Anyone may raise one; nobody but the
 * human-only decision path may approve one. Materiality is deterministic:
 * a request against a public or frozen/additive-only contract — or whose
 * text trips the irreversibility screen — lands as NEEDS_HUMAN.
 */
export function createContractChangeRequest(
  deps: MissionDeps,
  missionId: string,
  request: CreateCcrRequest,
): CreateCcrResult {
  let mission = requireMissionState(deps.workspace, missionId);
  assertNotFinal(mission);
  if (mission.counters.ccrs >= MISSION_LIMITS.maxCcrs) {
    throw new MissionError('SBM006', `The mission reached its ${MISSION_LIMITS.maxCcrs}-change-request bound.`);
  }
  const contract = readContract(deps.workspace, missionId, request.contractId);
  if (contract === undefined) {
    throw new MissionError('SBM009', `Contract "${request.contractId}" does not exist in this mission's registry.`);
  }

  const screen = assessMateriality({
    questionText: request.problem,
    whyItMatters: request.proposal,
  });
  const material =
    contract.classification === 'public' ||
    contract.compatibilityPolicy === 'frozen' ||
    contract.compatibilityPolicy === 'additive-only' ||
    screen.level === 'blocking';

  const sequence = mission.sequences.ccr + 1;
  const at = now(deps).toISOString();
  const ccr: ContractChangeRequest = contractChangeRequestSchema.parse({
    schemaVersion: MISSION_CCR_SCHEMA_VERSION,
    ccrId: `CCR-${pad(sequence, 3)}`,
    contractId: contract.contractId,
    contractRevision: contract.revision,
    problem: request.problem.slice(0, MISSION_LIMITS.maxTextChars),
    proposal: request.proposal.slice(0, MISSION_LIMITS.maxTextChars),
    affected: (request.affected ?? []).slice(0, MISSION_LIMITS.maxListItems),
    status: material ? 'NEEDS_HUMAN' : 'PROPOSED',
    raisedBy: request.raisedBy.slice(0, MISSION_LIMITS.maxShortTextChars),
    ...(request.originWorkUnitId !== undefined ? { originWorkUnitId: request.originWorkUnitId } : {}),
    ...(request.originJobId !== undefined ? { originJobId: request.originJobId } : {}),
    createdAt: at,
  });
  writeCcr(deps.workspace, missionId, ccr);
  mission = {
    ...mission,
    sequences: { ...mission.sequences, ccr: sequence },
    counters: { ...mission.counters, ccrs: mission.counters.ccrs + 1 },
  };
  mission = record(deps, mission, 'ccr_created', {
    ccrId: ccr.ccrId,
    contractId: ccr.contractId,
    status: ccr.status,
    raisedBy: ccr.raisedBy,
  });
  return { mission: persist(deps, mission), ccr, material };
}

export interface DecideCcrRequest {
  ccrId: string;
  decision: 'approved' | 'rejected';
  note?: string | undefined;
  /**
   * Optional full replacement content for the next contract revision. When
   * absent, an approved request produces a derived revision: the previous
   * content plus one appended requirement carrying the proposal.
   */
  revisedContract?: Partial<ProductContract> | undefined;
}

export interface DecideCcrResult {
  mission: MissionState;
  ccr: ContractChangeRequest;
  /** The new contract revision, when the request was approved and applied. */
  contract?: ProductContract;
}

/**
 * Record the HUMAN decision on a contract change request and, on approval,
 * apply it as the next immutable contract revision.
 *
 * This function is the human-authorized path of §contract-change: it is
 * wired to the CLI only. The MCP surface exposes CCR creation and reading,
 * never this. A worker result cannot reach it, and tests assert the MCP
 * tool registry stays free of any ccr-approval tool.
 */
export function decideContractChangeRequest(
  deps: MissionDeps,
  missionId: string,
  request: DecideCcrRequest,
): DecideCcrResult {
  let mission = requireMissionState(deps.workspace, missionId);
  assertNotFinal(mission);
  const existing = readCcr(deps.workspace, missionId, request.ccrId);
  if (existing === undefined) {
    throw new MissionError('SBM009', `Change request "${request.ccrId}" does not exist.`);
  }
  if (existing.status !== 'PROPOSED' && existing.status !== 'NEEDS_HUMAN') {
    throw new MissionError('SBM013', `Change request ${existing.ccrId} is already ${existing.status}.`);
  }
  const at = now(deps).toISOString();

  if (request.decision === 'rejected') {
    const rejected: ContractChangeRequest = {
      ...existing,
      status: 'REJECTED',
      decidedAt: at,
      ...(request.note !== undefined ? { decisionNote: request.note.slice(0, MISSION_LIMITS.maxTextChars) } : {}),
    };
    writeCcr(deps.workspace, missionId, rejected);
    mission = record(deps, mission, 'ccr_decided', { ccrId: existing.ccrId, decision: 'rejected' });
    return { mission: persist(deps, mission), ccr: rejected };
  }

  // Approval: record the human decision as a discovery decision (provenance
  // chain), then apply the next contract revision.
  const current = readContract(deps.workspace, missionId, existing.contractId);
  if (current === undefined) {
    throw new MissionError('SBM009', `Contract "${existing.contractId}" vanished from the registry.`);
  }
  const decisionIds: string[] = [];
  mission = recordDecisionInternal(
    deps,
    missionId,
    mission,
    {
      decision: `Approved ${existing.ccrId} against ${existing.contractId}: ${existing.proposal}`.slice(
        0,
        MISSION_LIMITS.maxTextChars,
      ),
      ...(request.note !== undefined ? { rationale: request.note } : {}),
      provenance: 'known-from-configuration',
      topics: [],
    },
    at,
    decisionIds,
  );

  const nextRevisionNumber = current.revision + 1;
  let nextRevision: ProductContract;
  if (request.revisedContract !== undefined) {
    nextRevision = productContractSchema.parse({
      ...current,
      ...request.revisedContract,
      schemaVersion: MISSION_CONTRACT_SCHEMA_VERSION,
      contractId: current.contractId,
      revision: nextRevisionNumber,
      supersedesRevision: current.revision,
      changeRequestId: existing.ccrId,
      decisionIds: [...current.decisionIds, ...decisionIds].slice(0, MISSION_LIMITS.maxRefsPerRecord),
      recordedAt: at,
      status: 'active',
    });
  } else {
    nextRevision = productContractSchema.parse({
      ...current,
      revision: nextRevisionNumber,
      supersedesRevision: current.revision,
      changeRequestId: existing.ccrId,
      requirements: [
        ...current.requirements,
        {
          requirementId: `R${current.requirements.length + 1}`,
          statement: existing.proposal,
          decisionIds,
        },
      ],
      decisionIds: [...current.decisionIds, ...decisionIds].slice(0, MISSION_LIMITS.maxRefsPerRecord),
      recordedAt: at,
      status: 'active',
    });
  }
  storeContractRevision(deps.workspace, missionId, nextRevision);

  const approved: ContractChangeRequest = {
    ...existing,
    status: 'APPROVED',
    decidedAt: at,
    ...(request.note !== undefined ? { decisionNote: request.note.slice(0, MISSION_LIMITS.maxTextChars) } : {}),
    resultingRevision: nextRevisionNumber,
  };
  writeCcr(deps.workspace, missionId, approved);
  mission = record(deps, mission, 'ccr_decided', { ccrId: existing.ccrId, decision: 'approved' });
  mission = record(deps, mission, 'contract_revised', {
    contractId: current.contractId,
    revision: nextRevisionNumber,
    ccrId: existing.ccrId,
  });
  mission = record(deps, mission, 'ccr_applied', {
    ccrId: existing.ccrId,
    contractId: current.contractId,
    revision: nextRevisionNumber,
  });
  return { mission: persist(deps, mission), ccr: approved, contract: nextRevision };
}

// ---------------------------------------------------------------------------
// Views and checkpoints
// ---------------------------------------------------------------------------

export interface MissionOverview {
  mission: MissionState;
  coverage: MissionCoverage | undefined;
  openQuestions: DiscoveryQuestion[];
  blockingQuestions: DiscoveryQuestion[];
  activeDecisionCount: number;
  constitutionVersion: number;
  activeConstitutionRules: number;
  contractCount: number;
  adrCount: number;
  openCcrs: ContractChangeRequest[];
}

export function describeMission(deps: MissionDeps, missionId: string): MissionOverview {
  const mission = requireMissionState(deps.workspace, missionId);
  const coverage = refreshCoverage(deps, mission);
  const questions = readQuestions(deps.workspace, missionId);
  const openQuestions = questions.filter((question) => question.status === 'open');
  const constitution = readConstitution(deps.workspace, missionId);
  const openCcrs = readCcrs(deps.workspace, missionId).filter(
    (ccr) => ccr.status === 'PROPOSED' || ccr.status === 'NEEDS_HUMAN',
  );
  return {
    mission,
    coverage,
    openQuestions,
    blockingQuestions: openQuestions.filter((question) => question.materiality === 'blocking'),
    activeDecisionCount: readDecisions(deps.workspace, missionId).filter(
      (decision) => decision.status === 'active',
    ).length,
    constitutionVersion: constitution?.version ?? 0,
    activeConstitutionRules:
      constitution?.rules.filter((rule) => rule.status === 'active').length ?? 0,
    contractCount: readContractRegistry(deps.workspace, missionId).length,
    adrCount: mission.counters.adrs,
    openCcrs,
  };
}

export function checkpointMission(deps: MissionDeps, missionId: string, nextAction: string): MissionCheckpoint {
  let mission = requireMissionState(deps.workspace, missionId);
  const coverage = refreshCoverage(deps, mission);
  const openQuestions = readQuestions(deps.workspace, missionId).filter(
    (question) => question.status === 'open',
  );
  const checkpoint = missionCheckpointSchema.parse({
    schemaVersion: MISSION_CHECKPOINT_SCHEMA_VERSION,
    missionId,
    createdAt: now(deps).toISOString(),
    status: mission.status,
    openQuestionIds: openQuestions.map((question) => question.questionId).slice(0, 30),
    blockingQuestionIds: coverage.blockingQuestionIds.slice(0, 30),
    unresolvedRequiredTopics: coverage.unresolvedRequiredTopics,
    counters: mission.counters,
    nextAction: nextAction.slice(0, MISSION_LIMITS.maxTextChars),
  });
  writeMissionCheckpoint(deps.workspace, missionId, checkpoint);
  mission = record(deps, mission, 'checkpoint_created', { status: mission.status });
  persist(deps, mission);
  return checkpoint;
}
