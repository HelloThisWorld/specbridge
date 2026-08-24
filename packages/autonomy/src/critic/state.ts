import { z } from 'zod';
import { UX_CRITIQUE_VERDICTS, UX_FINDING_KINDS, UX_FINDING_SEVERITIES } from '../vocabulary.js';

/**
 * UX critique records.
 *
 * The critic exists because deterministic evidence has a real blind spot: a
 * scenario can click every button, assert every selector, and pass while the
 * modal renders behind the header and the submit control is off-screen. A
 * human looking at the screenshot sees it in a second.
 *
 * It is also the single most dangerous thing in vNext.10, because
 * "the reviewer did not like it" is an infinitely renewable source of work
 * at 3am. So the critic is constrained in three ways that are structural
 * rather than advisory:
 *
 *   NEGATIVE AUTHORITY ONLY. There is no PASS verdict. The strongest thing
 *   the critic can say is NO_MATERIAL_FINDINGS, which asserts the absence of
 *   problems it looked for and nothing about whether the product works.
 *   Deterministic failure is never overridden, in any mode.
 *
 *   TASTE CANNOT CREATE WORK. A finding of kind AESTHETIC_PREFERENCE is
 *   forced to COSMETIC severity whatever the critic claimed, and only
 *   MATERIAL findings create repair work.
 *
 *   BOUNDED CYCLES. The number of repair cycles the critic alone may cause
 *   is a policy number, counted durably, and exhausting it does not fail the
 *   run — it stops the critic, records that it was stopped, and lets the
 *   deterministic evidence decide.
 */

export const CRITIC_SCHEMA_VERSION = '1.0.0';

const shortText = z.string().max(200);
const text = z.string().max(4_000);

export const uxFindingSchema = z
  .object({
    findingId: shortText,
    kind: z.enum(UX_FINDING_KINDS),
    severity: z.enum(UX_FINDING_SEVERITIES),
    /** What is wrong, in one or two sentences a repair task can act on. */
    statement: text,
    /** Where: a selector, a route, a viewport, or an evidence reference. */
    locus: shortText.optional(),
    /** The evidence the finding is drawn from, workspace-relative. */
    evidenceRef: shortText.optional(),
    /** The viewport this was observed at, when it is viewport-specific. */
    viewport: shortText.optional(),
  })
  .passthrough();
export type UxFinding = z.infer<typeof uxFindingSchema>;

export const uxCritiqueSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    critiqueId: shortText,
    /** The browser result this critique read. */
    resultId: shortText,
    scenarioId: shortText,
    jobId: shortText.optional(),
    createdAt: shortText,
    verdict: z.enum(UX_CRITIQUE_VERDICTS),
    findings: z.array(uxFindingSchema).max(200).default([]),
    /**
     * Which critic produced it. A label for audit, never authority: the
     * critique's power comes from the policy, not from who ran it.
     */
    producedBy: shortText,
    /** Present when the verdict is INSUFFICIENT_EVIDENCE. */
    insufficientReason: text.optional(),
    /** Critic-caused repair cycles already spent on this scenario. */
    repairCycle: z.number().int().min(0).default(0),
    /** True when the critique was recorded but may not create work. */
    advisoryOnly: z.boolean().default(false),
  })
  .passthrough();
export type UxCritique = z.infer<typeof uxCritiqueSchema>;
