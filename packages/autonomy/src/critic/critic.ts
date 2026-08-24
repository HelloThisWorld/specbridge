import type { WorkspaceInfo } from '@specbridge/core';
import { recordJobEvent } from '@specbridge/orchestration';
import type { AutonomyDeps } from '../deps.js';
import { autonomyPolicyOf, jobDepsOf, newRecordId, nowIso } from '../deps.js';
import {
  assertAutonomyId,
  autonomyPath,
  listJsonRecords,
  readJsonRecord,
  writeJsonRecord,
} from '../store.js';
import type { BrowserScenarioResult } from '../browser/state.js';
import type { UxCritique, UxFinding } from './state.js';
import { CRITIC_SCHEMA_VERSION, uxCritiqueSchema } from './state.js';
import type { UxFindingKind, UxFindingSeverity } from '../vocabulary.js';

/**
 * The UX critic.
 *
 * The interesting code here is the NORMALIZATION, not the judging. A critic
 * (a model, a heuristic pass, a person pasting notes) proposes findings; this
 * module decides what they are allowed to mean. Every rule below exists
 * because the alternative is an unbounded repair loop running while nobody
 * is awake:
 *
 *   Taste is demoted. An AESTHETIC_PREFERENCE finding becomes COSMETIC
 *   whatever severity was claimed, so "the spacing feels cramped" can never
 *   generate work.
 *
 *   Deterministic failure wins. `applyCritique` refuses to soften a FAILED
 *   browser result: the critic's verdict is recorded alongside it and
 *   changes nothing. There is no code path in which a critique makes
 *   something pass.
 *
 *   Cycles are counted. Once the critic has caused its budget of repair
 *   cycles for a scenario, further critiques are recorded as advisory. The
 *   run does not fail; the critic simply stops being able to spend anyone's
 *   night on it.
 */

export interface ProposedFinding {
  kind: UxFindingKind;
  severity: UxFindingSeverity;
  statement: string;
  locus?: string | undefined;
  evidenceRef?: string | undefined;
  viewport?: string | undefined;
}

export function critiqueFile(workspace: WorkspaceInfo, critiqueId: string): string {
  assertAutonomyId('critique', critiqueId);
  return autonomyPath(workspace, 'critic', `${critiqueId}.json`);
}

export function listCritiques(workspace: WorkspaceInfo): UxCritique[] {
  return listJsonRecords(autonomyPath(workspace, 'critic'), (raw) => uxCritiqueSchema.parse(raw));
}

export function readCritique(workspace: WorkspaceInfo, critiqueId: string): UxCritique | undefined {
  return readJsonRecord(critiqueFile(workspace, critiqueId), (raw) => uxCritiqueSchema.parse(raw));
}

/**
 * Findings the critic may never claim are material.
 *
 * One member today. It is a list rather than a special case because the
 * pressure to add "well, THIS aesthetic issue is really a usability issue"
 * is constant, and a list makes each addition a visible decision.
 */
const ALWAYS_COSMETIC: readonly UxFindingKind[] = ['AESTHETIC_PREFERENCE'];

export function normalizeSeverity(kind: UxFindingKind, claimed: UxFindingSeverity): UxFindingSeverity {
  return ALWAYS_COSMETIC.includes(kind) ? 'COSMETIC' : claimed;
}

export interface RecordCritiqueInput {
  result: BrowserScenarioResult;
  findings: readonly ProposedFinding[];
  producedBy: string;
  jobId?: string | undefined;
  critiqueId?: string | undefined;
  /** Critic-caused repair cycles already spent on this scenario. */
  repairCycle?: number | undefined;
  /** Present when the critic could not see enough to judge. */
  insufficientReason?: string | undefined;
}

/**
 * Record one critique.
 *
 * The verdict is COMPUTED from the normalized findings rather than taken
 * from the critic. A critic that returned "MATERIAL_FINDINGS" with three
 * cosmetic observations would otherwise be able to manufacture work by
 * asserting a conclusion its own evidence does not support.
 */
export function recordCritique(deps: AutonomyDeps, input: RecordCritiqueInput): UxCritique {
  const policy = autonomyPolicyOf(deps).critic;
  const bounded = input.findings.slice(0, policy.maxFindings);
  const findings: UxFinding[] = bounded.map((finding, index) => ({
    findingId: `F-${String(index + 1).padStart(3, '0')}`,
    kind: finding.kind,
    severity: normalizeSeverity(finding.kind, finding.severity),
    statement: finding.statement.slice(0, 4_000),
    ...(finding.locus !== undefined ? { locus: finding.locus.slice(0, 200) } : {}),
    ...(finding.evidenceRef !== undefined ? { evidenceRef: finding.evidenceRef.slice(0, 200) } : {}),
    ...(finding.viewport !== undefined ? { viewport: finding.viewport.slice(0, 200) } : {}),
  }));

  const repairCycle = input.repairCycle ?? 0;
  const budgetSpent = repairCycle >= policy.maxCriticRepairCycles;
  const material = findings.filter((finding) => finding.severity === 'MATERIAL');

  const verdict: UxCritique['verdict'] =
    policy.mode === 'DISABLED'
      ? 'NOT_RUN'
      : input.insufficientReason !== undefined
        ? 'INSUFFICIENT_EVIDENCE'
        : material.length > 0
          ? 'MATERIAL_FINDINGS'
          : 'NO_MATERIAL_FINDINGS';

  const critique = uxCritiqueSchema.parse({
    schemaVersion: CRITIC_SCHEMA_VERSION,
    critiqueId: input.critiqueId ?? newRecordId(deps, 'ux'),
    resultId: input.result.resultId,
    scenarioId: input.result.scenarioId,
    ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
    createdAt: nowIso(deps),
    verdict,
    findings,
    producedBy: input.producedBy.slice(0, 200),
    ...(input.insufficientReason !== undefined
      ? { insufficientReason: input.insufficientReason.slice(0, 4_000) }
      : {}),
    repairCycle,
    // ADVISORY mode, an exhausted budget, or a scenario that already failed
    // deterministically: in all three the critique is a note, not a task.
    advisoryOnly:
      policy.mode !== 'BLOCKING' || budgetSpent || input.result.status !== 'PASSED',
  });

  writeJsonRecord(critiqueFile(deps.workspace, critique.critiqueId), critique);
  if (input.jobId !== undefined) {
    try {
      recordJobEvent(jobDepsOf(deps), input.jobId, 'ux_critique_completed', {
        critiqueId: critique.critiqueId,
        resultId: critique.resultId,
        verdict: critique.verdict,
        material: material.length,
        advisoryOnly: critique.advisoryOnly,
      });
    } catch {
      // Certification fixtures critique results with no job.
    }
  }
  return critique;
}

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

export interface CritiqueEffect {
  /** True when this critique should generate bounded repair work. */
  requiresRepair: boolean;
  /** The material findings that justify it. Empty when it does not. */
  materialFindings: readonly UxFinding[];
  /** Why the critique had (or did not have) an effect. */
  reason: string;
}

/**
 * What a critique is allowed to cause.
 *
 * Written as a separate function from `recordCritique` so the ANSWER is
 * testable independently of the recording, and so there is exactly one place
 * that can say "yes, generate work from a subjective review".
 *
 * The first branch is the one that matters: a browser result that already
 * FAILED deterministically is repaired because of the deterministic failure.
 * Letting the critique also claim it would double-count the cause and, worse,
 * would create a code path in which critic state affects what a deterministic
 * failure means.
 */
export function critiqueEffect(critique: UxCritique, result: BrowserScenarioResult): CritiqueEffect {
  const material = critique.findings.filter((finding) => finding.severity === 'MATERIAL');
  if (result.status !== 'PASSED') {
    return {
      requiresRepair: false,
      materialFindings: [],
      reason:
        'the scenario already failed deterministically; repair is driven by that failure, not ' +
        'by the critique',
    };
  }
  if (critique.advisoryOnly) {
    return {
      requiresRepair: false,
      materialFindings: material,
      reason:
        critique.verdict === 'MATERIAL_FINDINGS'
          ? 'the critic is advisory or its repair budget is spent; findings are recorded, not acted on'
          : 'no material findings',
    };
  }
  if (material.length === 0) {
    return { requiresRepair: false, materialFindings: [], reason: 'no material findings' };
  }
  return {
    requiresRepair: true,
    materialFindings: material,
    reason: `${material.length} material UI finding(s) on a scenario whose assertions all passed`,
  };
}

/**
 * A critique can never turn a deterministic failure into a pass.
 *
 * Exported and asserted in the certification rather than left implicit. The
 * function is trivial; the guarantee is not, and the cheapest way to keep a
 * guarantee true is to give it a name something can call.
 */
export function criticCanOverrideDeterministicFailure(): false {
  return false;
}
