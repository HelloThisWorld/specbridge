import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '@specbridge/core';
import type { DiscoveryTopic, MissionCoverage, MissionState, ProductContract } from '@specbridge/mission';
import {
  answerQuestion,
  beginMission,
  readAdrs,
  readConstitution,
  readContractRegistry,
  readCoverage,
  readDecisions,
  readQuestions as readMissionQuestions,
  recordAssessment,
  refreshCoverage,
  requireMissionState,
} from '@specbridge/mission';
import { IntakeError } from './errors.js';
import type { IntakeDeps } from './deps.js';
import { hostOf, missionDepsOf, newRecordId, nowIso } from './deps.js';
import { parseSpecificationDocument } from './document.js';
import {
  activeConstitutionRules,
  activeProductContracts,
  groundInRepository,
  readGitHead,
} from './grounding.js';
import { analyzeDeltaAuthority, raiseItemForQuestion } from './delta.js';
import { DELTA_AUTHORITY_CLASSES, requiresProductAuthority } from './vocabulary.js';
import type { DiscoveryProposer } from './questions.js';
import type { QuestionCandidate } from './questions.js';
import {
  admitQuestions,
  generateQuestionCandidates,
  generateRequiredTopicCandidates,
} from './questions.js';
import { compileMissionTruth } from './compile.js';
import { assessReadiness, reconcileCoverage } from './convergence.js';
import { buildApprovalSummary, buildIntakeApproval } from './approval.js';
import type { ApprovalSummary } from './approval.js';
import type {
  BuildLifecycle,
  ChunkCoverage,
  DeltaAuthorityAnalysis,
  IntakeApproval,
  IntakeReadiness,
  ProductQuestion,
  QuestionRefusal,
  RepositoryEvidence,
  RepositoryGrounding,
  SourceChunk,
  SpecIntakeState,
  SpecSource,
} from './state.js';
import {
  INTAKE_LIMITS,
  INTAKE_SOURCE_SCHEMA_VERSION,
  INTAKE_STATE_SCHEMA_VERSION,
} from './state.js';
import type { SpecSourceKind } from './vocabulary.js';
import {
  appendIntakeEvent,
  appendQuestion,
  appendRefusal,
  findIntake,
  listIntakes,
  readApproval,
  readDeltaAnalysis,
  readGrounding,
  readLifecycle,
  readProductBaseline,
  readQuestions,
  readRefusals,
  readSpecSource,
  requireIntakeState,
  requireSpecSource,
  storeSourceText,
  writeApproval,
  writeDeltaAnalysis,
  writeGrounding,
  writeIntakeState,
  writeProductBaseline,
  writeSpecSource,
} from './store.js';
import { clip, firstSentence } from './text.js';

/**
 * The spec-intake service: the entry path the product actually exposes.
 *
 * Five operations, and the shape of the list is the product:
 *
 *   startSpecIntake        submit a specification
 *   runIntakeDiscovery     ground it, classify it, ask what must be asked
 *   answerIntakeQuestion   record one human product answer
 *   approveIntake          the ONE human authority action
 *   (then lifecycle.ts)    seal, preflight, launch — unattended from here
 *
 * Everything before the approval may be run any number of times and is
 * idempotent; everything after it happens once and is recorded immutably.
 * That is the whole boundary, and it is deliberately visible in the API
 * rather than hidden inside a state machine: a caller can see that exactly
 * one function carries human authority, and can see that no agent-reachable
 * surface exposes it.
 */

// ---------------------------------------------------------------------------
// Starting an intake
// ---------------------------------------------------------------------------

export interface StartIntakeRequest {
  /** Short name; also the default spec name. */
  name: string;
  /** Where the specification came from. */
  kind: SpecSourceKind;
  /** The specification text, verbatim. */
  content: string;
  /** Original path for a file source. Recorded for audit, never re-read. */
  originPath?: string | undefined;
  /** Explicit goal. Derived from the document when absent. */
  goal?: string | undefined;
  /** Explicit spec name for synthesis. Defaults to the intake name. */
  specName?: string | undefined;
  /** Explicit intake id (deterministic tests). */
  intakeId?: string | undefined;
}

export interface StartIntakeResult {
  intake: SpecIntakeState;
  source: SpecSource;
  mission: MissionState;
}

/**
 * Ingest a submitted specification and open an intake for it.
 *
 * The document is stored VERBATIM and content-addressed before anything is
 * parsed. That ordering is not fussiness: the parse is SpecBridge's reading
 * of the document, and if the two ever disagree the document wins. A
 * pipeline that parsed first and stored a normalized copy would have quietly
 * destroyed the evidence it was supposed to preserve.
 */
export function startSpecIntake(
  deps: IntakeDeps,
  request: StartIntakeRequest,
): StartIntakeResult {
  const name = request.name.trim();
  if (name.length === 0) {
    throw new IntakeError('SBI005', 'A spec intake needs a name.', {
      remediation: ['Pass a short name: `specbridge spec start <name> --file <spec-file>`.'],
    });
  }
  const content = request.content;
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength === 0) {
    throw new IntakeError('SBI007', 'The submitted specification is empty.');
  }
  if (byteLength > INTAKE_LIMITS.maxSourceBytes) {
    throw new IntakeError(
      'SBI006',
      `The submitted specification is ${byteLength} bytes, over the ` +
        `${INTAKE_LIMITS.maxSourceBytes}-byte bound.`,
      { remediation: ['Split the specification, or submit the part this feature covers.'] },
    );
  }

  const intakeId = request.intakeId ?? newRecordId(deps, 'intake');
  const contentHash = sha256Hex(content);
  const storedPath = storeSourceText(deps.workspace, intakeId, contentHash, content);
  const parsed = parseSpecificationDocument(content);
  const at = nowIso(deps);

  const goal = request.goal?.trim() ?? deriveGoal(parsed.chunks, name);
  const mission = beginMission(missionDepsOf(deps), { name, goal });

  const source: SpecSource = writeSpecSource(deps.workspace, {
    schemaVersion: INTAKE_SOURCE_SCHEMA_VERSION,
    intakeId,
    kind: request.kind,
    ...(request.originPath !== undefined ? { originPath: clip(request.originPath, 500) } : {}),
    receivedAt: at,
    receivedVia: hostOf(deps),
    byteLength,
    contentHash,
    storedAt: path.posix.join(
      '.specbridge',
      'intake',
      intakeId,
      'source',
      `${contentHash}.md`,
    ),
    outline: parsed.outline,
    chunks: parsed.chunks,
  });
  void storedPath;

  const intake = writeIntakeState(deps.workspace, {
    schemaVersion: INTAKE_STATE_SCHEMA_VERSION,
    intakeId,
    name,
    status: 'INGESTED',
    missionId: mission.missionId,
    createdAt: at,
    updatedAt: at,
    host: hostOf(deps),
    sourceContentHash: contentHash,
    baselineCommit: readGitHead(deps.workspace.rootDir),
    counters: {
      sourceChunks: parsed.chunks.length,
      normativeChunks: parsed.normativeCount,
      evidence: 0,
      deltaItems: 0,
      questionsAsked: 0,
      questionsAnswered: 0,
      questionsRefused: 0,
      discoveryHumanTurns: 0,
      authorityApprovalCount: 0,
      groundingPasses: 0,
      events: 0,
    },
    sequences: { question: 0, refusal: 0, deltaItem: 0, evidence: 0 },
    ...(request.specName !== undefined ? { specName: request.specName } : {}),
  });

  appendIntakeEvent(deps.workspace, intakeId, {
    at,
    type: 'intake_created',
    name,
    missionId: mission.missionId,
  });
  appendIntakeEvent(deps.workspace, intakeId, {
    at,
    type: 'source_ingested',
    kind: request.kind,
    bytes: byteLength,
    chunks: parsed.chunks.length,
    normative: parsed.normativeCount,
    contentHash,
  });

  return { intake, source, mission };
}

/**
 * Read a specification from a file and start an intake for it.
 *
 * Kept here rather than in the CLI so the MCP surface, the plugin, and the
 * CLI all read a file the same way — including the size refusal, which is a
 * product bound rather than a CLI convenience.
 */
export function startSpecIntakeFromFile(
  deps: IntakeDeps,
  request: Omit<StartIntakeRequest, 'content' | 'kind' | 'originPath'> & { file: string },
): StartIntakeResult {
  const resolved = path.resolve(request.file);
  if (!existsSync(resolved)) {
    throw new IntakeError('SBI007', `No specification file at ${request.file}.`, {
      remediation: ['Check the path, or pass the specification text with --text.'],
    });
  }
  const size = statSync(resolved).size;
  if (size > INTAKE_LIMITS.maxSourceBytes) {
    throw new IntakeError(
      'SBI006',
      `${request.file} is ${size} bytes, over the ${INTAKE_LIMITS.maxSourceBytes}-byte bound.`,
    );
  }
  const content = readFileSync(resolved, 'utf8');
  return startSpecIntake(deps, {
    ...request,
    kind: 'file',
    content,
    originPath: resolved,
  });
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface DiscoveryOptions {
  /** Optional agent seam for extra question candidates. Governed, not trusted. */
  proposer?: DiscoveryProposer | undefined;
}

export interface DiscoveryResult {
  intake: SpecIntakeState;
  grounding: RepositoryGrounding;
  analysis: DeltaAuthorityAnalysis;
  /** Every product question, open and answered. */
  questions: ProductQuestion[];
  /** Questions opened by THIS pass. */
  newQuestions: ProductQuestion[];
  refusals: QuestionRefusal[];
  coverage: ChunkCoverage[];
  readiness: IntakeReadiness;
  missionCoverage: MissionCoverage | undefined;
}

/**
 * One repository-grounded discovery pass.
 *
 * Runs at intake, after every answer, and before approval. Every stage is
 * recomputed from durable state rather than accumulated, so a pass is a pure
 * function of the workspace plus the answers so far — which is what makes
 * "run it again and see if anything changed" a meaningful operation instead
 * of a gamble.
 *
 * The order is the argument:
 *
 *   read the repository  ->  classify against what it already promises  ->
 *   ask only what neither settled  ->  record what IS settled  ->  converge
 *
 * Questions are generated BEFORE compilation on purpose. An item waiting on
 * a human answer must not be written into the mission as a decision, because
 * a decision is a commitment and nobody has committed to it yet.
 */
export function runIntakeDiscovery(
  deps: IntakeDeps,
  intakeId: string,
  options: DiscoveryOptions = {},
): DiscoveryResult {
  let intake = requireIntakeState(deps.workspace, intakeId);
  if (intake.status === 'ABANDONED') {
    throw new IntakeError('SBI004', `Spec intake ${intakeId} is ABANDONED and read-only.`);
  }
  const source = requireSpecSource(deps.workspace, intakeId);
  const at = nowIso(deps);

  // --- 1. Ground -----------------------------------------------------------
  const grounding = writeGrounding(
    deps.workspace,
    groundInRepository(deps, {
      intakeId,
      excludeMissionIds: [intake.missionId],
    }),
  );
  appendIntakeEvent(deps.workspace, intakeId, {
    at,
    type: 'grounding_completed',
    evidence: grounding.evidence.length,
    priorMissions: grounding.priorMissionIds.length,
    existingProduct: grounding.existingProduct,
  });

  // --- 2. Classify ---------------------------------------------------------
  const existingContracts = activeProductContracts(deps.workspace, {
    excludeMissionIds: [intake.missionId],
  });
  const constitutionRules = activeConstitutionRules(deps.workspace, {
    excludeMissionIds: [intake.missionId],
  });
  let analysis = analyzeDeltaAuthority({
    intakeId,
    analyzedAt: at,
    chunks: source.chunks,
    grounding,
    existingContracts,
    constitutionRules,
  });

  // --- 3. Ask --------------------------------------------------------------
  const candidates = generateQuestionCandidates({
    chunks: source.chunks,
    evidence: grounding.evidence,
    deltaItems: analysis.items,
    ...(options.proposer !== undefined ? { proposer: options.proposer } : {}),
  });
  let questionSequence = intake.sequences.question;
  let refusalSequence = intake.sequences.refusal;
  const newQuestions: ProductQuestion[] = [];
  const admitted = admitAndRecord(deps, {
    intakeId,
    missionId: intake.missionId,
    candidates,
    chunks: source.chunks,
    evidence: grounding.evidence,
    at,
    questionSequence,
    refusalSequence,
  });
  questionSequence = admitted.nextQuestionSequence;
  refusalSequence = admitted.nextRefusalSequence;
  newQuestions.push(...admitted.opened);

  let questions = readQuestions(deps.workspace, intakeId);

  // --- 4. Raise blocked items ---------------------------------------------
  const openByItem = new Map<string, string>();
  for (const question of questions) {
    if (question.status !== 'open') continue;
    if (question.deltaItemId !== undefined) openByItem.set(question.deltaItemId, question.questionId);
  }
  // A question that names no specific item still blocks the items that share
  // its source chunks: an unresolved compatibility promise makes every
  // statement it governs unresolved too.
  const openChunkQuestions = new Map<string, string>();
  for (const question of questions) {
    if (question.status !== 'open') continue;
    for (const chunkId of question.sourceChunkIds) openChunkQuestions.set(chunkId, question.questionId);
  }
  const raisedItems = analysis.items.map((item) => {
    const direct = openByItem.get(item.itemId);
    if (direct !== undefined) {
      return raiseItemForQuestion(item, direct, 'a product question about it is open');
    }
    const viaChunk = item.sourceChunkIds
      .map((chunkId) => openChunkQuestions.get(chunkId))
      .find((questionId): questionId is string => questionId !== undefined);
    if (viaChunk !== undefined) {
      return raiseItemForQuestion(
        item,
        viaChunk,
        'an open product question governs the statement it was extracted from',
      );
    }
    return item;
  });
  // The SAME definition of "complete" the pure analyzer uses: classified,
  // and nothing left that needs product authority nobody has given.
  const authoritySensitive = raisedItems.filter((item) =>
    requiresProductAuthority(item.classification),
  );
  analysis = writeDeltaAnalysis(deps.workspace, {
    ...analysis,
    items: raisedItems,
    counts: countsOf(raisedItems),
    complete: raisedItems.length > 0 && authoritySensitive.length === 0,
    reasons:
      authoritySensitive.length > 0
        ? [
            `${authoritySensitive.length} statement(s) need a product decision before this ` +
              'specification can be approved.',
          ]
        : raisedItems.length === 0
          ? [
              'The submitted specification contains no statements the classifier recognised ' +
                'as material.',
            ]
          : [],
  });
  appendIntakeEvent(deps.workspace, intakeId, {
    at,
    type: 'delta_analysis_completed',
    items: analysis.items.length,
    complete: analysis.complete,
    modified: analysis.modifiedContractIds.length,
    extended: analysis.extendedContractIds.length,
  });

  // --- 5. Compile what IS settled -----------------------------------------
  const blockedItemIds = analysis.items
    .filter(
      (item) =>
        item.classification === 'UNKNOWN_PRODUCT_AUTHORITY' ||
        item.classification === 'CONTRADICTION' ||
        item.classification === 'EXISTING_SEALED_CONTRACT_CHANGE',
    )
    .map((item) => item.itemId);
  const compiled = compileMissionTruth(missionDepsOf(deps), deps, {
    intakeId,
    missionId: intake.missionId,
    source,
    grounding,
    analysis,
    blockedItemIds,
    openQuestionCount: questions.filter((question) => question.status === 'open').length,
    answeredQuestions: questions
      .filter((question) => question.status === 'answered' && question.answer !== undefined)
      .map((question) => ({
        questionId: question.questionId,
        answer: question.answer ?? '',
        sourceChunkIds: [...question.sourceChunkIds],
        ...(question.deltaItemId !== undefined ? { deltaItemId: question.deltaItemId } : {}),
      })),
  });

  // --- 6. Ask about required topics NOTHING addressed ----------------------
  // Deliberately after compilation. A topic the specification answers is
  // resolved by the step above, and asking about it beforehand would produce
  // a question the document already contains the answer to — the exact
  // failure the evidence screen exists to prevent, arriving through the back
  // door of the topic floor.
  let mission = requireMissionState(deps.workspace, intake.missionId);
  let missionCoverage = refreshCoverage(missionDepsOf(deps), mission);
  const unknownRequired = missionCoverage.topics
    .filter((topic) => topic.required && topic.status === 'unknown')
    .map((topic) => topic.topicId as DiscoveryTopic);
  if (unknownRequired.length > 0) {
    const topicAdmission = admitAndRecord(deps, {
      intakeId,
      missionId: intake.missionId,
      candidates: generateRequiredTopicCandidates(unknownRequired),
      chunks: source.chunks,
      evidence: grounding.evidence,
      at,
      questionSequence,
      refusalSequence,
    });
    questionSequence = topicAdmission.nextQuestionSequence;
    refusalSequence = topicAdmission.nextRefusalSequence;
    newQuestions.push(...topicAdmission.opened);
    questions = readQuestions(deps.workspace, intakeId);
    mission = requireMissionState(deps.workspace, intake.missionId);
    missionCoverage = refreshCoverage(missionDepsOf(deps), mission);
  }

  // --- 7. Converge ---------------------------------------------------------
  const coverage = reconcileCoverage({
    chunks: source.chunks,
    analysis,
    questions,
    evidence: grounding.evidence,
    overflowItemIds: compiled.overflowItemIds,
  });
  appendIntakeEvent(deps.workspace, intakeId, {
    at,
    type: 'coverage_reconciled',
    unaccounted: coverage.filter((entry) => entry.state === 'UNACCOUNTED').length,
    total: coverage.length,
  });
  const readiness = assessReadiness({
    coverage,
    analysis,
    questions,
    missionCoverage,
    overflowed: compiled.overflowItemIds.length > 0,
    productContractCount: readContractRegistry(deps.workspace, intake.missionId).filter(
      (contract) => contract.status !== 'superseded',
    ).length,
  });

  // --- 8. Fold into the intake status --------------------------------------
  const openCount = questions.filter((question) => question.status === 'open').length;
  const status = readiness.ready
    ? 'READY_FOR_APPROVAL'
    : openCount > 0
      ? 'AWAITING_PRODUCT_ANSWERS'
      : 'DISCOVERING';
  if (status !== intake.status && intake.status !== 'APPROVED' && intake.status !== 'BUILDING') {
    appendIntakeEvent(deps.workspace, intakeId, {
      at,
      type: 'status_changed',
      from: intake.status,
      to: status,
    });
    if (status === 'READY_FOR_APPROVAL') {
      appendIntakeEvent(deps.workspace, intakeId, {
        at,
        type: 'ready_for_approval',
        contracts: readContractRegistry(deps.workspace, intake.missionId).length,
        criteria: mission.successCriteria.length,
      });
    }
  }
  intake = writeIntakeState(deps.workspace, {
    ...intake,
    status:
      intake.status === 'APPROVED' || intake.status === 'BUILDING' || intake.status === 'BUILT'
        ? intake.status
        : status,
    counters: {
      ...intake.counters,
      evidence: grounding.evidence.length,
      deltaItems: analysis.items.length,
      questionsAsked: questions.length,
      questionsAnswered: questions.filter((question) => question.status === 'answered').length,
      questionsRefused: readRefusals(deps.workspace, intakeId).length,
      groundingPasses: intake.counters.groundingPasses + 1,
    },
    sequences: {
      ...intake.sequences,
      question: questionSequence,
      refusal: refusalSequence,
      deltaItem: analysis.items.length,
      evidence: grounding.evidence.length,
    },
  });

  return {
    intake,
    grounding,
    analysis,
    questions,
    newQuestions,
    refusals: readRefusals(deps.workspace, intakeId),
    coverage,
    readiness,
    missionCoverage,
  };
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

export interface AnswerResult {
  question: ProductQuestion;
  intake: SpecIntakeState;
  discovery: DiscoveryResult;
}

/**
 * Record one human product answer.
 *
 * Delegates to the mission's `answerQuestion`, which records an answering
 * USER turn and a `known-from-user` decision bound to it. Recording the
 * decision here instead would create a commitment with no visible turn
 * behind it — exactly the provenance the mission service refuses, and
 * rightly.
 *
 * Re-runs discovery afterwards, because an answer usually settles more than
 * the one item it was asked about.
 */
export function answerIntakeQuestion(
  deps: IntakeDeps,
  intakeId: string,
  request: { questionId: string; answer: string },
  options: DiscoveryOptions = {},
): AnswerResult {
  const intake = requireIntakeState(deps.workspace, intakeId);
  if (intake.status === 'APPROVED' || intake.status === 'BUILDING' || intake.status === 'BUILT') {
    throw new IntakeError(
      'SBI003',
      `Spec intake ${intakeId} is ${intake.status}; discovery answers are recorded before ` +
        'approval, not after it.',
      {
        remediation: [
          'Reopen discovery for a material change, which starts a new approval lifecycle.',
        ],
      },
    );
  }
  const questions = readQuestions(deps.workspace, intakeId);
  const question = questions.find((candidate) => candidate.questionId === request.questionId);
  if (question === undefined) {
    throw new IntakeError('SBI005', `No product question "${request.questionId}" on this intake.`, {
      remediation: [`List them with \`specbridge spec discover ${intake.name}\`.`],
    });
  }
  if (question.status !== 'open') {
    throw new IntakeError('SBI005', `Question ${request.questionId} is already answered.`);
  }
  const answer = request.answer.trim();
  if (answer.length === 0) {
    throw new IntakeError('SBI005', 'An answer needs text.');
  }
  if (question.missionQuestionId === undefined) {
    throw new IntakeError(
      'SBI002',
      `Question ${request.questionId} was never mirrored into the mission and cannot record ` +
        'a governed answer.',
    );
  }

  const at = nowIso(deps);
  const result = answerQuestion(missionDepsOf(deps), intake.missionId, {
    questionId: question.missionQuestionId,
    answer,
  });
  const answered: ProductQuestion = {
    ...question,
    status: 'answered',
    answer: clip(answer, INTAKE_LIMITS.maxTextChars),
    answeredAt: at,
    decisionId: result.decision.decisionId,
  };
  appendQuestion(deps.workspace, intakeId, answered);
  appendIntakeEvent(deps.workspace, intakeId, {
    at,
    type: 'question_answered',
    questionId: answered.questionId,
    decisionId: result.decision.decisionId,
  });
  writeIntakeState(deps.workspace, {
    ...intake,
    counters: {
      ...intake.counters,
      discoveryHumanTurns: intake.counters.discoveryHumanTurns + 1,
      questionsAnswered: intake.counters.questionsAnswered + 1,
    },
  });

  const discovery = runIntakeDiscovery(deps, intakeId, options);
  return { question: answered, intake: discovery.intake, discovery };
}

// ---------------------------------------------------------------------------
// The single approval
// ---------------------------------------------------------------------------

export interface ApproveIntakeRequest {
  intakeId: string;
  /** The channel the human authorization arrived through. Audit only. */
  via?: string | undefined;
  maxApiSpendUsd?: number | null | undefined;
  allowedLanes?: readonly ('LOCAL' | 'SUBSCRIPTION' | 'API')[] | undefined;
  /** Explicit approval id (deterministic tests). */
  approvalId?: string | undefined;
}

export interface ApproveIntakeResult {
  approval: IntakeApproval;
  intake: SpecIntakeState;
  /**
   * What the human authorized, in product language.
   *
   * `undefined` only when the durable delta analysis is missing, which
   * cannot happen on a fresh approval and can on a re-read of an old record
   * whose analysis file was removed. Reporting the absence beats
   * reconstructing a summary of an approval from nothing.
   */
  summary: ApprovalSummary | undefined;
}

/**
 * "I approve this discovered specification and authorize SpecBridge to build
 * it."
 *
 * The one human authority operation of this package. It refuses an intake
 * that is not READY_FOR_APPROVAL — a convergence gate that could be
 * overridden would not be a gate — and it writes an immutable record that
 * everything downstream cites.
 *
 * There is no MCP tool for this and there will not be one, for the same
 * reason no MCP tool approves a spec stage or authorizes a seal: an agent
 * that could authorize its own work has not been delegated authority, it has
 * taken it.
 */
export function approveIntake(
  deps: IntakeDeps,
  request: ApproveIntakeRequest,
): ApproveIntakeResult {
  const intake = requireIntakeState(deps.workspace, request.intakeId);
  if (intake.status === 'ABANDONED') {
    throw new IntakeError('SBI004', `Spec intake ${request.intakeId} is ABANDONED.`);
  }
  const existing = readApproval(deps.workspace, request.intakeId);
  if (existing !== undefined) {
    return {
      approval: existing,
      intake,
      summary: summaryOf(deps, intake),
    };
  }

  const discovery = runIntakeDiscovery(deps, request.intakeId);
  if (!discovery.readiness.ready) {
    throw new IntakeError(
      'SBI010',
      `Spec intake ${request.intakeId} is not ready for approval: ` +
        discovery.readiness.reasons.join(' '),
      {
        remediation: [
          ...discovery.readiness.openQuestionIds.map(
            (questionId) =>
              `Answer ${questionId}: \`specbridge spec answer ${intake.name} ${questionId} "…"\``,
          ),
          ...(discovery.readiness.unaccountedChunkIds.length > 0
            ? [
                'Some statements from the submitted specification are not accounted for; run ' +
                  `\`specbridge spec discover ${intake.name}\` to see them.`,
              ]
            : []),
        ],
        details: {
          openQuestionIds: discovery.readiness.openQuestionIds,
          unaccountedChunkIds: discovery.readiness.unaccountedChunkIds,
        },
      },
    );
  }

  const mission = requireMissionState(deps.workspace, intake.missionId);
  const contracts = readContractRegistry(deps.workspace, intake.missionId);
  const constitution = readConstitution(deps.workspace, intake.missionId);
  const adrs = readAdrs(deps.workspace, intake.missionId);
  const decisions = readDecisions(deps.workspace, intake.missionId).filter(
    (decision) => decision.status === 'active',
  );
  const source = requireSpecSource(deps.workspace, request.intakeId);
  const at = nowIso(deps);

  const approval = writeApproval(
    deps.workspace,
    buildIntakeApproval({
      approvalId: request.approvalId ?? newRecordId(deps, 'approval'),
      intakeId: request.intakeId,
      missionId: intake.missionId,
      approvedAt: at,
      approvedVia: request.via ?? hostOf(deps),
      source,
      mission,
      contracts,
      analysis: discovery.analysis,
      questions: discovery.questions,
      decisionIds: decisions.map((decision) => decision.decisionId),
      constitutionRuleIds: (constitution?.rules ?? [])
        .filter((rule) => rule.status === 'active')
        .map((rule) => rule.ruleId),
      adrIds: adrs.map((adr) => adr.adrId),
      maxApiSpendUsd: request.maxApiSpendUsd ?? null,
      allowedLanes: request.allowedLanes ?? ['LOCAL', 'SUBSCRIPTION'],
    }),
  );

  appendIntakeEvent(deps.workspace, request.intakeId, {
    at,
    type: 'intake_approved',
    approvalId: approval.approvalId,
    authorityDigest: approval.authorityDigest,
    via: approval.approvedVia,
    contracts: approval.newContractIds.length,
    criteria: approval.acceptanceCriteria.length,
    answeredQuestions: approval.resolvedQuestions.length,
  });
  appendIntakeEvent(deps.workspace, request.intakeId, {
    at,
    type: 'status_changed',
    from: intake.status,
    to: 'APPROVED',
  });

  const approved = writeIntakeState(deps.workspace, {
    ...intake,
    status: 'APPROVED',
    approvalId: approval.approvalId,
    approvedAt: at,
    counters: {
      ...intake.counters,
      authorityApprovalCount: intake.counters.authorityApprovalCount + 1,
    },
  });

  recordBaselineEntry(deps, approved, approval, discovery.analysis);

  return {
    approval,
    intake: approved,
    summary: buildApprovalSummary({
      mission,
      contracts,
      analysis: discovery.analysis,
      questions: discovery.questions,
    }),
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface IntakeOverview {
  intake: SpecIntakeState;
  source: SpecSource | undefined;
  grounding: RepositoryGrounding | undefined;
  analysis: DeltaAuthorityAnalysis | undefined;
  questions: ProductQuestion[];
  refusals: QuestionRefusal[];
  approval: IntakeApproval | undefined;
  lifecycle: BuildLifecycle | undefined;
  summary: ApprovalSummary | undefined;
  missionCoverage: MissionCoverage | undefined;
  contracts: ProductContract[];
}

/** Everything durable about one intake, without changing anything. */
export function describeIntake(deps: IntakeDeps, intakeId: string): IntakeOverview {
  const intake = requireIntakeState(deps.workspace, intakeId);
  const contracts = readContractRegistry(deps.workspace, intake.missionId);
  return {
    intake,
    source: readSpecSource(deps.workspace, intakeId),
    grounding: readGrounding(deps.workspace, intakeId),
    analysis: readDeltaAnalysis(deps.workspace, intakeId),
    questions: readQuestions(deps.workspace, intakeId),
    refusals: readRefusals(deps.workspace, intakeId),
    approval: readApproval(deps.workspace, intakeId),
    lifecycle: readLifecycle(deps.workspace, intakeId),
    summary: summaryOf(deps, intake),
    missionCoverage: readCoverage(deps.workspace, intake.missionId),
    contracts,
  };
}

/** Resolve a subject to one intake, or explain that nothing matches. */
export function requireIntakeFor(deps: IntakeDeps, subject: string): SpecIntakeState {
  const found = findIntake(deps.workspace, subject);
  if (found === undefined) {
    throw new IntakeError('SBI001', `No spec intake matches "${subject}".`, {
      remediation: [
        'List intakes with `specbridge spec intake`,',
        'or start one with `specbridge spec start <name> --file <spec-file>`.',
      ],
    });
  }
  return found;
}

export function abandonIntake(
  deps: IntakeDeps,
  intakeId: string,
  reason: string,
): SpecIntakeState {
  const intake = requireIntakeState(deps.workspace, intakeId);
  if (intake.status === 'ABANDONED') return intake;
  const at = nowIso(deps);
  appendIntakeEvent(deps.workspace, intakeId, {
    at,
    type: 'intake_abandoned',
    reason: clip(reason, 500),
  });
  return writeIntakeState(deps.workspace, {
    ...intake,
    status: 'ABANDONED',
    abandonedAt: at,
    abandonReason: clip(reason, INTAKE_LIMITS.maxTextChars),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summaryOf(deps: IntakeDeps, intake: SpecIntakeState): ApprovalSummary | undefined {
  const analysis = readDeltaAnalysis(deps.workspace, intake.intakeId);
  if (analysis === undefined) return undefined;
  return buildApprovalSummary({
    mission: requireMissionState(deps.workspace, intake.missionId),
    contracts: readContractRegistry(deps.workspace, intake.missionId),
    analysis,
    questions: readQuestions(deps.workspace, intake.intakeId),
  });
}

interface AdmitAndRecordInput {
  intakeId: string;
  missionId: string;
  candidates: readonly QuestionCandidate[];
  chunks: readonly SourceChunk[];
  evidence: readonly RepositoryEvidence[];
  at: string;
  questionSequence: number;
  refusalSequence: number;
}

interface AdmitAndRecordResult {
  opened: ProductQuestion[];
  nextQuestionSequence: number;
  nextRefusalSequence: number;
}

/**
 * Screen candidates, mint the survivors, and record both sides.
 *
 * Every admitted question is MIRRORED INTO THE MISSION. That is what makes
 * the intake's convergence gate and the mission's own coverage gate agree:
 * the mission's deterministic materiality screen sees the affected surface
 * and classifies the question blocking, and the intake does not get a vote.
 * A question that lived only in the intake would let a mission reach
 * CONTRACT_READY with a product decision still open.
 *
 * Refusals are recorded with equal weight, because they are the evidence
 * behind the claim that discovery asks product questions only.
 */
function admitAndRecord(deps: IntakeDeps, input: AdmitAndRecordInput): AdmitAndRecordResult {
  const admission = admitQuestions({
    candidates: input.candidates,
    context: {
      chunks: input.chunks,
      evidence: input.evidence,
      existing: readQuestions(deps.workspace, input.intakeId),
    },
    at: input.at,
    questionSequence: input.questionSequence,
    refusalSequence: input.refusalSequence,
  });

  const opened: ProductQuestion[] = [];
  if (admission.questions.length > 0) {
    const assessment = recordAssessment(missionDepsOf(deps), input.missionId, {
      questions: admission.questions.map((question) => ({
        question: question.question,
        whyItMatters: question.whyItMatters,
        topics: question.topics as DiscoveryTopic[],
        affectedSurfaces: [question.productSurface],
        materiality: 'blocking' as const,
        options: question.options,
      })),
    });
    admission.questions.forEach((question, index) => {
      const missionQuestionId = assessment.questionIds[index];
      const stored: ProductQuestion = {
        ...question,
        ...(missionQuestionId !== undefined ? { missionQuestionId } : {}),
      };
      appendQuestion(deps.workspace, input.intakeId, stored);
      opened.push(stored);
      appendIntakeEvent(deps.workspace, input.intakeId, {
        at: input.at,
        type: 'question_opened',
        questionId: stored.questionId,
        kind: stored.kind,
        productSurface: stored.productSurface,
        ...(missionQuestionId !== undefined ? { missionQuestionId } : {}),
      });
    });
  }

  for (const refusal of admission.refusals) {
    appendRefusal(deps.workspace, input.intakeId, refusal);
    appendIntakeEvent(deps.workspace, input.intakeId, {
      at: input.at,
      type: 'question_refused',
      refusalId: refusal.refusalId,
      reason: refusal.reason,
      ...(refusal.engineeringSurface !== undefined
        ? { engineeringSurface: refusal.engineeringSurface }
        : {}),
    });
  }

  return {
    opened,
    nextQuestionSequence: admission.nextQuestionSequence,
    nextRefusalSequence: admission.nextRefusalSequence,
  };
}

/**
 * Counts per delta class, ZERO-FILLED across the whole enum.
 *
 * Matching `analyzeDeltaAuthority`, which zero-fills too. A reader must be
 * able to tell "no contradictions" from "this key does not exist", and a
 * consumer reading `counts['CONTRADICTION']` should not get `0` from the
 * pure analyzer and `undefined` from the service that rewrote it.
 */
function countsOf(items: readonly { classification: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const cls of DELTA_AUTHORITY_CLASSES) counts[cls] = 0;
  for (const item of items) counts[item.classification] = (counts[item.classification] ?? 0) + 1;
  return counts;
}

/**
 * The goal, derived from the document when the caller did not state one.
 *
 * The first normative sentence is the honest choice: a specification opens
 * by saying what it wants, and a heading is a label rather than a goal. The
 * caller can always override, and the whole document remains the record.
 */
function deriveGoal(chunks: readonly { kind: string; text: string }[], name: string): string {
  const opening = chunks.find(
    (chunk) => chunk.kind === 'normative' || chunk.kind === 'narrative',
  );
  const derived = opening !== undefined ? firstSentence(opening.text, 600) : '';
  return derived.length >= 12 ? derived : `Deliver the ${name} feature as specified.`;
}

/**
 * Record this feature's place in the product's history.
 *
 * Written at APPROVAL rather than at completion, so a run that is
 * interrupted still leaves a lineage entry naming the baseline it started
 * from and the seals that were already in force. A history written only on
 * success would be missing exactly the entries somebody debugging needs.
 */
function recordBaselineEntry(
  deps: IntakeDeps,
  intake: SpecIntakeState,
  approval: IntakeApproval,
  analysis: DeltaAuthorityAnalysis,
): void {
  const baseline = readProductBaseline(deps.workspace);
  const predecessorSealIds = baseline.features
    .filter((feature) => feature.sealId !== undefined && feature.intakeId !== intake.intakeId)
    .map((feature) => feature.sealId as string);
  const entry = {
    intakeId: intake.intakeId,
    missionId: intake.missionId,
    name: intake.name,
    recordedAt: approval.approvedAt,
    baselineCommit: intake.baselineCommit,
    predecessorSealIds,
    newContractIds: [...approval.newContractIds],
    extendedContractIds: [...analysis.extendedContractIds],
    changedContractIds: [...analysis.modifiedContractIds],
    implementationCommits: [],
  };
  const features = baseline.features.filter((feature) => feature.intakeId !== intake.intakeId);
  writeProductBaseline(deps.workspace, {
    ...baseline,
    updatedAt: approval.approvedAt,
    features: [...features, entry].slice(-INTAKE_LIMITS.maxItems),
  });
  appendIntakeEvent(deps.workspace, intake.intakeId, {
    at: approval.approvedAt,
    type: 'baseline_recorded',
    predecessors: predecessorSealIds.length,
  });
}

/**
 * Update this feature's lineage entry once the build reached a terminal
 * state.
 *
 * Called by the CLI after a run, so future discovery can see not only what a
 * feature promised but whether it landed. A lineage that recorded only
 * intentions would let the next specification build on a promise nothing
 * kept.
 */
export function recordFeatureOutcome(
  deps: IntakeDeps,
  intakeId: string,
  outcome: {
    sealId?: string | undefined;
    specName?: string | undefined;
    jobId?: string | undefined;
    implementationCommits?: readonly string[] | undefined;
    closureEvidenceRef?: string | undefined;
    outcome?: BuildLifecycle['outcome'] | undefined;
  },
): void {
  const baseline = readProductBaseline(deps.workspace);
  const index = baseline.features.findIndex((feature) => feature.intakeId === intakeId);
  if (index < 0) return;
  const existing = baseline.features[index];
  if (existing === undefined) return;
  const updated = {
    ...existing,
    ...(outcome.sealId !== undefined ? { sealId: outcome.sealId } : {}),
    ...(outcome.specName !== undefined ? { specName: outcome.specName } : {}),
    ...(outcome.jobId !== undefined ? { jobId: outcome.jobId } : {}),
    ...(outcome.implementationCommits !== undefined
      ? { implementationCommits: [...outcome.implementationCommits].slice(0, 100) }
      : {}),
    ...(outcome.closureEvidenceRef !== undefined
      ? { closureEvidenceRef: outcome.closureEvidenceRef }
      : {}),
    ...(outcome.outcome !== undefined ? { outcome: outcome.outcome } : {}),
  };
  const features = [...baseline.features];
  features[index] = updated;
  writeProductBaseline(deps.workspace, {
    ...baseline,
    updatedAt: nowIso(deps),
    features,
  });
}

/** Every intake in the workspace, oldest first. */
export function listSpecIntakes(deps: IntakeDeps): ReturnType<typeof listIntakes> {
  return listIntakes(deps.workspace);
}

/** The mission questions mirrored from this intake, for cross-checking. */
export function missionQuestionsFor(deps: IntakeDeps, intakeId: string): string[] {
  const intake = requireIntakeState(deps.workspace, intakeId);
  return readMissionQuestions(deps.workspace, intake.missionId)
    .filter((question) => question.status === 'open')
    .map((question) => question.questionId);
}
