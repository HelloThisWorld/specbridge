import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkspaceInfo } from '@specbridge/core';
import { assertInsideWorkspace, writeFileAtomic } from '@specbridge/core';
import type {
  ContractInput,
  DecisionInput,
  DiscoveryTopic,
  FactInput,
  IrreversibleSurface,
  MissionAssessmentInput,
  MissionDeps,
  MissionState,
} from '@specbridge/mission';
import {
  MISSION_LIMITS,
  REQUIRED_TOPICS,
  recordAssessment,
  recordTurn,
  requireMissionState,
} from '@specbridge/mission';
import type {
  DeltaAuthorityAnalysis,
  DeltaItem,
  RepositoryEvidence,
  RepositoryGrounding,
  SourceChunk,
  SpecSource,
} from './state.js';
import { INTAKE_LIMITS } from './state.js';
import { clip, surfacesOf, topicsOf } from './text.js';

/**
 * Compiling the submitted specification into durable mission truth.
 *
 * This is the step that makes the intake path REAL rather than a nicer front
 * end. Everything downstream — the coverage gate, the seal, the closure
 * ledger, the objective graph — reads mission records, and none of it knows
 * or cares that a Markdown document was involved. So the intake's job here
 * is to turn one document into exactly the records a human would have
 * produced through `mission begin` / `mission assess`, with the same
 * provenance discipline and no shortcuts around it.
 *
 * Three properties this file has to preserve.
 *
 * PROVENANCE IS REAL. The submitted specification is a USER STATEMENT, so it
 * is recorded as a user turn and every decision derived from it cites that
 * turn. A decision the specification does NOT support is recorded with
 * `known-from-repository-evidence` instead, which is a different and equally
 * honest claim. Nothing is ever recorded as `inferred` and then treated as a
 * commitment — the mission service refuses that, and rightly.
 *
 * IDEMPOTENCE IS DURABLE, NOT CLEVER. Discovery runs many times: once at
 * intake, once after each answer, once before approval. Mission records are
 * append-only, so re-running must not append the same contract three times.
 * The mapping from delta item to the mission record it produced is written
 * to disk (`mission-map.json`) and consulted on every pass. Deriving it by
 * comparing text would be fragile in exactly the case that matters — after a
 * human answer changed the text slightly.
 *
 * CONTRACTS ARE GROUPED BY SURFACE, NOT BY SENTENCE. A substantial
 * specification contains dozens of material statements. One contract per
 * statement would produce a registry nobody can read and a closure ledger
 * with a hundred entries. Grouping by durable product surface produces the
 * contracts a person would have written: one for the public surface, one for
 * the configuration format, one for failure semantics, and so on.
 */

// ---------------------------------------------------------------------------
// The durable projection map
// ---------------------------------------------------------------------------

/**
 * What each delta item produced in the mission, and what each required topic
 * was resolved by.
 *
 * Durable because idempotence has to survive a process restart: an intake
 * that re-derived this by matching text would re-create a contract the
 * moment a human answer rephrased a requirement.
 */
export interface MissionProjectionMap {
  /** Delta item id → the contract id its requirement landed in. */
  itemContracts: Record<string, string>;
  /** Delta item id → the decision id recording it. */
  itemDecisions: Record<string, string>;
  /** Surface → contract id, so a second pass extends rather than duplicates. */
  surfaceContracts: Record<string, string>;
  /** Required topic → the decision id that resolved it. */
  topicDecisions: Record<string, string>;
  /** The user turn recording the submitted specification. */
  sourceTurnId?: string;
  /** True once mission-level fields (non-goals, criteria) were written. */
  fieldsWritten?: boolean;
}

/**
 * A FRESH empty map, built per call.
 *
 * Deliberately a function rather than a shared constant. A module-level
 * literal spread with `{...EMPTY_MAP}` is a SHALLOW copy: every caller would
 * share the same `itemDecisions` object, and writing an entry into one
 * intake's map would silently appear in the next one's — which is exactly
 * what happened, and it produced a contract citing a decision id belonging to
 * a different mission.
 */
function emptyProjectionMap(): MissionProjectionMap {
  return {
    itemContracts: {},
    itemDecisions: {},
    surfaceContracts: {},
    topicDecisions: {},
  };
}

function mapFile(workspace: WorkspaceInfo, intakeId: string): string {
  return assertInsideWorkspace(
    workspace.rootDir,
    path.join(workspace.rootDir, '.specbridge', 'intake', intakeId, 'mission-map.json'),
  );
}

export function readProjectionMap(
  workspace: WorkspaceInfo,
  intakeId: string,
): MissionProjectionMap {
  const file = mapFile(workspace, intakeId);
  if (!existsSync(file)) return emptyProjectionMap();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<MissionProjectionMap>;
    return {
      itemContracts: raw.itemContracts ?? {},
      itemDecisions: raw.itemDecisions ?? {},
      surfaceContracts: raw.surfaceContracts ?? {},
      topicDecisions: raw.topicDecisions ?? {},
      ...(raw.sourceTurnId !== undefined ? { sourceTurnId: raw.sourceTurnId } : {}),
      ...(raw.fieldsWritten !== undefined ? { fieldsWritten: raw.fieldsWritten } : {}),
    };
  } catch {
    // A corrupt map means the intake would duplicate records. Refusing to
    // read it is worse: an empty map at least produces a visible duplicate
    // rather than a silent divergence, and the mission's own bounds cap it.
    return emptyProjectionMap();
  }
}

export function writeProjectionMap(
  workspace: WorkspaceInfo,
  intakeId: string,
  map: MissionProjectionMap,
): void {
  const file = mapFile(workspace, intakeId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(map, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Contract grouping
// ---------------------------------------------------------------------------

interface SurfaceContractShape {
  title: string;
  summary: string;
  classification: 'public' | 'internal';
  compatibilityPolicy: 'frozen' | 'additive-only' | 'evolving' | 'internal';
}

/**
 * One contract shape per durable product surface.
 *
 * Compatibility policy is `additive-only` for every public surface a feature
 * creates. That is the conservative default and it is a real decision: it
 * says a later feature may add to this surface but may not change what it
 * already promises, which is exactly the protection Delta Authority Analysis
 * relies on when the NEXT specification arrives.
 */
const SURFACE_CONTRACTS: Readonly<Record<IrreversibleSurface, SurfaceContractShape>> =
  Object.freeze({
    'public-api': {
      title: 'Feature Public Surface',
      summary:
        'The API, console, and command surfaces this feature exposes and the behaviour users ' +
        'may depend on.',
      classification: 'public',
      compatibilityPolicy: 'additive-only',
    },
    'configuration-language': {
      title: 'Configuration and Authoring Format',
      summary:
        'The configuration and authoring format this feature accepts, and what a valid ' +
        'document means.',
      classification: 'public',
      compatibilityPolicy: 'additive-only',
    },
    'wire-protocol': {
      title: 'Protocol and Message Format',
      summary: 'The messages, events, and payload shapes this feature puts on the wire.',
      classification: 'public',
      compatibilityPolicy: 'additive-only',
    },
    'persisted-state': {
      title: 'Persisted State Model',
      summary: 'The records this feature persists and what they continue to mean over time.',
      classification: 'public',
      compatibilityPolicy: 'additive-only',
    },
    'sdk-contract': {
      title: 'SDK Contract',
      summary: 'The client-facing library surface this feature provides.',
      classification: 'public',
      compatibilityPolicy: 'additive-only',
    },
    'extension-spi': {
      title: 'Extension Points',
      summary: 'The extension seams this feature opens for code outside it.',
      classification: 'public',
      compatibilityPolicy: 'additive-only',
    },
    'compatibility-promise': {
      title: 'Compatibility Promise',
      summary: 'What this feature promises about compatibility with external formats and prior versions.',
      classification: 'public',
      compatibilityPolicy: 'additive-only',
    },
    'security-boundary': {
      title: 'Data Visibility and Security Boundary',
      summary: 'Which payloads this feature stores, returns, and shows, and to whom.',
      classification: 'public',
      compatibilityPolicy: 'additive-only',
    },
    'failure-delivery-semantics': {
      title: 'Failure and Delivery Semantics',
      summary: 'What callers observe when this feature fails, retries, or is interrupted.',
      classification: 'public',
      compatibilityPolicy: 'additive-only',
    },
    'cross-module-architecture': {
      title: 'System Boundaries',
      summary: 'Where this feature lives and which existing components it may and may not change.',
      classification: 'internal',
      compatibilityPolicy: 'internal',
    },
  });

/** The behaviour contract every feature gets: the scenarios it must satisfy. */
const BEHAVIOUR_CONTRACT: SurfaceContractShape = {
  title: 'Observable Behaviour',
  summary: 'The scenarios and edge cases this feature must handle, as a user observes them.',
  classification: 'public',
  compatibilityPolicy: 'additive-only',
};

const BEHAVIOUR_SURFACE_KEY = '__behaviour__';

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

export interface CompileRequest {
  intakeId: string;
  missionId: string;
  source: SpecSource;
  grounding: RepositoryGrounding;
  analysis: DeltaAuthorityAnalysis;
  /** Items whose blocking question is unanswered. Not compiled yet. */
  blockedItemIds: readonly string[];
  /** Product questions still open. Contracts wait for zero. */
  openQuestionCount: number;
}

export interface CompileResult {
  mission: MissionState;
  map: MissionProjectionMap;
  /** Delta items materialized on this pass. */
  compiledItemIds: string[];
  /** Required topics resolved on this pass. */
  resolvedTopics: DiscoveryTopic[];
  contractIds: string[];
  /**
   * Contract-bearing items the mission's own record bounds could not hold.
   *
   * Not an error and not a silent drop. A specification with more material
   * public statements than one mission can represent is a real thing, and
   * the honest response is to say so and hold the intake open rather than to
   * crash on a schema bound or to quietly build three-quarters of it.
   */
  overflowItemIds: string[];
}

/**
 * Headroom left below the mission's own record bounds.
 *
 * The mission caps decisions and facts at the schema level, and those caps
 * are load-bearing — they are what stops a mission record from becoming a
 * document nobody reads. The intake reserves a slice for the required-topic
 * decisions it must also write, so a specification that fills the budget
 * cannot make the topic floor unreachable.
 */
const TOPIC_DECISION_RESERVE = 12;
const FACT_BUDGET = 120;

/**
 * Record the submitted specification as durable mission truth.
 *
 * Runs on every discovery pass and is idempotent: an item already in the
 * projection map is skipped, so the second pass records only what the first
 * one could not.
 */
export function compileMissionTruth(
  deps: MissionDeps,
  intakeDeps: { workspace: WorkspaceInfo },
  request: CompileRequest,
): CompileResult {
  const map = readProjectionMap(intakeDeps.workspace, request.intakeId);
  const missionBefore = requireMissionState(intakeDeps.workspace, request.missionId);
  const missionGoal = missionBefore.goal;
  const blocked = new Set(request.blockedItemIds);
  // What the mission can still hold, minus the reserve for topic decisions.
  const decisionBudget = Math.max(
    0,
    MISSION_LIMITS.maxDecisions - missionBefore.counters.decisions - TOPIC_DECISION_RESERVE,
  );
  const overflowItemIds: string[] = [];

  // --- The provenance root ------------------------------------------------
  if (map.sourceTurnId === undefined) {
    const { turn } = recordTurn(deps, request.missionId, {
      speaker: 'user',
      kind: 'statement',
      text: sourceTurnText(request.source),
    });
    map.sourceTurnId = turn.turnId;
    writeProjectionMap(intakeDeps.workspace, request.intakeId, map);
  }
  const sourceTurnId = map.sourceTurnId;

  const facts: FactInput[] = [];
  const decisions: DecisionInput[] = [];
  const contracts: ContractInput[] = [];
  const compiledItemIds: string[] = [];

  // --- Facts: what the specification says, before any judgment ------------
  // Recorded once, on the first pass, so the mission carries the ask itself
  // and not only the conclusions drawn from it.
  if (map.fieldsWritten !== true) {
    for (const chunk of request.source.chunks) {
      if (facts.length >= FACT_BUDGET / 2) break;
      if (chunk.kind === 'heading' || chunk.kind === 'narrative') continue;
      facts.push({
        statement: clip(chunk.text, INTAKE_LIMITS.maxTextChars),
        provenance: 'known-from-user',
        sourceTurnId,
        topics: topicsOf(chunk.text).slice(0, 8),
      });
    }
  }

  // --- Decisions and contracts for settled items ---------------------------
  //
  // Two different "already done" tests, because the two records have
  // different lifetimes. A DECISION is written the first pass an item is
  // settled; a CONTRACT is written once, later, when everything is settled.
  // So an item can legitimately have a decision and still be waiting for its
  // requirement to land in a contract.
  const pendingBySurface = new Map<string, DeltaItem[]>();
  for (const item of request.analysis.items) {
    if (blocked.has(item.itemId)) continue;
    if (item.classification === 'UNKNOWN_PRODUCT_AUTHORITY') continue;
    if (item.classification === 'CONTRADICTION') continue;
    if (item.classification === 'EXISTING_SEALED_CONTRACT_CHANGE') continue;

    // A DECISION is a durable product commitment, and only a statement that
    // becomes a contract requirement is one. An implementation detail is a
    // recorded FACT — it is true, it came from the user, and it binds
    // nobody. Making the distinction here is not tidiness: the mission
    // caps decisions at a few hundred precisely because a registry of
    // three hundred "decisions" that are mostly file-layout notes is not a
    // record anybody can use.
    const bearsContract =
      item.classification !== 'IMPLEMENTATION_DETAIL' &&
      item.classification !== 'EXISTING_CONTRACT_COMPATIBLE';

    if (map.itemDecisions[item.itemId] === undefined) {
      if (bearsContract && decisions.length < decisionBudget) {
        compiledItemIds.push(item.itemId);
        decisions.push({
          decision: clip(item.statement, INTAKE_LIMITS.maxTextChars),
          rationale: clip(item.rationale, INTAKE_LIMITS.maxTextChars),
          provenance: 'known-from-user',
          sourceTurnId,
          topics: (item.topics as DiscoveryTopic[]).slice(0, 8),
        });
      } else if (bearsContract) {
        // Over the bound. Recorded as an overflow rather than dropped
        // silently: the caller turns it into an UNACCOUNTED coverage entry,
        // which holds the intake open and says exactly why.
        overflowItemIds.push(item.itemId);
        continue;
      } else if (facts.length < FACT_BUDGET) {
        facts.push({
          statement: clip(item.statement, INTAKE_LIMITS.maxTextChars),
          provenance: 'known-from-user',
          sourceTurnId,
          topics: (item.topics as DiscoveryTopic[]).slice(0, 8),
        });
      }
    }

    if (!bearsContract) continue;
    if (map.itemContracts[item.itemId] !== undefined) continue;
    // An extension of an existing contract becomes a requirement on the
    // FEATURE's own contract, never a write into the prior mission's
    // registry. The extension is recorded on the approval so it is visible,
    // and the older contract is left byte-identical — silently mutating a
    // prior sealed contract is the one thing this analysis exists to
    // prevent.
    const key = surfaceKeyFor(item);
    const bucket = pendingBySurface.get(key) ?? [];
    bucket.push(item);
    pendingBySurface.set(key, bucket);
  }

  // --- Required-topic resolution ------------------------------------------
  const resolvedTopics: DiscoveryTopic[] = [];
  const topicDecisionInputs: DecisionInput[] = [];
  for (const topic of REQUIRED_TOPICS) {
    if (map.topicDecisions[topic] !== undefined) continue;
    const resolution = resolveRequiredTopic(topic, request, sourceTurnId, missionGoal);
    if (resolution === undefined) continue;
    resolvedTopics.push(topic);
    topicDecisionInputs.push(resolution);
  }

  // Decisions must exist before contracts can cite them, so this is two
  // assessments rather than one. The mission service assigns ids in order,
  // which is what makes the mapping below deterministic.
  const decisionAssessment = recordAssessment(deps, request.missionId, {
    ...(facts.length > 0 ? { facts } : {}),
    ...(decisions.length > 0 || topicDecisionInputs.length > 0
      ? { decisions: [...decisions, ...topicDecisionInputs] }
      : {}),
    ...(map.fieldsWritten !== true
      ? { missionUpdates: missionFieldsFrom(request) }
      : {}),
  });

  // Map item → decision id in the order they were submitted.
  decisions.forEach((_, index) => {
    const itemId = compiledItemIds[index];
    const decisionId = decisionAssessment.decisionIds[index];
    if (itemId !== undefined && decisionId !== undefined) map.itemDecisions[itemId] = decisionId;
  });
  topicDecisionInputs.forEach((_, index) => {
    const topic = resolvedTopics[index];
    const decisionId = decisionAssessment.decisionIds[decisions.length + index];
    if (topic !== undefined && decisionId !== undefined) map.topicDecisions[topic] = decisionId;
  });
  if (map.fieldsWritten !== true) map.fieldsWritten = true;
  writeProjectionMap(intakeDeps.workspace, request.intakeId, map);

  // --- Contracts -----------------------------------------------------------
  // Compiled ONCE, when discovery has converged, and deliberately not
  // incrementally.
  //
  // Decisions and facts are append-only history and can accumulate over
  // several passes without lying about anything. A CONTRACT is different: it
  // is one promise with one requirement set, and the mission registry creates
  // contracts at revision 1 — the only path to a later revision is a
  // human-approved change request, which is exactly right and exactly wrong
  // for an intake that is still gathering answers. Compiling on every pass
  // would produce a second "Failure and Delivery Semantics" contract the
  // moment an answer unblocked one more statement, and a registry with two
  // contracts for one surface is a registry nobody can read.
  //
  // So: wait until nothing is blocked and no question is open, then compile
  // the complete set. Every later pass finds the items already mapped and
  // does nothing, which is what makes re-running discovery free.
  const converged = request.blockedItemIds.length === 0 && request.openQuestionCount === 0;
  for (const [key, items] of converged ? [...pendingBySurface.entries()].sort() : []) {
    if (contracts.length >= 40) break;
    const base =
      key === BEHAVIOUR_SURFACE_KEY
        ? BEHAVIOUR_CONTRACT
        : SURFACE_CONTRACTS[key as IrreversibleSurface];
    if (base === undefined) continue;
    // A surface that already has a contract gets an ADDENDUM rather than a
    // second contract with the same title. It happens only when a question
    // opened after convergence settled one more statement, and naming it
    // honestly beats either a confusing twin or a silent mutation of the
    // contract already approved.
    const priorForSurface = map.surfaceContracts[key];
    const shape: SurfaceContractShape =
      priorForSurface === undefined
        ? base
        : {
            ...base,
            title: `${base.title} (addendum)`,
            summary: `${base.summary} Recorded after ${priorForSurface}, which is unchanged.`,
          };
    const decisionIds = items
      .map((item) => map.itemDecisions[item.itemId])
      .filter((id): id is string => id !== undefined);
    if (decisionIds.length === 0) continue;
    contracts.push({
      title: shape.title,
      summary: shape.summary,
      classification: shape.classification,
      compatibilityPolicy: shape.compatibilityPolicy,
      requirements: items.slice(0, 60).map((item) => ({
        statement: clip(item.statement, INTAKE_LIMITS.maxTextChars),
        decisionIds: [map.itemDecisions[item.itemId] ?? decisionIds[0] ?? ''].filter(
          (id) => id.length > 0,
        ),
      })),
      decisionIds: decisionIds.slice(0, 30),
    });
  }

  let mission = decisionAssessment.mission;
  let contractIds: string[] = [];
  if (contracts.length > 0) {
    const contractAssessment = recordAssessment(deps, request.missionId, { contracts });
    mission = contractAssessment.mission;
    contractIds = contractAssessment.contractIds;
    const orderedKeys = [...pendingBySurface.keys()].sort().filter((key) => {
      const shape =
        key === BEHAVIOUR_SURFACE_KEY
          ? BEHAVIOUR_CONTRACT
          : SURFACE_CONTRACTS[key as IrreversibleSurface];
      return shape !== undefined;
    });
    orderedKeys.forEach((key, index) => {
      const contractId = contractIds[index];
      if (contractId === undefined) return;
      map.surfaceContracts[key] = contractId;
      for (const item of pendingBySurface.get(key) ?? []) {
        map.itemContracts[item.itemId] = contractId;
      }
    });
    writeProjectionMap(intakeDeps.workspace, request.intakeId, map);
  }

  return { mission, map, compiledItemIds, resolvedTopics, contractIds, overflowItemIds };
}

// ---------------------------------------------------------------------------
// Mission fields
// ---------------------------------------------------------------------------

function missionFieldsFrom(request: CompileRequest): MissionAssessmentInput['missionUpdates'] {
  const nonGoals: string[] = [];
  const criteria: string[] = [];
  const constraints: string[] = [];

  for (const chunk of request.source.chunks) {
    if (chunk.kind === 'non-goal' && nonGoals.length < 30) {
      nonGoals.push(clip(chunk.text, 600));
      continue;
    }
    if (chunk.kind === 'scenario' && criteria.length < 34) {
      criteria.push(acceptanceCriterionFrom(chunk));
      continue;
    }
    if (
      chunk.kind === 'normative' &&
      criteria.length < 40 &&
      VERIFIABLE_PATTERN.test(chunk.text)
    ) {
      criteria.push(acceptanceCriterionFrom(chunk));
      continue;
    }
    if (chunk.kind === 'normative' && constraints.length < 20 && CONSTRAINT_PATTERN.test(chunk.text)) {
      constraints.push(clip(chunk.text, 600));
    }
  }

  return {
    ...(nonGoals.length > 0 ? { nonGoals } : {}),
    ...(criteria.length > 0 ? { successCriteria: criteria } : {}),
    ...(constraints.length > 0 ? { constraints } : {}),
  };
}

/**
 * Statements that describe something demonstrable.
 *
 * These become acceptance criteria, which the seal compiles and the closure
 * oracle audits. The bar is "a person could watch this happen": a criterion
 * that cannot be observed cannot be closed on evidence, and an unclosable
 * criterion would hold an otherwise finished run open forever.
 */
const VERIFIABLE_PATTERN =
  /\b(end[- ]to[- ]end|demonstrab\w+|runnable|must actually|verif\w+|prove[sn]?|browser|console|render\w*|display\w*|user can|buildable|usable|run(s|nable)? locally|docker|compose)\b/i;

const CONSTRAINT_PATTERN =
  /\b(must not|only|no more than|at most|within|limited to|constraint|budget|never)\b/i;

function acceptanceCriterionFrom(chunk: SourceChunk): string {
  const body = chunk.text.replace(/^(\s*)([-*+]|\d+[.)])\s+/, '').trim();
  const context = chunk.headingPath[chunk.headingPath.length - 1];
  // The heading is carried into the criterion so an enumerated edge case
  // ("passport present, boarding pass missing") still says what it is an
  // edge case OF once it is read on its own in a closure ledger.
  const prefixed =
    context !== undefined && !body.toLowerCase().includes(context.toLowerCase().slice(0, 12))
      ? `${context}: ${body}`
      : body;
  return clip(prefixed, 600);
}

// ---------------------------------------------------------------------------
// Required topics
// ---------------------------------------------------------------------------

/**
 * Resolve one required discovery topic from evidence.
 *
 * The order is the honesty order. The submitted specification speaks first,
 * because the user wrote it. Existing product authority speaks second,
 * because it is durable truth this feature does not change. If neither
 * speaks, the topic stays unresolved and `markUnresolvedRequiredTopics`
 * turns it into a question — which is the correct outcome, not a failure.
 */
function resolveRequiredTopic(
  topic: DiscoveryTopic,
  request: CompileRequest,
  sourceTurnId: string,
  missionGoal: string,
): DecisionInput | undefined {
  // The GOAL is never a gap. The submitted specification is the user's own
  // statement of what they want, and the mission carries it verbatim: asking
  // "what is this feature for?" of somebody who just wrote a specification
  // for it is the exact failure the evidence screen exists to prevent,
  // arriving through the back door of the required-topic floor.
  if (topic === 'goal') {
    return {
      decision: clip(`Goal: ${missionGoal}`, INTAKE_LIMITS.maxTextChars),
      rationale: 'Stated by the submitted specification, which the mission records verbatim.',
      provenance: 'known-from-user',
      sourceTurnId,
      topics: ['goal'],
    };
  }

  // Any non-heading chunk may resolve a topic, and the HEADING IT SITS
  // UNDER counts as part of its text.
  //
  // Both halves were learned the hard way. A specification says what its
  // canonical model is in a prose paragraph, not in a sentence containing
  // the word "must" — excluding narrative chunks made the topic look
  // unaddressed and produced a question asking the author to restate the
  // section they had just written. And the paragraph under "## Canonical
  // model" frequently never uses the word "model" at all; the heading is
  // where the author put it.
  const topicMatches = (chunk: SourceChunk): boolean =>
    topicsOf(`${chunk.headingPath.join(' ')} ${chunk.text}`).includes(topic);
  const candidates = request.source.chunks.filter(
    (chunk) => chunk.kind !== 'heading' && topicMatches(chunk),
  );
  // Prefer a stated obligation over prose when both speak to the topic: a
  // requirement is stronger evidence than a description of one.
  const fromSpec =
    candidates.find((chunk) => chunk.kind === 'normative' || chunk.kind === 'scenario') ??
    candidates[0];
  if (fromSpec !== undefined) {
    return {
      decision: topicDecisionText(topic, clip(fromSpec.text, 900)),
      rationale: `Stated by the submitted specification (${fromSpec.chunkId}).`,
      provenance: 'known-from-user',
      sourceTurnId,
      topics: [topic],
    };
  }

  const fromEvidence = request.grounding.evidence.find(
    (evidence) => evidence.authoritative && evidence.topics.includes(topic),
  );
  if (fromEvidence !== undefined) {
    return {
      decision: existingTruthText(topic, fromEvidence),
      rationale:
        `Existing product authority (${fromEvidence.kind} ${fromEvidence.ref}) already ` +
        'determines this, and the submitted specification does not change it.',
      provenance: 'known-from-repository-evidence',
      topics: [topic],
    };
  }

  return undefined;
}

function topicDecisionText(topic: DiscoveryTopic, evidence: string): string {
  return clip(`${TOPIC_PREFIX[topic] ?? `On ${topic}:`} ${evidence}`, INTAKE_LIMITS.maxTextChars);
}

function existingTruthText(topic: DiscoveryTopic, evidence: RepositoryEvidence): string {
  return clip(
    `${TOPIC_PREFIX[topic] ?? `On ${topic}:`} unchanged by this feature — the existing ` +
      `product already determines it (${evidence.ref}: ${evidence.summary}).`,
    INTAKE_LIMITS.maxTextChars,
  );
}

const TOPIC_PREFIX: Partial<Record<DiscoveryTopic, string>> = {
  goal: 'Goal:',
  'use-cases': 'Use cases:',
  'system-boundaries': 'System boundaries:',
  'canonical-model': 'Canonical model:',
  'public-api': 'Public API:',
  'failure-semantics': 'Failure semantics:',
  compatibility: 'Compatibility:',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function surfaceKeyFor(item: DeltaItem): string {
  const surfaces = item.affectedSurfaces.length > 0 ? item.affectedSurfaces : surfacesOf(item.statement).map((s) => s.surface);
  const first = surfaces[0];
  return first ?? BEHAVIOUR_SURFACE_KEY;
}

/**
 * The user turn that records the submitted specification.
 *
 * Bounded by the mission schema at 8,000 characters, and a real
 * specification can exceed that. The turn then carries the opening of the
 * document plus an explicit, honest statement that it is an excerpt and
 * where the whole thing lives. A truncated turn that pretended to be the
 * full text would make every decision citing it slightly false.
 */
function sourceTurnText(source: SpecSource): string {
  const header =
    `Submitted product specification (${source.byteLength} bytes, ` +
    `${source.chunks.length} parsed section(s), sha256 ${source.contentHash.slice(0, 16)}…). ` +
    `Stored verbatim at ${source.storedAt}.`;
  const body = source.chunks
    .map((chunk) => chunk.text)
    .join('\n\n')
    .trim();
  const budget = 7_600 - header.length;
  if (body.length <= budget) return `${header}\n\n${body}`;
  return (
    `${header}\n\nEXCERPT (the first ${budget} characters; the complete document is the ` +
    `record at ${source.storedAt}):\n\n${body.slice(0, budget)}`
  );
}
