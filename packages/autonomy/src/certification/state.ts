import { z } from 'zod';
import {
  CERTIFICATION_VERDICTS,
  ZERO_TOUCH_EXPECTATIONS,
  ZERO_TOUCH_FAULTS,
  ZERO_TOUCH_OUTCOMES,
} from '../vocabulary.js';

/**
 * Zero-touch certification records.
 *
 * The certification answers a question unit tests cannot: *when this runtime
 * meets a real fault, does it handle it or does it wake somebody?* Passing
 * unit tests for the supervisor prove the supervisor's decision function is
 * correct; they prove nothing about whether a crashed driver at 03:00
 * actually results in a restarted driver at 03:00.
 *
 * `humanInterventions` is recorded per scenario and is the pass/fail
 * criterion for the fifteen operational faults. It is deliberately a COUNT
 * rather than a boolean: "essentially zero" is not a thing, and a report
 * that rounded one intervention down to none would make the primary product
 * metric decorative.
 */

export const CERTIFICATION_SCHEMA_VERSION = '1.0.0';

const shortText = z.string().max(200);
const text = z.string().max(4_000);

export const certificationScenarioResultSchema = z
  .object({
    scenarioId: shortText,
    fault: z.enum(ZERO_TOUCH_FAULTS),
    expectation: z.enum(ZERO_TOUCH_EXPECTATIONS),
    outcome: z.enum(ZERO_TOUCH_OUTCOMES),
    /** Human interventions observed. Anything above zero fails the scenario. */
    humanInterventions: z.number().int().min(0),
    /** Authority escalations. Expected exactly on the authority scenario. */
    authorityEscalations: z.number().int().min(0),
    /** What the runtime actually did, in one or two lines. */
    observed: text,
    /** The job status the scenario ended in. */
    finalStatus: shortText.optional(),
    /** Operational statuses the job passed through, in order. */
    recoveryPath: z.array(shortText).max(30).default([]),
    /** Present when the scenario could not run here. Never a pass. */
    skipReason: text.optional(),
    startedAt: shortText,
    finishedAt: shortText.optional(),
    durationMs: z.number().int().min(0).nullable().default(null),
  })
  .passthrough();
export type CertificationScenarioResult = z.infer<typeof certificationScenarioResultSchema>;

export const certificationRunSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    runId: shortText,
    createdAt: shortText,
    finishedAt: shortText.optional(),
    host: shortText,
    verdict: z.enum(CERTIFICATION_VERDICTS),
    results: z.array(certificationScenarioResultSchema).max(100).default([]),
    /** Totals, hoisted so the headline needs no arithmetic. */
    totals: z
      .object({
        total: z.number().int().min(0),
        selfRecovered: z.number().int().min(0),
        needsAuthority: z.number().int().min(0),
        askedHuman: z.number().int().min(0),
        stuck: z.number().int().min(0),
        selfAuthorized: z.number().int().min(0),
        skipped: z.number().int().min(0),
        notRun: z.number().int().min(0),
      })
      .passthrough(),
    /**
     * Total human interventions across every scenario. The headline number:
     * a certified run has zero, and any non-zero value is named here rather
     * than buried in a per-scenario field.
     */
    humanInterventionsAfterSeal: z.number().int().min(0),
    /** Why the verdict is what it is, in one or two lines. */
    rationale: text,
    /** Scenarios that failed, with what happened, for the report. */
    failures: z
      .array(z.object({ scenarioId: shortText, outcome: shortText, observed: text }).passthrough())
      .max(100)
      .default([]),
  })
  .passthrough();
export type CertificationRun = z.infer<typeof certificationRunSchema>;
