import { z } from 'zod';
import {
  CONTROL_PLANE_DEFECT_KINDS,
  CONTROL_PLANE_REPAIR_STAGES,
  CONTROL_PLANE_REPAIR_STATUSES,
  PROTECTED_CONTROL_PLANE_INVARIANTS,
} from '../vocabulary.js';

/**
 * Control-plane repair records.
 *
 * The last dogfood exposed a real SpecBridge defect in the Claude Code
 * integration, and the operator became the SpecBridge maintainer at
 * midnight. That is the failure this exists to remove — and it is also the
 * single most dangerous capability in vNext.10, because a runtime that can
 * patch itself can patch away the things stopping it.
 *
 * So the record below is built around one asymmetry: a repair is easy to
 * REJECT and hard to ACTIVATE. It must pass through every stage in order,
 * add a regression test, survive the full qualification, rebuild the actual
 * artifact, and re-run the exact failed operation as a canary. And before
 * any of that, its diff is screened against
 * `PROTECTED_CONTROL_PLANE_INVARIANTS`: a patch that touches a permission
 * bypass, the protected-path enforcement, verification authority, spend
 * authorization, the evidence requirement, the authority firewall, or the
 * completion oracle is REJECTED rather than reviewed.
 *
 * An agent fixing SpecBridge because its product task keeps failing has an
 * obvious shortcut available, and it is exactly that list.
 */

export const REPAIR_SCHEMA_VERSION = '1.0.0';

const shortText = z.string().max(200);
const text = z.string().max(4_000);

export const controlPlaneRepairSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    repairId: shortText,
    /** The product job that hit the defect and is suspended for this. */
    productJobId: shortText,
    defectKind: z.enum(CONTROL_PLANE_DEFECT_KINDS),
    /** What was observed, in one line. Never a stack trace with paths. */
    symptom: text,
    /** The operation to re-run as a canary once the repair is built. */
    canaryOperation: text,
    status: z.enum(CONTROL_PLANE_REPAIR_STATUSES),
    /** Stages completed, in order. The gate is that this is a prefix. */
    stagesCompleted: z.array(z.enum(CONTROL_PLANE_REPAIR_STAGES)).max(20).default([]),
    createdAt: shortText,
    updatedAt: shortText,
    finishedAt: shortText.optional(),
    /** Isolated working copy the patch was developed in. */
    isolationPath: shortText.optional(),
    /** Where the verified build was staged. Never the running installation. */
    artifactPath: shortText.optional(),
    /** Files the patch touched, workspace-relative to the SpecBridge source. */
    changedFiles: z.array(shortText).max(200).default([]),
    /** The regression test added, which is mandatory. */
    regressionTestPath: shortText.optional(),
    /** Invariants the screen found the patch touching. Non-empty means reject. */
    invariantViolations: z
      .array(
        z
          .object({
            invariant: z.enum(PROTECTED_CONTROL_PLANE_INVARIANTS),
            file: shortText,
            evidence: text,
          })
          .passthrough(),
      )
      .max(50)
      .default([]),
    /** Why the repair ended where it did. */
    outcomeDetail: text.optional(),
  })
  .passthrough();
export type ControlPlaneRepair = z.infer<typeof controlPlaneRepairSchema>;
