import { z } from 'zod';
import { DISCOVERY_TOPICS, IRREVERSIBLE_SURFACES } from '@specbridge/mission';
import {
  BUILD_LIFECYCLE_STEPS,
  BUILD_OUTCOMES,
  BUILD_STEP_STATUSES,
  CHUNK_COVERAGE_STATES,
  DELTA_AUTHORITY_CLASSES,
  DIVERGENCE_KINDS,
  ENGINEERING_QUESTION_SURFACES,
  INTAKE_STATUSES,
  PRODUCT_QUESTION_KINDS,
  QUESTION_REFUSAL_REASONS,
  REPOSITORY_EVIDENCE_KINDS,
  SOURCE_CHUNK_KINDS,
  SPEC_SOURCE_KINDS,
} from './vocabulary.js';

/**
 * Persisted spec-intake state (`.specbridge/intake/<intakeId>/`).
 *
 * Versioned from day one, additive with the same rules as every other
 * SpecBridge schema family: unknown fields survive via passthrough, and an
 * unknown MAJOR version is refused rather than coerced.
 *
 * Deliberately NOT in here, in any field, ever:
 *   - model reasoning, prompts, or transcripts of hidden deliberation
 *   - environment values or anything credential-shaped
 *
 * The SOURCE SPECIFICATION is the one exception to "no file contents", and
 * it is not really an exception: the submitted document is product evidence
 * the human wrote, and it is stored verbatim, once, under `source/`. Chunk
 * records point INTO it by byte range rather than copying it, so a long
 * specification is indexed rather than duplicated.
 */

export const INTAKE_STATE_SCHEMA_VERSION = '1.0.0';
export const INTAKE_SOURCE_SCHEMA_VERSION = '1.0.0';
export const INTAKE_GROUNDING_SCHEMA_VERSION = '1.0.0';
export const INTAKE_DELTA_SCHEMA_VERSION = '1.0.0';
export const INTAKE_APPROVAL_SCHEMA_VERSION = '1.0.0';
export const INTAKE_LIFECYCLE_SCHEMA_VERSION = '1.0.0';
export const PRODUCT_BASELINE_SCHEMA_VERSION = '1.0.0';

/** Bounds applied at the schema level, independent of any policy. */
export const INTAKE_LIMITS = {
  maxNameChars: 120,
  maxShortTextChars: 512,
  maxTextChars: 4_000,
  /** A submitted specification is bounded, generously. 4 MiB of Markdown. */
  maxSourceBytes: 4 * 1024 * 1024,
  /** Chunks are bounded so retrieval stays predictable on a long document. */
  maxChunks: 4_000,
  maxChunkChars: 8_000,
  maxItems: 400,
  maxQuestions: 60,
  maxRefusals: 400,
  maxEvidence: 600,
  maxRefsPerRecord: 40,
} as const;

const shortText = z.string().min(1).max(INTAKE_LIMITS.maxShortTextChars);
const text = z.string().min(1).max(INTAKE_LIMITS.maxTextChars);
const optionalText = z.string().max(INTAKE_LIMITS.maxTextChars);
const idList = z.array(shortText).max(INTAKE_LIMITS.maxRefsPerRecord);
const textList = z.array(text).max(INTAKE_LIMITS.maxItems);
const semver = z.string().regex(/^\d+\.\d+\.\d+$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

// ---------------------------------------------------------------------------
// The submitted specification
// ---------------------------------------------------------------------------

/**
 * One deterministically parsed chunk of the source document.
 *
 * `startOffset`/`endOffset` are byte offsets into the stored source, so the
 * original text is always recoverable exactly. `text` is carried too, and
 * bounded — a chunk longer than the bound is truncated in the record while
 * the offsets still point at the whole thing. Truth stays in the file;
 * the record is an index over it.
 */
export const sourceChunkSchema = z
  .object({
    /** Stable within the document ("C-0001", "C-0002", …). */
    chunkId: shortText,
    /** Heading path this chunk sits under, outermost first. */
    headingPath: z.array(shortText).max(8).default([]),
    kind: z.enum(SOURCE_CHUNK_KINDS),
    text: z.string().max(INTAKE_LIMITS.maxChunkChars),
    /** True when the record's `text` was truncated relative to the source. */
    truncated: z.boolean().default(false),
    startOffset: z.number().int().min(0),
    endOffset: z.number().int().min(0),
    contentHash: shortText,
  })
  .passthrough();
export type SourceChunk = z.infer<typeof sourceChunkSchema>;

/**
 * The ingested specification document.
 *
 * Provenance is deliberately structural: where it came from, when, how many
 * bytes, and the digest of exactly those bytes. A later audit can prove the
 * file under `source/` is the one that was submitted, and a re-submission of
 * different text produces a different digest and therefore a different
 * canonical truth.
 */
export const specSourceSchema = z
  .object({
    schemaVersion: semver,
    intakeId: shortText,
    kind: z.enum(SPEC_SOURCE_KINDS),
    /** Original path, for a file source. Recorded for audit, never re-read. */
    originPath: optionalText.optional(),
    receivedAt: shortText,
    /** Host label of the process that ingested it ("cli", "mcp", "plugin"). */
    receivedVia: shortText,
    byteLength: z.number().int().min(1),
    contentHash: sha256,
    /** Workspace-relative path of the stored verbatim copy. */
    storedAt: shortText,
    /** Section headings found, in document order. */
    outline: z.array(shortText).max(200).default([]),
    chunks: z.array(sourceChunkSchema).max(INTAKE_LIMITS.maxChunks).default([]),
  })
  .passthrough();
export type SpecSource = z.infer<typeof specSourceSchema>;

// ---------------------------------------------------------------------------
// Repository grounding
// ---------------------------------------------------------------------------

/**
 * One piece of durable evidence discovery found in the repository.
 *
 * `authoritative` separates "the product already promises this" from "the
 * repository happens to contain this". A sealed contract is authoritative; a
 * module directory is context. Only authoritative evidence can answer a
 * product question; context can only inform an engineering decision, which
 * is never asked about anyway.
 */
export const repositoryEvidenceSchema = z
  .object({
    evidenceId: shortText,
    kind: z.enum(REPOSITORY_EVIDENCE_KINDS),
    /** Stable identity: a contract id, spec name, module path, mission id. */
    ref: shortText,
    summary: text,
    /** True when this is existing PRODUCT AUTHORITY rather than context. */
    authoritative: z.boolean().default(false),
    /** Topics this evidence speaks to. */
    topics: z.array(z.enum(DISCOVERY_TOPICS)).max(INTAKE_LIMITS.maxRefsPerRecord).default([]),
    /** Workspace-relative path, when the evidence is a file or directory. */
    path: optionalText.optional(),
  })
  .passthrough();
export type RepositoryEvidence = z.infer<typeof repositoryEvidenceSchema>;

/**
 * What discovery learned about the repository before it asked anything.
 *
 * The report is written once per grounding pass and is the input to both the
 * delta analysis and the question evidence screen. It is a READ MODEL: it
 * changes nothing, and re-running it against an unchanged repository
 * produces an equal report.
 */
export const repositoryGroundingSchema = z
  .object({
    schemaVersion: semver,
    intakeId: shortText,
    groundedAt: shortText,
    /** Git head at grounding time, when the workspace is a repository. */
    baselineCommit: shortText.nullable().default(null),
    /** True when this workspace already carries SpecBridge product truth. */
    existingProduct: z.boolean().default(false),
    evidence: z.array(repositoryEvidenceSchema).max(INTAKE_LIMITS.maxEvidence).default([]),
    /** Prior missions whose contracts are active product authority. */
    priorMissionIds: idList.default([]),
    /** Existing spec names, for name-collision and reuse decisions. */
    existingSpecNames: z.array(shortText).max(INTAKE_LIMITS.maxItems).default([]),
    /** Detected build system, e.g. "pnpm", "gradle", "maven", or null. */
    buildSystem: shortText.nullable().default(null),
    /** Top-level module/subproject directories worth extending. */
    modules: z.array(shortText).max(INTAKE_LIMITS.maxItems).default([]),
    /** Deterministic notes about what was and was not observable. */
    notes: textList.default([]),
  })
  .passthrough();
export type RepositoryGrounding = z.infer<typeof repositoryGroundingSchema>;

// ---------------------------------------------------------------------------
// Delta authority analysis
// ---------------------------------------------------------------------------

/**
 * One classified requirement from the submitted specification.
 *
 * `classification` is computed by delta.ts from durable evidence, never
 * declared. `rationale` names the structural fact behind it — which contract
 * matched, which compatibility policy applied, which invariant it collided
 * with — so the classification is arguable with evidence rather than with
 * opinion.
 */
export const deltaItemSchema = z
  .object({
    /** Stable within the analysis ("D-001", …). */
    itemId: shortText,
    statement: text,
    /** Source chunks this item was extracted from. */
    sourceChunkIds: idList.default([]),
    classification: z.enum(DELTA_AUTHORITY_CLASSES),
    rationale: text,
    topics: z.array(z.enum(DISCOVERY_TOPICS)).max(INTAKE_LIMITS.maxRefsPerRecord).default([]),
    /** Surfaces this item would permanently affect, if any. */
    affectedSurfaces: z
      .array(z.enum(IRREVERSIBLE_SURFACES))
      .max(IRREVERSIBLE_SURFACES.length)
      .default([]),
    /** The existing contract this item relates to, when it relates to one. */
    existingContractId: shortText.optional(),
    existingContractRevision: z.number().int().min(1).optional(),
    /** The prior mission owning that contract. */
    existingMissionId: shortText.optional(),
    /** Requirement/invariant ids inside that contract this item touches. */
    existingElementIds: idList.default([]),
    /** True when this item is a public product promise (new or existing). */
    publicSurface: z.boolean().default(false),
    /** The question raised for this item, when one was raised. */
    questionId: shortText.optional(),
  })
  .passthrough();
export type DeltaItem = z.infer<typeof deltaItemSchema>;

export const deltaAuthorityAnalysisSchema = z
  .object({
    schemaVersion: semver,
    intakeId: shortText,
    analyzedAt: shortText,
    /** Digest over the grounding + source this analysis was computed from. */
    basisDigest: shortText,
    items: z.array(deltaItemSchema).max(INTAKE_LIMITS.maxItems).default([]),
    /** Counts per class, so a summary needs no re-scan. */
    counts: z.record(z.number().int().min(0)).default({}),
    /** Existing contracts this specification would MODIFY, by id. */
    modifiedContractIds: idList.default([]),
    /** Existing contracts this specification would EXTEND, by id. */
    extendedContractIds: idList.default([]),
    /** New public surfaces this specification itself authorizes. */
    newSurfaces: textList.default([]),
    complete: z.boolean().default(false),
    /** Why the analysis is not complete, when it is not. */
    reasons: textList.default([]),
  })
  .passthrough();
export type DeltaAuthorityAnalysis = z.infer<typeof deltaAuthorityAnalysisSchema>;

// ---------------------------------------------------------------------------
// Questions and refusals
// ---------------------------------------------------------------------------

/**
 * One admitted product question.
 *
 * Four fields carry the discipline required of every question, and the
 * generator cannot produce one without all four:
 *
 *   `kind`          — why this is product authority at all
 *   `productSurface`— what it would permanently affect
 *   `evidenceGap`   — why repository and specification evidence were not enough
 *   `resolves`      — what decision the answer settles
 *
 * A candidate that cannot fill them is refused, and the refusal is recorded.
 */
export const productQuestionSchema = z
  .object({
    questionId: shortText,
    kind: z.enum(PRODUCT_QUESTION_KINDS),
    question: text,
    whyItMatters: text,
    /** What a materially different answer would permanently change. */
    productSurface: z.enum(IRREVERSIBLE_SURFACES),
    /** Why repository/specification evidence was insufficient. */
    evidenceGap: text,
    /** What decision the answer resolves. */
    resolves: text,
    topics: z.array(z.enum(DISCOVERY_TOPICS)).max(INTAKE_LIMITS.maxRefsPerRecord).default([]),
    /** Candidate answers, when the choice is genuinely closed. */
    options: z.array(text).max(8).default([]),
    /** Source chunks that raised it. */
    sourceChunkIds: idList.default([]),
    /** The delta item this question blocks, when it blocks one. */
    deltaItemId: shortText.optional(),
    /** Every admitted question is blocking; recorded so it can be asserted. */
    blocking: z.literal(true).default(true),
    /** Mission question id, once the question is mirrored into the mission. */
    missionQuestionId: shortText.optional(),
    status: z.enum(['open', 'answered']).default('open'),
    answer: optionalText.optional(),
    answeredAt: shortText.optional(),
    /** Mission decision id recording the human answer. */
    decisionId: shortText.optional(),
    askedAt: shortText,
  })
  .passthrough();
export type ProductQuestion = z.infer<typeof productQuestionSchema>;

/** One candidate question discovery declined to ask, and why. */
export const questionRefusalSchema = z
  .object({
    refusalId: shortText,
    candidate: text,
    reason: z.enum(QUESTION_REFUSAL_REASONS),
    /** The engineering surface it asked about, for ENGINEERING_DECISION. */
    engineeringSurface: z.enum(ENGINEERING_QUESTION_SURFACES).optional(),
    /** The evidence that answered it, for ANSWERED_BY_* reasons. */
    answeredBy: shortText.optional(),
    detail: text,
    refusedAt: shortText,
  })
  .passthrough();
export type QuestionRefusal = z.infer<typeof questionRefusalSchema>;

// ---------------------------------------------------------------------------
// Coverage reconciliation
// ---------------------------------------------------------------------------

export const chunkCoverageSchema = z
  .object({
    chunkId: shortText,
    state: z.enum(CHUNK_COVERAGE_STATES),
    /** What carries it: a delta item id, question id, or evidence id. */
    carriedBy: idList.default([]),
  })
  .passthrough();
export type ChunkCoverage = z.infer<typeof chunkCoverageSchema>;

/**
 * The convergence verdict.
 *
 * Deterministic and recomputed, never accumulated. `ready` is true exactly
 * when every gate below holds, and the gates are listed so a "not ready"
 * answer is actionable rather than mysterious.
 */
export const intakeReadinessSchema = z
  .object({
    ready: z.boolean(),
    /** Normative source chunks with nothing accounting for them. */
    unaccountedChunkIds: idList.default([]),
    openQuestionIds: idList.default([]),
    /** Required discovery topics the mission has not resolved. */
    unresolvedRequiredTopics: z
      .array(z.enum(DISCOVERY_TOPICS))
      .max(DISCOVERY_TOPICS.length)
      .default([]),
    deltaAnalysisComplete: z.boolean().default(false),
    missionContractReady: z.boolean().default(false),
    reasons: textList.default([]),
  })
  .passthrough();
export type IntakeReadiness = z.infer<typeof intakeReadinessSchema>;

// ---------------------------------------------------------------------------
// The single human approval
// ---------------------------------------------------------------------------

/**
 * The one human authority event of this package.
 *
 * It binds the CANONICAL DISCOVERY RESULT — not a summary of it. Every field
 * is a reference or a digest, so the record can never restate a requirement
 * in words nobody approved, and `authorityDigest` is what a derived stage
 * approval later proves itself against.
 *
 * `approvedVia` is a CHANNEL label recorded for audit. It is never a claim
 * that anything other than a person performed the approval: no MCP tool and
 * no agent-reachable surface can write this record.
 */
export const intakeApprovalSchema = z
  .object({
    schemaVersion: semver,
    approvalId: shortText,
    intakeId: shortText,
    missionId: shortText,
    approvedAt: shortText,
    approvedVia: shortText,
    /** Digest of exactly the bytes the human submitted. */
    sourceContentHash: sha256,
    /** Digest over the approved canonical truth. The authority fingerprint. */
    authorityDigest: shortText,
    /** Digest of the delta analysis that was current at approval time. */
    deltaBasisDigest: shortText,

    // --- What was approved, by reference ---------------------------------
    goal: text,
    nonGoals: textList.default([]),
    /** Mission decision ids active at approval time. */
    decisionIds: z.array(shortText).max(INTAKE_LIMITS.maxItems).default([]),
    constitutionRuleIds: z.array(shortText).max(INTAKE_LIMITS.maxItems).default([]),
    adrIds: z.array(shortText).max(INTAKE_LIMITS.maxItems).default([]),
    /** Contracts this intake creates, by id. */
    newContractIds: z.array(shortText).max(INTAKE_LIMITS.maxItems).default([]),
    /** Existing contracts this intake extends, by id. */
    extendedContractIds: z.array(shortText).max(INTAKE_LIMITS.maxItems).default([]),
    /** Existing contracts this intake would change. Human-visible, always. */
    changedContractIds: z.array(shortText).max(INTAKE_LIMITS.maxItems).default([]),
    acceptanceCriteria: textList.default([]),
    /** Product questions and the human's recorded answers. */
    resolvedQuestions: z
      .array(
        z
          .object({
            questionId: shortText,
            question: text,
            answer: text,
            decisionId: shortText.optional(),
          })
          .passthrough(),
      )
      .max(INTAKE_LIMITS.maxQuestions)
      .default([]),
    /** Resource authorization carried into the seal. */
    maxApiSpendUsd: z.number().min(0).nullable().default(null),
    allowedLanes: z.array(z.enum(['LOCAL', 'SUBSCRIPTION', 'API'])).min(1).default(['LOCAL']),
    /** The seal this approval produced, once the lifecycle created it. */
    sealId: shortText.optional(),
  })
  .passthrough();
export type IntakeApproval = z.infer<typeof intakeApprovalSchema>;

// ---------------------------------------------------------------------------
// Derived approval
// ---------------------------------------------------------------------------

/** One semantic authority element found in a compiled artifact. */
export const projectionElementSchema = z
  .object({
    /** The stage the element was found in. */
    stage: shortText,
    /** Line number in the compiled document, 1-based. */
    line: z.number().int().min(1),
    statement: text,
    /** The approved element this traces to, when it traces to one. */
    tracesTo: shortText.optional(),
  })
  .passthrough();
export type ProjectionElement = z.infer<typeof projectionElementSchema>;

export const projectionDivergenceSchema = z
  .object({
    kind: z.enum(DIVERGENCE_KINDS),
    stage: shortText.optional(),
    detail: text,
    /** The offending statement, bounded. */
    statement: optionalText.optional(),
  })
  .passthrough();
export type ProjectionDivergence = z.infer<typeof projectionDivergenceSchema>;

/**
 * The equivalence verdict between the approved canonical truth and the
 * compiler's projection of it.
 *
 * `equivalent: false` FAILS the derived approval. It is never downgraded to
 * a warning: derived approval is only sound because the artifact contains
 * nothing the human did not approve, so an artifact that contains something
 * else must go back to a human.
 */
export const projectionEquivalenceSchema = z
  .object({
    schemaVersion: semver,
    intakeId: shortText,
    approvalId: shortText,
    specName: shortText,
    checkedAt: shortText,
    equivalent: z.boolean(),
    /** Normative statements checked, per stage. */
    checkedStatements: z.number().int().min(0).default(0),
    tracedStatements: z.number().int().min(0).default(0),
    divergences: z.array(projectionDivergenceSchema).max(INTAKE_LIMITS.maxItems).default([]),
    /** Digest of each compiled artifact, so the verdict names its subject. */
    artifactHashes: z.record(sha256).default({}),
  })
  .passthrough();
export type ProjectionEquivalence = z.infer<typeof projectionEquivalenceSchema>;

// ---------------------------------------------------------------------------
// The seal-and-build lifecycle ledger
// ---------------------------------------------------------------------------

export const buildStepRecordSchema = z
  .object({
    step: z.enum(BUILD_LIFECYCLE_STEPS),
    status: z.enum(BUILD_STEP_STATUSES),
    startedAt: shortText.optional(),
    settledAt: shortText.optional(),
    detail: optionalText.optional(),
    /** Identity of what this step produced (spec name, seal id, job id). */
    result: shortText.optional(),
    /** Attempts made on this step, so a loop is visible rather than silent. */
    attempts: z.number().int().min(0).default(0),
  })
  .passthrough();
export type BuildStepRecord = z.infer<typeof buildStepRecordSchema>;

/**
 * The durable ledger behind the one product operation.
 *
 * Written before each step runs and after each step settles. A process that
 * dies between the two leaves a RUNNING record, and re-entry reconciles it
 * against durable reality rather than trusting it — which is the difference
 * between a resumable lifecycle and a hopeful one.
 */
export const buildLifecycleSchema = z
  .object({
    schemaVersion: semver,
    intakeId: shortText,
    approvalId: shortText,
    missionId: shortText,
    startedAt: shortText,
    updatedAt: shortText,
    steps: z.array(buildStepRecordSchema).max(BUILD_LIFECYCLE_STEPS.length),
    specName: shortText.optional(),
    sealId: shortText.optional(),
    jobId: shortText.optional(),
    preflightReportId: shortText.optional(),
    outcome: z.enum(BUILD_OUTCOMES).optional(),
    /** Prerequisites the runtime resolved by itself, for the record. */
    resolvedPrerequisites: textList.default([]),
    /** Prerequisites that genuinely need a person. */
    humanPrerequisites: textList.default([]),
    finishedAt: shortText.optional(),
  })
  .passthrough();
export type BuildLifecycle = z.infer<typeof buildLifecycleSchema>;

// ---------------------------------------------------------------------------
// Intake state
// ---------------------------------------------------------------------------

export const intakeCountersSchema = z
  .object({
    sourceChunks: z.number().int().min(0).default(0),
    normativeChunks: z.number().int().min(0).default(0),
    evidence: z.number().int().min(0).default(0),
    deltaItems: z.number().int().min(0).default(0),
    questionsAsked: z.number().int().min(0).default(0),
    questionsAnswered: z.number().int().min(0).default(0),
    questionsRefused: z.number().int().min(0).default(0),
    /** Human turns spent in discovery. The pre-seal half of the boundary. */
    discoveryHumanTurns: z.number().int().min(0).default(0),
    /** Human authority approvals. Exactly one for a completed intake. */
    authorityApprovalCount: z.number().int().min(0).default(0),
    groundingPasses: z.number().int().min(0).default(0),
    events: z.number().int().min(0).default(0),
  })
  .passthrough();
export type IntakeCounters = z.infer<typeof intakeCountersSchema>;

export const intakeSequencesSchema = z
  .object({
    question: z.number().int().min(0).default(0),
    refusal: z.number().int().min(0).default(0),
    deltaItem: z.number().int().min(0).default(0),
    evidence: z.number().int().min(0).default(0),
  })
  .passthrough();
export type IntakeSequences = z.infer<typeof intakeSequencesSchema>;

export const specIntakeStateSchema = z
  .object({
    schemaVersion: semver,
    intakeId: shortText,
    /** The user-chosen name; also the default spec name. */
    name: z.string().min(1).max(INTAKE_LIMITS.maxNameChars),
    status: z.enum(INTAKE_STATUSES),
    /** The mission this intake drives. Created by the intake, never by hand. */
    missionId: shortText,
    createdAt: shortText,
    updatedAt: shortText,
    host: shortText,
    /** Digest of the submitted specification. Identity of the ask. */
    sourceContentHash: sha256,
    /** Repository head when the intake began. */
    baselineCommit: shortText.nullable().default(null),
    counters: intakeCountersSchema.default({}),
    sequences: intakeSequencesSchema.default({}),
    /** Set once the human approves. */
    approvalId: shortText.optional(),
    approvedAt: shortText.optional(),
    /** Set by the lifecycle. */
    specName: shortText.optional(),
    sealId: shortText.optional(),
    jobId: shortText.optional(),
    abandonedAt: shortText.optional(),
    abandonReason: optionalText.optional(),
  })
  .passthrough();
export type SpecIntakeState = z.infer<typeof specIntakeStateSchema>;

// ---------------------------------------------------------------------------
// Product baseline and feature lineage
// ---------------------------------------------------------------------------

/**
 * One feature intake's place in the product's history.
 *
 * A repository receives many feature specifications over time, and the
 * second one must be able to see what the first one promised. This record is
 * how: it names the baseline the feature started from, the seals that were
 * already in force, and the contracts the feature created, extended, or
 * changed. Grounding reads it, which is what makes discovery get smarter
 * rather than start over.
 */
export const featureLineageSchema = z
  .object({
    intakeId: shortText,
    missionId: shortText,
    name: shortText,
    recordedAt: shortText,
    baselineCommit: shortText.nullable().default(null),
    /** Seals that were already authorized when this feature began. */
    predecessorSealIds: z.array(shortText).max(INTAKE_LIMITS.maxItems).default([]),
    sealId: shortText.optional(),
    specName: shortText.optional(),
    jobId: shortText.optional(),
    newContractIds: z.array(shortText).max(INTAKE_LIMITS.maxItems).default([]),
    extendedContractIds: z.array(shortText).max(INTAKE_LIMITS.maxItems).default([]),
    changedContractIds: z.array(shortText).max(INTAKE_LIMITS.maxItems).default([]),
    /** Commits the implementation produced, filled in at closure. */
    implementationCommits: z.array(shortText).max(INTAKE_LIMITS.maxItems).default([]),
    /** Closure ledger reference, filled in when the job closes. */
    closureEvidenceRef: shortText.optional(),
    outcome: z.enum(BUILD_OUTCOMES).optional(),
  })
  .passthrough();
export type FeatureLineage = z.infer<typeof featureLineageSchema>;

export const productBaselineSchema = z
  .object({
    schemaVersion: semver,
    updatedAt: shortText,
    /** Features in the order they were intaken, oldest first. */
    features: z.array(featureLineageSchema).max(INTAKE_LIMITS.maxItems).default([]),
  })
  .passthrough();
export type ProductBaseline = z.infer<typeof productBaselineSchema>;

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/**
 * The intake half of the zero-touch metric.
 *
 * The boundary is precise and it is the point of the record: questions asked
 * during discovery are NOT failures of unattended operation, and interventions
 * after the approval are. Keeping the two in one record with four separate
 * numbers is what makes the claim checkable instead of rhetorical.
 */
export const intakeTelemetrySchema = z
  .object({
    schemaVersion: semver,
    intakeId: shortText,
    recordedAt: shortText,
    status: shortText,
    /** Human turns spent answering product questions before approval. */
    discoveryHumanTurns: z.number().int().min(0),
    /** Product questions asked. Legitimate; never a defect. */
    productQuestionsAsked: z.number().int().min(0),
    /** Candidate questions the screens refused. Evidence of discipline. */
    questionsRefused: z.number().int().min(0),
    /** Human authority approvals. Exactly 1 for an approved intake. */
    authorityApprovalCount: z.number().int().min(0),
    /** The vNext.10 metric, measured from the approval forward. */
    humanInterventionsAfterSeal: z.number().int().min(0).nullable(),
    /** Correct authority stops after the approval. Not interventions. */
    humanAuthorityEscalationsAfterSeal: z.number().int().min(0).nullable(),
    /** ISO instant the boundary starts at: the human approval. */
    boundaryStartedAt: shortText.nullable().default(null),
    jobId: shortText.optional(),
    sealId: shortText.optional(),
  })
  .passthrough();
export type IntakeTelemetry = z.infer<typeof intakeTelemetrySchema>;
