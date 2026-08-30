import { z } from 'zod';
import {
  REQUIRED_SEAL_AUTHORITY_KINDS,
  SEALED_AUTHORITY_KINDS,
  SEAL_STATUSES,
} from '../vocabulary.js';

/**
 * The durable MissionSeal (`.specbridge/autonomy/seals/<sealId>.json`).
 *
 * A seal is the answer to one question, recorded once so nobody has to ask
 * it again at 3am: *what did the human authorize, and how much of the
 * engineering did they hand over?*
 *
 * Three properties make it worth being a first-class record rather than a
 * flag on the mission:
 *
 *   It is a SNAPSHOT. Contract revisions, decision ids, and the policy
 *   fingerprint are captured as they were at seal time. A mission that keeps
 *   evolving does not retroactively change what an already-running job was
 *   allowed to do.
 *
 *   It is IMMUTABLE. There is no update operation. Re-sealing writes a new
 *   record that names its predecessor, so "which authorization was this
 *   built under" always has an answer.
 *
 *   It carries PROVENANCE, not prose. Every authority element references
 *   mission records by id. The seal never restates a requirement in its own
 *   words, because a restatement is a new requirement nobody approved.
 *
 * Deliberately NOT in here, in any field, ever: model reasoning, prompts,
 * transcripts, credential values, or file contents.
 */

export const SEAL_SCHEMA_VERSION = '1.0.0';

export const SEAL_LIMITS = {
  maxShortTextChars: 200,
  maxTextChars: 4_000,
  maxListItems: 200,
  maxContractRefs: 200,
  maxCriteria: 400,
  maxSurfaces: 40,
} as const;

const shortText = z.string().max(SEAL_LIMITS.maxShortTextChars);
const text = z.string().max(SEAL_LIMITS.maxTextChars);
const idList = z.array(shortText).max(SEAL_LIMITS.maxListItems);

/**
 * One sealed contract, pinned to the revision that was authorized.
 *
 * `revision` is what makes the closure oracle honest across a long run: if a
 * CCR later produces revision 3 of CTR-004, a job sealed against revision 2
 * is still closing against revision 2, and the difference is visible rather
 * than silently absorbed.
 */
export const sealedContractRefSchema = z
  .object({
    contractId: shortText,
    revision: z.number().int().min(1),
    title: shortText,
    classification: z.enum(['public', 'internal']),
    compatibilityPolicy: shortText,
    /** Requirement ids inside this contract revision, at seal time. */
    requirementIds: idList.default([]),
    /** Invariant ids inside this contract revision, at seal time. */
    invariantIds: idList.default([]),
  })
  .passthrough();
export type SealedContractRef = z.infer<typeof sealedContractRefSchema>;

/**
 * One sealed acceptance criterion: how the PRODUCT is judged done, as
 * opposed to how a task is judged done.
 *
 * `impliesSystemScenario` and `impliesBrowserScenario` are structural hints
 * the closure lifecycle reads to decide which qualification phases a mission
 * actually needs. They are set by the deterministic compiler from the
 * criterion's own text and topics — never by an agent deciding it would
 * rather not run a browser tonight.
 */
export const sealedAcceptanceCriterionSchema = z
  .object({
    criterionId: shortText,
    statement: text,
    /** Contract ids this criterion judges, when it judges specific ones. */
    contractIds: idList.default([]),
    /** Mission decision ids this criterion descends from. */
    decisionIds: idList.default([]),
    impliesSystemScenario: z.boolean().default(false),
    impliesBrowserScenario: z.boolean().default(false),
  })
  .passthrough();
export type SealedAcceptanceCriterion = z.infer<typeof sealedAcceptanceCriterionSchema>;

/**
 * The resource authorization a seal carries.
 *
 * `maxApiSpendUsd` is the ceiling the human authorized IN THIS SEAL. It does
 * not replace the vNext.5 spend policy, it intersects with it: the effective
 * ceiling is the smaller of the two, so a generous seal cannot loosen a
 * strict configuration and a generous configuration cannot loosen a strict
 * seal. `null` means the seal authorizes no API spend at all, which is not
 * the same as "unlimited" and never coerces to it.
 */
export const sealedResourcePolicySchema = z
  .object({
    maxApiSpendUsd: z.number().min(0).nullable().default(null),
    maxWallClockMs: z.number().int().min(60_000).nullable().default(null),
    /** Lanes the human authorized for this run. */
    allowedLanes: z.array(z.enum(['LOCAL', 'SUBSCRIPTION', 'API'])).min(1).default(['LOCAL']),
  })
  .passthrough();
export type SealedResourcePolicy = z.infer<typeof sealedResourcePolicySchema>;

/**
 * The delegated-authority snapshot: which engineering surfaces the human
 * handed over, and the fingerprint of the policy that says so.
 *
 * The fingerprint is the load-bearing field. Autonomy policy lives in
 * configuration, which is mutable; the seal records what that configuration
 * SAID at authorization time, so a job resuming a week later can detect that
 * someone widened the delegation in the meantime and refuse to quietly use
 * the wider version.
 */
export const delegatedAuthoritySnapshotSchema = z
  .object({
    mode: shortText,
    humanGate: shortText,
    policyFingerprint: z.string().max(8_000),
    /** Delegated engineering surfaces, as `surface: AUTO|HUMAN`. */
    decisions: z.record(shortText).default({}),
    /** Delegated recovery surfaces, same shape. */
    recovery: z.record(shortText).default({}),
    /** Toolsmith capability classes the human authorized. */
    toolsmithCapabilities: z.array(shortText).max(SEAL_LIMITS.maxSurfaces).default([]),
  })
  .passthrough();
export type DelegatedAuthoritySnapshot = z.infer<typeof delegatedAuthoritySnapshotSchema>;

export const missionSealSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    sealId: shortText,
    missionId: shortText,
    /** The Kiro spec the mission synthesized, when it has one. */
    specName: shortText.optional(),
    status: z.enum(SEAL_STATUSES),
    createdAt: shortText,
    /** Set exactly once, when a human authorizes the draft. */
    sealedAt: shortText.optional(),
    /**
     * How the human authorization arrived. A free-form CHANNEL label (the
     * CLI command, the MCP surface) recorded for audit — never a claim that
     * anything other than a person performed it.
     */
    sealedVia: shortText.optional(),
    /** Predecessor seal this one replaces. */
    supersedes: shortText.optional(),
    supersededBy: shortText.optional(),
    revokedAt: shortText.optional(),
    revokedReason: text.optional(),

    // --- The authority snapshot ------------------------------------------
    /** The mission goal, verbatim and bounded. Data, never instructions. */
    goal: text,
    nonGoals: z.array(text).max(SEAL_LIMITS.maxListItems).default([]),
    /** Mission decision ids active at seal time. */
    decisionIds: idList.default([]),
    /** Constitution rule ids active at seal time. */
    constitutionRuleIds: idList.default([]),
    /** ADR ids accepted at seal time. */
    adrIds: idList.default([]),
    contracts: z.array(sealedContractRefSchema).max(SEAL_LIMITS.maxContractRefs).default([]),
    acceptanceCriteria: z
      .array(sealedAcceptanceCriterionSchema)
      .max(SEAL_LIMITS.maxCriteria)
      .default([]),
    resourcePolicy: sealedResourcePolicySchema.default({}),
    delegatedAuthority: delegatedAuthoritySnapshotSchema,

    /** Authority kinds this seal actually carries, computed at draft time. */
    presentAuthorityKinds: z
      .array(z.enum(SEALED_AUTHORITY_KINDS))
      .max(SEALED_AUTHORITY_KINDS.length)
      .default([]),
    /**
     * Hash over the sealed authority content. Recorded so a later audit can
     * prove the record on disk is the one that was authorized, and so a
     * re-seal that changes nothing is recognisable as a no-op.
     */
    authorityDigest: shortText,
  })
  .passthrough();
export type MissionSeal = z.infer<typeof missionSealSchema>;

/**
 * The binding between one orchestration job and the seal it executes under.
 *
 * Stored separately from both the seal and the job: a seal may govern
 * several jobs over a long product, and the job state schema belongs to
 * @specbridge/orchestration and must not grow a dependency on this package.
 * The binding is the join, and it is written once when the job is created.
 */
export const sealBindingSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    jobId: shortText,
    sealId: shortText,
    missionId: shortText,
    boundAt: shortText,
    /** Autonomy policy fingerprint observed when the binding was made. */
    boundPolicyFingerprint: z.string().max(8_000),
    /**
     * Optional frozen SpecBridge runtime used by a production Mission. This
     * is identity only; it grants no authority and contains no local path.
     */
    runtimeIdentity: z.object({
      version: shortText,
      commit: z.string().regex(/^[a-f0-9]{7,64}$/),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      qualificationRunId: shortText,
    }).strict().nullable().default(null),
  })
  .passthrough();
export type SealBinding = z.infer<typeof sealBindingSchema>;
export type SealedRuntimeIdentity = NonNullable<SealBinding['runtimeIdentity']>;

/** Structural completeness of a draft seal, computed deterministically. */
export interface SealCompleteness {
  complete: boolean;
  present: readonly string[];
  missing: readonly string[];
  /** Human-readable, remediation-shaped explanations for each gap. */
  gaps: readonly string[];
}

export function requiredSealAuthorityKinds(): readonly string[] {
  return REQUIRED_SEAL_AUTHORITY_KINDS;
}
