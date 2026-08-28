import { z } from 'zod';
import {
  CLOSURE_DIRECTIVES,
  CLOSURE_EVIDENCE_KINDS,
  CLOSURE_GAP_KINDS,
  CLOSURE_PHASES,
  CLOSURE_STATUSES,
} from '../vocabulary.js';

/**
 * The Contract Closure Ledger.
 *
 * This exists because of one specific failure. The previous long-horizon
 * dogfood declared a product COMPLETE while seven approved requirements had
 * no implementation at all. Nothing was lying: every task in the plan was
 * checked off, the build was green, the unit tests passed, and the agent
 * reported done. All four of those statements were true and the product was
 * not finished.
 *
 * The defect was that "the task list is complete" and "the contract is
 * satisfied" were the same fact in the runtime. Here they cannot be. The
 * ledger has one entry per SEALED contract item — every requirement, every
 * invariant, every acceptance criterion — and Mission COMPLETED is available
 * only when every entry closes on evidence. Task checkboxes are not evidence.
 * A green build is not evidence that a requirement nobody implemented is
 * satisfied. An agent saying "done" is not evidence of anything.
 *
 * The two-step status ladder is the mechanism:
 *
 *   IMPLEMENTED  something claims to implement this
 *   VERIFIED     trusted evidence demonstrates it holds
 *
 * Only the second closes. Collapsing them would reintroduce exactly the bug.
 */

export const CLOSURE_SCHEMA_VERSION = '1.0.0';

const shortText = z.string().max(200);
const text = z.string().max(4_000);

/**
 * One piece of evidence bearing on one contract item.
 *
 * `stale` is computed rather than stored as authority: evidence captured
 * against a repository state that has since changed has not been disproved,
 * but it also has not been re-demonstrated, and a long run that let old
 * green results close items would close them against code that no longer
 * exists.
 */
export const closureEvidenceRefSchema = z
  .object({
    kind: z.enum(CLOSURE_EVIDENCE_KINDS),
    /** Where the evidence lives: a run id, a result id, a report path. */
    ref: shortText,
    /** Did it pass? An evidence ref that failed is recorded, not hidden. */
    passed: z.boolean(),
    recordedAt: shortText,
    /** Git head the evidence was captured against, when one is known. */
    gitHead: shortText.optional(),
    /** One line describing what it demonstrated. */
    detail: text.optional(),
  })
  .passthrough();
export type ClosureEvidenceRef = z.infer<typeof closureEvidenceRefSchema>;

/**
 * One sealed contract item and everything known about closing it.
 *
 * `requiresSystemScenario` and `requiresBrowserScenario` are copied from the
 * seal at ledger-build time and are the rule that stops a UI criterion being
 * closed by a unit test. They can only make closure HARDER, and they are
 * frozen at seal time so no later agent can decide the browser check was
 * optional after all.
 */
export const closureEntrySchema = z
  .object({
    /** Stable id: `CTR-001/R1`, `CTR-001#INV-2`, or `AC-003`. */
    itemId: shortText,
    kind: z.enum(['requirement', 'invariant', 'acceptance-criterion']),
    statement: text,
    contractId: shortText.optional(),
    status: z.enum(CLOSURE_STATUSES),
    /** Job node ids that claim to implement this item. */
    attributedNodeIds: z.array(shortText).max(50).default([]),
    /** Task ids those nodes implement, for the human-readable report. */
    attributedTaskIds: z.array(shortText).max(50).default([]),
    evidence: z.array(closureEvidenceRefSchema).max(50).default([]),
    requiresSystemScenario: z.boolean().default(false),
    requiresBrowserScenario: z.boolean().default(false),
    /** Why the item is not closed. Empty exactly when it is. */
    gaps: z.array(z.enum(CLOSURE_GAP_KINDS)).max(10).default([]),
    /** A human waiver, when one exists. Only a person can create this. */
    waiver: z
      .object({ reason: text, waivedAt: shortText, waivedBy: shortText })
      .passthrough()
      .optional(),
    updatedAt: shortText,
  })
  .passthrough();
export type ClosureEntry = z.infer<typeof closureEntrySchema>;

export const closureLedgerSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    jobId: shortText,
    sealId: shortText,
    missionId: shortText,
    createdAt: shortText,
    updatedAt: shortText,
    phase: z.enum(CLOSURE_PHASES),
    entries: z.array(closureEntrySchema).max(1_000).default([]),
    /** Gap-closure cycles spent. Bounded by policy. */
    gapCycles: z.number().int().min(0).default(0),
    /**
     * System-scenario qualification cycles EXECUTED. Incremented only after
     * scenarios actually ran — never by entering the phase. The distinction
     * is the vNext.10.1 dogfood's defect 39: a counter bumped by a phase
     * stamp let the oracle read "the scenarios ran" off a night in which
     * nothing was ever executed.
     */
    systemCycles: z.number().int().min(0).default(0),
    /** True once the reproducibility qualification passed. */
    reproducibilityPassed: z.boolean().default(false),
    /** Reproducibility qualification attempts EXECUTED. Bounded by policy. */
    reproducibilityCycles: z.number().int().min(0).default(0),
    /** True once the release qualification passed against the integrated tree. */
    releaseQualificationPassed: z.boolean().default(false),
    /** Release qualification attempts EXECUTED. Bounded by policy. */
    releaseQualificationCycles: z.number().int().min(0).default(0),
  })
  .passthrough();
export type ClosureLedger = z.infer<typeof closureLedgerSchema>;

/**
 * One audit: the ledger's verdict at a moment, and what to do next.
 *
 * Persisted append-only. A completion claim has to be re-checkable months
 * later, and "the ledger said so at the time" is only meaningful if the
 * ledger's state at that time is on disk.
 */
export const closureAuditSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    auditId: shortText,
    jobId: shortText,
    sealId: shortText,
    createdAt: shortText,
    phase: z.enum(CLOSURE_PHASES),
    directive: z.enum(CLOSURE_DIRECTIVES),
    /** Counts by closure status, for the headline. */
    totals: z
      .object({
        total: z.number().int().min(0),
        verified: z.number().int().min(0),
        implemented: z.number().int().min(0),
        inProgress: z.number().int().min(0),
        notStarted: z.number().int().min(0),
        waived: z.number().int().min(0),
        notApplicable: z.number().int().min(0),
      })
      .passthrough(),
    /**
     * Closed items over total. `null` when there are no items at all — a
     * ratio of 1.0 over an empty ledger would read as "fully closed" for a
     * seal that promised nothing.
     */
    closureRatio: z.number().min(0).max(1).nullable().default(null),
    /** Item ids that are not closed, with the reason, bounded. */
    unclosed: z
      .array(
        z
          .object({
            itemId: shortText,
            status: z.enum(CLOSURE_STATUSES),
            gaps: z.array(z.enum(CLOSURE_GAP_KINDS)).max(10).default([]),
            statement: text,
          })
          .passthrough(),
      )
      .max(500)
      .default([]),
    /** One line explaining the directive, for the report. */
    rationale: text,
  })
  .passthrough();
export type ClosureAudit = z.infer<typeof closureAuditSchema>;

/**
 * One unit of work generated from an unclosed item.
 *
 * Gap work is expressed as a TASK PROPOSAL rather than as a plan: what must
 * be true, which item it closes, and what kind of evidence would close it.
 * How to do it is delegated engineering, decided by the runtime like any
 * other implementation decision.
 */
export const gapWorkItemSchema = z
  .object({
    gapId: shortText,
    itemId: shortText,
    gapKind: z.enum(CLOSURE_GAP_KINDS),
    /** What must become true. Derived from the sealed statement, never new. */
    objective: text,
    /** The evidence kind that would close it. */
    closingEvidence: z.enum(CLOSURE_EVIDENCE_KINDS),
    createdAt: shortText,
    /** The audit that generated it. */
    auditId: shortText,
  })
  .passthrough();
export type GapWorkItem = z.infer<typeof gapWorkItemSchema>;
