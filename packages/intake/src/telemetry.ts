import { computeAutonomyTelemetry, readAutonomyTelemetry } from '@specbridge/autonomy';
import type { AutonomyTelemetry } from '@specbridge/autonomy';
import type { IntakeDeps } from './deps.js';
import { autonomyDepsOf, nowIso } from './deps.js';
import type { IntakeTelemetry } from './state.js';
import { intakeTelemetrySchema } from './state.js';
import { readApproval, readQuestions, readRefusals, requireIntakeState } from './store.js';

/**
 * Intake telemetry: where the zero-touch boundary actually starts.
 *
 * vNext.10 measured `humanInterventionsAfterSeal` and drove it to zero.
 * vNext.10.1 moves the thing being measured EARLIER — the seal is now
 * created by the machine, from an approval — so the boundary has to move
 * with it, and it has to move precisely.
 *
 * The four numbers, and why they are four and not one:
 *
 *   `discoveryHumanTurns` — answers the human gave before authorizing.
 *   These are NOT failures. A specification with a genuinely ambiguous
 *   compatibility promise SHOULD produce a question, and a system that
 *   counted it as an intervention would be optimising for silence.
 *
 *   `productQuestionsAsked` and `questionsRefused` — what discovery asked
 *   and what it declined to ask. The second is the honesty check on the
 *   first: a phase claiming it asks only product questions has to show the
 *   engineering questions it threw away.
 *
 *   `authorityApprovalCount` — human authority events. Exactly 1 for a
 *   completed intake. More than 1 means the design failed.
 *
 *   `humanInterventionsAfterSeal` — the vNext.10 metric, measured from the
 *   approval forward. After that instant an ordinary engineering question is
 *   a BUG, and this is the number that says whether one happened.
 *
 * `null` means unknown, never 0 — the same rule the autonomy telemetry
 * follows. An intake with no job has not achieved zero interventions; it has
 * not been measured.
 */

export const INTAKE_TELEMETRY_SCHEMA_VERSION = '1.0.0';

export function computeIntakeTelemetry(deps: IntakeDeps, intakeId: string): IntakeTelemetry {
  const intake = requireIntakeState(deps.workspace, intakeId);
  const approval = readApproval(deps.workspace, intakeId);
  const questions = readQuestions(deps.workspace, intakeId);
  const refusals = readRefusals(deps.workspace, intakeId);

  let autonomy: AutonomyTelemetry | undefined;
  if (intake.jobId !== undefined) {
    autonomy =
      readAutonomyTelemetry(deps.workspace, intake.jobId) ??
      safeCompute(deps, intake.jobId);
  }

  return intakeTelemetrySchema.parse({
    schemaVersion: INTAKE_TELEMETRY_SCHEMA_VERSION,
    intakeId,
    recordedAt: nowIso(deps),
    status: intake.status,
    discoveryHumanTurns: intake.counters.discoveryHumanTurns,
    productQuestionsAsked: questions.length,
    questionsRefused: refusals.length,
    authorityApprovalCount: approval !== undefined ? 1 : 0,
    humanInterventionsAfterSeal: autonomy?.humanInterventionsAfterSeal ?? null,
    humanAuthorityEscalationsAfterSeal:
      (autonomy as { humanAuthorityEscalationsAfterSeal?: number } | undefined)
        ?.humanAuthorityEscalationsAfterSeal ??
      autonomy?.humanAuthorityEscalations ??
      null,
    boundaryStartedAt: approval?.approvedAt ?? null,
    ...(intake.jobId !== undefined ? { jobId: intake.jobId } : {}),
    ...(intake.sealId !== undefined ? { sealId: intake.sealId } : {}),
  });
}

function safeCompute(deps: IntakeDeps, jobId: string): AutonomyTelemetry | undefined {
  try {
    return computeAutonomyTelemetry(autonomyDepsOf(deps), { jobId });
  } catch {
    // A job that was created but never driven has no event log to derive
    // from. Reporting `null` is the honest answer, and it is exactly the
    // distinction the whole file is built around.
    return undefined;
  }
}
