import type { DiscoveryTopic, MissionCoverage } from '@specbridge/mission';
import type {
  ChunkCoverage,
  DeltaAuthorityAnalysis,
  IntakeReadiness,
  ProductQuestion,
  RepositoryEvidence,
  SourceChunk,
} from './state.js';
import { normativeChunks } from './document.js';
import { containment, tokenSet } from './text.js';

/**
 * Discovery convergence.
 *
 * The failure this file prevents is the one everybody has seen: an
 * assistant that keeps finding one more useful thing to ask about, forever.
 * More detail is ALWAYS obtainable, so "have we asked enough?" cannot be a
 * judgment call — it has to be a computed property of durable state, and it
 * has to be able to say yes.
 *
 * Four gates, all deterministic, all derived:
 *
 *   1. every normative statement in the submitted specification is
 *      accounted for — carried by discovered truth, waiting on an open
 *      question, already true, or explicitly excluded;
 *   2. no product question is open;
 *   3. the delta authority analysis is complete;
 *   4. the mission's own coverage gate holds.
 *
 * When all four hold, the intake is READY_FOR_APPROVAL and discovery stops.
 * Not "could stop" — stops. There is deliberately no fifth gate that a model
 * could argue itself into, and no path by which an optional question keeps
 * the conversation alive.
 *
 * Gate 1 is what makes a LONG specification safe. A model summary that
 * quietly dropped section 9 leaves nine unaccounted chunks, and the gate
 * refuses. The original document, not anybody's reading of it, is what has
 * to be covered.
 */

export interface ReconcileInput {
  chunks: readonly SourceChunk[];
  analysis: DeltaAuthorityAnalysis;
  questions: readonly ProductQuestion[];
  evidence: readonly RepositoryEvidence[];
  /**
   * Contract-bearing items the mission's record bounds could not hold.
   *
   * A specification with more material public statements than one mission
   * can represent is a real thing, and the honest answer is to leave the
   * statements UNACCOUNTED — which holds the intake open and names the
   * reason — rather than to crash on a schema bound or to build most of it.
   */
  overflowItemIds?: readonly string[] | undefined;
}

/**
 * How much of a normative chunk must appear in existing product authority
 * before the chunk counts as ALREADY_TRUE.
 *
 * High: the consequence of a false positive is dropping a requirement the
 * user wrote on the grounds that the product already does it, which is the
 * single most damaging thing a coverage reconciliation could get wrong.
 */
const ALREADY_TRUE_CONTAINMENT = 0.85;

/**
 * Account for every normative statement in the submitted specification.
 *
 * Deterministic and total: every normative chunk gets exactly one state, and
 * `UNACCOUNTED` is the only one that blocks.
 */
export function reconcileCoverage(input: ReconcileInput): ChunkCoverage[] {
  const byChunk = new Map<string, ChunkCoverage>();

  // A chunk a delta item was extracted from is carried by that item, unless
  // the item is itself waiting on a question.
  const openQuestionByItem = new Map<string, string>();
  for (const question of input.questions) {
    if (question.status !== 'open') continue;
    if (question.deltaItemId !== undefined) openQuestionByItem.set(question.deltaItemId, question.questionId);
    for (const chunkId of question.sourceChunkIds) {
      byChunk.set(chunkId, {
        chunkId,
        state: 'QUESTIONED',
        carriedBy: [question.questionId],
      });
    }
  }

  const overflow = new Set(input.overflowItemIds ?? []);

  for (const item of input.analysis.items) {
    if (overflow.has(item.itemId)) continue;
    for (const chunkId of item.sourceChunkIds) {
      const blockingQuestion = openQuestionByItem.get(item.itemId);
      if (blockingQuestion !== undefined) {
        byChunk.set(chunkId, {
          chunkId,
          state: 'QUESTIONED',
          carriedBy: [blockingQuestion, item.itemId],
        });
        continue;
      }
      if (byChunk.get(chunkId)?.state === 'QUESTIONED') continue;
      const state =
        item.classification === 'EXISTING_CONTRACT_COMPATIBLE'
          ? 'ALREADY_TRUE'
          : item.classification === 'UNKNOWN_PRODUCT_AUTHORITY' ||
              item.classification === 'CONTRADICTION' ||
              item.classification === 'EXISTING_SEALED_CONTRACT_CHANGE'
            ? 'QUESTIONED'
            : 'CARRIED';
      byChunk.set(chunkId, { chunkId, state, carriedBy: [item.itemId] });
    }
  }

  const authoritative = input.evidence.filter((evidence) => evidence.authoritative);
  const out: ChunkCoverage[] = [];
  for (const chunk of normativeChunks(input.chunks)) {
    const existing = byChunk.get(chunk.chunkId);
    if (existing !== undefined) {
      out.push(existing);
      continue;
    }
    // Nothing extracted it. Existing product authority may still satisfy it,
    // which is the common case for a feature spec restating how the product
    // already behaves.
    const tokens = tokenSet(chunk.text);
    const match = authoritative.find(
      (evidence) => containment(tokens, tokenSet(evidence.summary)) >= ALREADY_TRUE_CONTAINMENT,
    );
    if (match !== undefined) {
      out.push({ chunkId: chunk.chunkId, state: 'ALREADY_TRUE', carriedBy: [match.evidenceId] });
      continue;
    }
    out.push({ chunkId: chunk.chunkId, state: 'UNACCOUNTED', carriedBy: [] });
  }
  return out;
}

export interface ReadinessInput {
  coverage: readonly ChunkCoverage[];
  analysis: DeltaAuthorityAnalysis;
  questions: readonly ProductQuestion[];
  missionCoverage: MissionCoverage | undefined;
  /** True when the mission's record bounds refused some material statements. */
  overflowed?: boolean | undefined;
  /**
   * Product contracts the intake compiled.
   *
   * Synthesis needs at least one, and an intake that reaches the human with
   * none produces an immutable approval pointing at a mission that cannot
   * synthesize — the approval is written, then the very next step fails. The
   * gate belongs here, before anybody authorizes anything.
   */
  productContractCount?: number | undefined;
}

/**
 * The convergence verdict.
 *
 * `ready` is a conjunction, and every false conjunct produces a reason a
 * person can act on. A readiness report that said "not yet" without saying
 * what would make it yes is how a workflow becomes a black box.
 */
export function assessReadiness(input: ReadinessInput): IntakeReadiness {
  const unaccounted = input.coverage
    .filter((entry) => entry.state === 'UNACCOUNTED')
    .map((entry) => entry.chunkId);
  const open = input.questions
    .filter((question) => question.status === 'open')
    .map((question) => question.questionId);
  const unresolvedRequiredTopics = [
    ...((input.missionCoverage?.unresolvedRequiredTopics ?? []) as DiscoveryTopic[]),
  ];
  const missionContractReady = input.missionCoverage?.contractReady ?? false;
  const deltaComplete = input.analysis.complete;

  const reasons: string[] = [];
  if (unaccounted.length > 0) {
    reasons.push(
      `${unaccounted.length} normative statement(s) from the submitted specification are not ` +
        `accounted for: ${unaccounted.slice(0, 10).join(', ')}.`,
    );
    if (input.overflowed === true) {
      reasons.push(
        'The submitted specification contains more material public statements than one ' +
          'mission record can represent. Split it into separate feature specifications and ' +
          'submit them one at a time.',
      );
    }
  }
  if (open.length > 0) {
    reasons.push(
      `${open.length} product question(s) are open: ${open.slice(0, 10).join(', ')}.`,
    );
  }
  if (!deltaComplete) {
    reasons.push(
      input.analysis.reasons.length > 0
        ? `Delta authority analysis is incomplete: ${input.analysis.reasons.join(' ')}`
        : 'Delta authority analysis is incomplete.',
    );
  }
  const contractCount = input.productContractCount;
  if (contractCount !== undefined && contractCount === 0) {
    reasons.push(
      'No product contract was compiled from the submitted specification, so there is nothing ' +
        'to build. State what the feature promises — a public surface, a configuration format, ' +
        'a failure behaviour — rather than only how it should be implemented.',
    );
  }
  if (!missionContractReady) {
    reasons.push(
      input.missionCoverage === undefined
        ? 'The mission has no coverage snapshot yet.'
        : `The mission coverage gate does not hold: ${input.missionCoverage.reasons.join(' ')}`,
    );
  }

  const ready =
    unaccounted.length === 0 &&
    open.length === 0 &&
    deltaComplete &&
    missionContractReady &&
    (contractCount === undefined || contractCount > 0);
  if (ready) {
    reasons.push(
      'Every normative statement is accounted for, no product question is open, delta ' +
        'authority analysis is complete, and the mission coverage gate holds.',
    );
  }

  return {
    ready,
    unaccountedChunkIds: unaccounted.slice(0, 40),
    openQuestionIds: open.slice(0, 40),
    unresolvedRequiredTopics,
    deltaAnalysisComplete: deltaComplete,
    missionContractReady,
    reasons,
  };
}
