import type { ObjectivesPolicy, SemanticEvaluationMode } from '@specbridge/core';
import type { ConstitutionRule, ProductContract } from '@specbridge/mission';
import type { CandidateArtifact, EvaluationRecord, WorkUnit } from './state.js';
import { EVALUATION_RECORD_SCHEMA_VERSION, evaluationRecordSchema } from './state.js';
import { evaluateProjectionFreshness } from './projection.js';
import type { ContextProjection } from './state.js';

/**
 * The deterministic evaluation layer. Runs FIRST, always, and never invokes
 * a model: identity, protected paths, local verification, projection
 * freshness, scope, and the machine-checkable contract/constitution guard
 * patterns. A deterministic answer is never delegated to a model.
 *
 * The semantic layer (an EVALUATOR worker) runs only where judgment is
 * genuinely required, per policy — and its verdict feeds aggregation; it
 * never completes anything.
 */

export interface DeterministicEvaluationInput {
  candidate: CandidateArtifact;
  workUnit: WorkUnit;
  projection: ContextProjection;
  /** The ACTIVE registry view at evaluation time. */
  contracts: readonly ProductContract[];
  constitutionRules: readonly ConstitutionRule[];
  constitutionVersion: number;
  protectedViolations: readonly string[];
  /** The raw candidate patch (guard patterns grep its added lines). */
  patch: string | undefined;
  createdAt: string;
  evaluationId: string;
}

export interface GuardHit {
  source: string;
  pattern: string;
  line: string;
  contractId?: string | undefined;
}

/**
 * Grep the ADDED lines of a candidate diff for the machine-checkable guard
 * patterns declared on constitution rules and contract invariants. A hit is
 * a structural violation of approved architecture — the deterministic form
 * of "one worker proposed nextState inside ActionResult".
 */
export function screenGuardPatterns(
  patch: string | undefined,
  contracts: readonly ProductContract[],
  constitutionRules: readonly ConstitutionRule[],
): GuardHit[] {
  if (patch === undefined || patch.length === 0) return [];
  const addedLines = patch
    .split(/\r?\n/)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1));
  if (addedLines.length === 0) return [];

  const guards: { source: string; pattern: string; contractId?: string }[] = [];
  for (const rule of constitutionRules) {
    if (rule.status !== 'active') continue;
    for (const pattern of rule.guardPatterns) {
      guards.push({ source: rule.ruleId, pattern });
    }
  }
  for (const contract of contracts) {
    for (const invariant of contract.invariants) {
      for (const pattern of invariant.guardPatterns) {
        guards.push({ source: `${contract.contractId}/${invariant.invariantId}`, pattern, contractId: contract.contractId });
      }
    }
  }

  const hits: GuardHit[] = [];
  for (const guard of guards) {
    let regex: RegExp;
    try {
      regex = new RegExp(guard.pattern, 'i');
    } catch {
      continue; // Validated at record time; an unparseable pattern is inert.
    }
    for (const line of addedLines) {
      if (!regex.test(line)) continue;
      hits.push({
        source: guard.source,
        pattern: guard.pattern,
        line: line.trim().slice(0, 200),
        ...(guard.contractId !== undefined ? { contractId: guard.contractId } : {}),
      });
      break; // One hit per guard is enough evidence.
    }
  }
  return hits;
}

/**
 * Run every deterministic check and fold them into one evaluation record.
 * PASS means "no deterministic reason to reject"; CONFLICT carries the
 * guard evidence and the decision kind for authority routing.
 */
/**
 * Safe-process statuses that mean the command NEVER RAN.
 *
 * The same set `executor-dispatch` uses, deliberately: one definition of
 * "did not run" across both execution paths, because the difference between
 * a failing test and an unstartable test runner is the difference between
 * repairing code and repairing a toolchain.
 *
 * `timeout` is NOT here. A command that started and hung has told us
 * something about the candidate, even if not much.
 */
const UNAVAILABLE_COMMAND_STATUSES: readonly string[] = [
  'spawn-failed',
  'not-found',
  'unavailable',
];

export function isUnavailableStatus(status: string): boolean {
  return UNAVAILABLE_COMMAND_STATUSES.includes(status);
}

/** A leading article, so "the new demo module" starts at the noun. */
const LEADING_ARTICLE = /^(?:the|a|an)\s+/i;

/** Trailing punctuation or an opening parenthetical the model appended. */
const TRAILING_PUNCTUATION_OR_PAREN = /[).,;:]+$/;

/** A bare filename with an extension, e.g. `settings.gradle.kts`. */
const PATH_LIKE_FILE = /^[\w.-]+\.[A-Za-z0-9]{1,8}$/;
/**
 * The path a declared "expected area" actually names, if it names one.
 *
 * The DECOMPOSER contract lets an area be free text, and models write it that
 * way: "settings.gradle.kts (root multi-project registration)", "the new demo
 * module directory and its build.gradle.kts". Compared literally, a real path
 * can never match either, so the scope check refused every candidate.
 *
 * The vNext.10.1 dogfood lost a whole objective to this. The builder changed
 * settings.gradle.kts, docs/STATUS.md and the new module — exactly what the
 * areas described — and was refused three times running on an identical
 * verdict, then forced a replan. An objective whose decomposer writes
 * descriptive areas could not be built at all.
 *
 * A check that cannot make its comparison must not fail the work. Areas that
 * yield no path are dropped, and when none survives the check is recorded as
 * not judged rather than as passed.
 */
function pathPrefixOf(area: string): string | undefined {
  const trimmed = area.trim().replace(LEADING_ARTICLE, '');
  // The first token that looks like a path: it has a separator or an
  // extension, and no spaces.
  for (const token of trimmed.split(/[\s,;]+/)) {
    const candidate = token.replace(TRAILING_PUNCTUATION_OR_PAREN, '');
    if (candidate.length === 0) continue;
    if (candidate.includes('/') || PATH_LIKE_FILE.test(candidate)) return candidate;
  }
  return undefined;
}

export function evaluateDeterministically(input: DeterministicEvaluationInput): EvaluationRecord {
  const checks: { name: string; passed: boolean; detail?: string }[] = [];
  const reasons: string[] = [];
  const affected = new Set<string>();

  // 1. Identity binding: the candidate must present the projection and
  //    contract snapshot this attempt was given.
  const identityOk =
    input.candidate.contextProjectionHash === input.projection.contentHash &&
    input.candidate.contractSnapshotHash === input.projection.contractSnapshotHash;
  checks.push({
    name: 'identity-binding',
    passed: identityOk,
    ...(identityOk ? {} : { detail: 'projection or contract snapshot hash mismatch' }),
  });
  if (!identityOk) reasons.push('the candidate does not present the hashes this attempt was bound to');

  // 2. Protected paths.
  const protectedOk = input.protectedViolations.length === 0;
  checks.push({
    name: 'protected-paths',
    passed: protectedOk,
    ...(protectedOk ? {} : { detail: input.protectedViolations.slice(0, 10).join(', ') }),
  });
  if (!protectedOk) {
    reasons.push(`the candidate touches protected path(s): ${input.protectedViolations.slice(0, 5).join(', ')}`);
  }

  // 3. Projection freshness against the CURRENT registry.
  const freshness = evaluateProjectionFreshness(input.projection, {
    contracts: input.contracts.map((contract) => ({ contractId: contract.contractId, revision: contract.revision })),
    constitutionVersion: input.constitutionVersion,
  });
  checks.push({
    name: 'projection-freshness',
    passed: freshness.fresh,
    ...(freshness.fresh ? {} : { detail: freshness.reasons.join('; ') }),
  });
  if (!freshness.fresh) reasons.push(`stale context: ${freshness.reasons.join('; ')}`);

  // 4. Local verification (builders run the trusted commands in the worktree).
  //
  // "The tests failed" and "the test runner never started" are different
  // facts, and conflating them is expensive: the vNext.10 StepRelay dogfood
  // spent three repair/replan cycles rewriting correct code because
  // `gradlew.bat` could not be spawned inside the builder's worktree. The
  // task-execution path has always kept them apart (see `executor-dispatch`,
  // which marks a spawn-failed command `unavailable` because "a command that
  // never started proves nothing about the code"); this path did not.
  const verificationRelevant = input.workUnit.kind === 'build';
  const failedCommands = input.candidate.localVerification.commands.filter(
    (command) => command.status !== 'ok',
  );
  const verificationUnavailable =
    verificationRelevant &&
    input.candidate.localVerification.ran &&
    !input.candidate.localVerification.passed &&
    failedCommands.length > 0 &&
    failedCommands.every((command) => isUnavailableStatus(command.status));
  const verificationOk =
    !verificationRelevant ||
    !input.candidate.localVerification.ran ||
    input.candidate.localVerification.passed;
  checks.push({
    name: 'local-verification',
    passed: verificationOk,
    ...(verificationOk
      ? {}
      : {
          detail: `${verificationUnavailable ? 'could not run' : 'failed'}: ${failedCommands
            .map((command) => `${command.name} (${command.status})`)
            .join(', ')}`.slice(0, 600),
        }),
  });
  if (!verificationOk) {
    reasons.push(
      verificationUnavailable
        ? `local verification COULD NOT RUN inside the isolated worktree (${failedCommands
            .map((command) => `${command.name}: ${command.status}`)
            .join(', ')}); nothing was proven about the candidate`
        : 'local verification failed inside the isolated worktree',
    );
  }

  // 5. A build candidate must actually change something.
  const changesOk = input.workUnit.kind !== 'build' || input.candidate.changedFiles.length > 0;
  checks.push({
    name: 'non-empty-change',
    passed: changesOk,
    ...(changesOk ? {} : { detail: 'the builder claimed completion but the worktree is byte-identical' }),
  });
  if (!changesOk) reasons.push('the candidate contains no changes');

  // 6. Scope: changed paths against declared expected areas (advisory when
  //    areas were declared; a fully-off-scope change is a failure).
  let scopeDetail: string | undefined;
  let scopeOk = true;
  const declaredAreas = input.workUnit.expectedAreas
    .map((area) => pathPrefixOf(area))
    .filter((area): area is string => area !== undefined);
  if (declaredAreas.length > 0 && input.candidate.changedFiles.length > 0) {
    const inScope = input.candidate.changedFiles.filter((file) =>
      declaredAreas.some(
        (area) =>
          file.path === area ||
          file.path.startsWith(area.endsWith('/') ? area : `${area}/`) ||
          file.path.startsWith(area),
      ),
    );
    if (inScope.length === 0) {
      scopeOk = false;
      scopeDetail = `none of the ${input.candidate.changedFiles.length} changed file(s) fall inside the declared areas`;
      reasons.push('every changed file is outside the declared expected areas');
    } else if (inScope.length < input.candidate.changedFiles.length) {
      scopeDetail = `${input.candidate.changedFiles.length - inScope.length} changed file(s) outside declared areas (advisory)`;
    }
  }
  if (declaredAreas.length === 0 && input.workUnit.expectedAreas.length > 0) {
    scopeDetail = 'the declared areas name no path this check can compare against; scope not judged';
  }
  checks.push({ name: 'scope', passed: scopeOk, ...(scopeDetail !== undefined ? { detail: scopeDetail } : {}) });

  // 7. Contract / constitution guard patterns over the added lines.
  const guardHits = screenGuardPatterns(input.patch, input.contracts, input.constitutionRules);
  checks.push({
    name: 'contract-guards',
    passed: guardHits.length === 0,
    ...(guardHits.length > 0
      ? { detail: guardHits.map((hit) => `${hit.source}: "${hit.line.slice(0, 80)}"`).join('; ') }
      : {}),
  });
  for (const hit of guardHits) {
    reasons.push(`guard ${hit.source} (${hit.pattern}) matched an added line: "${hit.line.slice(0, 120)}"`);
    if (hit.contractId !== undefined) affected.add(hit.contractId);
  }

  // Verdict folding: guard hits are CONFLICTS (approved architecture is
  // contradicted — an authority question, not a quality question); anything
  // else failing is FAIL; stale context alone is also FAIL (replan follows).
  const verdict: EvaluationRecord['verdict'] =
    guardHits.length > 0
      ? 'CONFLICT'
      : checks.every((check) => check.passed)
        ? 'PASS'
        : 'FAIL';

  return evaluationRecordSchema.parse({
    schemaVersion: EVALUATION_RECORD_SCHEMA_VERSION,
    evaluationId: input.evaluationId,
    jobId: input.candidate.jobId,
    objectiveNodeId: input.candidate.objectiveNodeId,
    workUnitId: input.candidate.workUnitId,
    attempt: input.candidate.attempt,
    layer: 'deterministic',
    verdict,
    checks,
    reasons: reasons.slice(0, 30).map((reason) => reason.slice(0, 2_000)),
    evidenceRefs: [
      ...(input.candidate.patchRef !== undefined ? [input.candidate.patchRef] : []),
      ...input.candidate.localVerification.commands.map((command) => `verify:${command.name}:${command.status}`),
    ].slice(0, 30),
    affectedContractIds: [...affected].slice(0, 30),
    ...(verdict === 'CONFLICT' ? { decisionKind: 'architecture-contract-change' } : {}),
    createdAt: input.createdAt,
  });
}

/**
 * Does this candidate need a SEMANTIC evaluation on top? Deterministic
 * policy: investigations always carry judgment; build units when the
 * candidate itself declares assumptions or contract change requests (the
 * deterministic layer cannot judge those), or when policy says always.
 */
export function semanticEvaluationRequired(
  mode: SemanticEvaluationMode,
  workUnit: WorkUnit,
  candidate: CandidateArtifact,
  deterministic: EvaluationRecord,
): boolean {
  if (mode === 'disabled') return false;
  if (deterministic.verdict === 'CONFLICT') return false; // authority question already
  if (mode === 'always') return true;
  if (workUnit.kind === 'investigation') return true;
  return (
    candidate.claims.assumptionsDiscovered.length > 0 ||
    candidate.claims.contractChangeRequests.length > 0 ||
    candidate.claims.knownLimitations.length > 0
  );
}

export function nextEvaluationId(workUnitId: string, attempt: number, sequence: number): string {
  return `${workUnitId}-a${String(attempt).padStart(2, '0')}-e${String(sequence).padStart(2, '0')}`;
}

export type { ObjectivesPolicy };
