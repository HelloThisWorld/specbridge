import { z } from 'zod';

/**
 * Workspace Bootstrap state: the CurrentSystemSnapshot.
 *
 * Bootstrap answers ONE question — "what does this system currently appear
 * to be?" — before Product Discovery starts, so a Brownfield conversation
 * builds on the system that exists instead of re-inventing it. It never
 * answers "what should this product become": that is Discovery's question,
 * and the authority to answer it stays behind formal Spec Intake and the
 * human approval, exactly as before.
 *
 * Three artifacts, three lifetimes, and they are not interchangeable:
 *
 *   RepositoryContextIndex   disposable retrieval index. Derived, offline,
 *                            rebuildable; deleting it loses nothing.
 *   CurrentSystemSnapshot    THIS. Durable, evidence-backed understanding of
 *                            the current system. It explains what discovery
 *                            started from; it authorizes nothing.
 *   Product Contract         authoritative product truth. Only the mission
 *                            lifecycle creates or changes one.
 *
 * The snapshot therefore persists outside both the cache directory (it is
 * not disposable) and the mission stores (it is not authority), and every
 * material finding in it must carry evidence references — a finding nothing
 * supports is rejected by the schema, not merely frowned at.
 */

export const BOOTSTRAP_SCHEMA_VERSION = '1.0.0';

export const BOOTSTRAP_LIMITS = {
  maxRepositories: 12,
  maxFindingsPerCategory: 40,
  maxEvidencePerFinding: 8,
  maxUncertainties: 40,
  maxProductTruthRefs: 300,
  maxTextChars: 600,
  maxIdChars: 128,
  maxPathChars: 512,
} as const;

const shortText = z.string().min(1).max(BOOTSTRAP_LIMITS.maxTextChars);
const idText = z.string().min(1).max(BOOTSTRAP_LIMITS.maxIdChars);
const pathText = z.string().max(BOOTSTRAP_LIMITS.maxPathChars);

/**
 * How strongly a finding's source binds anybody.
 *
 * The order below is a strength order, and the boundary that matters is
 * between the first class and everything else:
 *
 *   SEALED_PRODUCT_TRUTH      existing approved SpecBridge product state —
 *                             active contracts, approved decisions,
 *                             constitution rules, mission ADRs, prior seals.
 *                             This IS existing product truth.
 *   DOCUMENTED_ARCHITECTURE   the repository's own documentation. Evidence
 *                             of intent, not automatically product authority.
 *   OBSERVED_IMPLEMENTATION   what the code, configuration, manifests, and
 *                             tests actually do today. "JobScheduler retries
 *                             three times" is an observation; it MUST NOT
 *                             silently become "jobs MUST retry exactly three
 *                             times". Only a human decision makes promises.
 *   INFERRED_PATTERN          an interpretation across several observations
 *                             ("appears to use controller → service →
 *                             repository layering"). Visibly inference,
 *                             always with the observations that support it.
 */
export const SYSTEM_EVIDENCE_CLASSES = [
  'SEALED_PRODUCT_TRUTH',
  'DOCUMENTED_ARCHITECTURE',
  'OBSERVED_IMPLEMENTATION',
  'INFERRED_PATTERN',
] as const;
export type SystemEvidenceClass = (typeof SYSTEM_EVIDENCE_CLASSES)[number];

/**
 * One traceable pointer from a finding to its source.
 *
 * File bodies are never stored here — the repository stays the source of
 * truth for implementation bytes, and the `contentHash` records which bytes
 * the finding described so staleness is detectable later.
 */
export const systemEvidenceRefSchema = z
  .object({
    /** Which repository the evidence lives in. */
    repositoryId: idText,
    /** Repository-relative path, forward slashes, when the source is a file. */
    path: pathText.optional(),
    /** The declared symbol the finding is about, when one names it. */
    symbol: shortText.optional(),
    /** 1-based line range, when known. */
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
    /** SHA-256 of the file bytes the finding described, when file-backed. */
    contentHash: shortText.optional(),
    /** Product-truth locators, when the source is SpecBridge state. */
    missionId: idText.optional(),
    contractId: idText.optional(),
    contractRevision: z.number().int().min(1).optional(),
    adrId: idText.optional(),
    decisionId: idText.optional(),
    ruleId: idText.optional(),
    sealId: idText.optional(),
  })
  .passthrough()
  .refine(
    (ref) =>
      ref.path !== undefined ||
      ref.contractId !== undefined ||
      ref.adrId !== undefined ||
      ref.decisionId !== undefined ||
      ref.ruleId !== undefined ||
      ref.sealId !== undefined,
    { message: 'an evidence ref must locate a file or a product-truth record' },
  );
export type SystemEvidenceRef = z.infer<typeof systemEvidenceRefSchema>;

/**
 * One thing the system currently appears to be or have.
 *
 * `evidence` is non-empty BY SCHEMA: a material finding with no provenance
 * is not admitted at all. That is the mechanism behind "a model-generated
 * unsupported finding must be rejected", and it applies equally to the
 * deterministic extractor — under-claiming beats inventing.
 */
export const systemFindingSchema = z
  .object({
    findingId: idText,
    class: z.enum(SYSTEM_EVIDENCE_CLASSES),
    statement: shortText,
    evidence: z
      .array(systemEvidenceRefSchema)
      .min(1)
      .max(BOOTSTRAP_LIMITS.maxEvidencePerFinding),
  })
  .passthrough();
export type SystemFinding = z.infer<typeof systemFindingSchema>;

/** An area bootstrap could not confidently determine. Reported, not hidden. */
export const systemUncertaintySchema = z
  .object({
    area: shortText,
    detail: shortText,
  })
  .passthrough();
export type SystemUncertainty = z.infer<typeof systemUncertaintySchema>;

/** A link to existing canonical product truth, with exact ownership. */
export const productTruthReferenceSchema = z
  .object({
    kind: z.enum(['contract', 'constitution-rule', 'adr', 'decision', 'seal']),
    missionId: idText,
    ref: idText,
    revision: z.number().int().min(1).optional(),
    title: shortText,
  })
  .passthrough();
export type ProductTruthReference = z.infer<typeof productTruthReferenceSchema>;

/**
 * One repository this snapshot describes, with the baseline it was read at.
 *
 * `relPath` is workspace-relative ('' when the workspace root itself is the
 * repository). Baselines are recorded PER repository so one repository
 * changing does not make evidence from another indistinguishable.
 */
export const repositorySnapshotIdentitySchema = z
  .object({
    repositoryId: idText,
    relPath: pathText,
    role: shortText.optional(),
    /** Git HEAD at snapshot time; null when not a git repository (or unborn). */
    gitHead: shortText.nullable().default(null),
    /** Indexed file count attributed to this repository. */
    indexedFiles: z.number().int().min(0).default(0),
  })
  .passthrough();
export type RepositorySnapshotIdentity = z.infer<typeof repositorySnapshotIdentitySchema>;

export const SNAPSHOT_MODES = ['BROWNFIELD', 'GREENFIELD', 'PARTIAL'] as const;
export type SnapshotMode = (typeof SNAPSHOT_MODES)[number];

const findings = z
  .array(systemFindingSchema)
  .max(BOOTSTRAP_LIMITS.maxFindingsPerCategory)
  .default([]);

export const currentSystemSnapshotSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    snapshotId: idText,
    /** Stable digest of the workspace root, same derivation as the index. */
    workspaceKey: idText,
    createdAt: shortText,
    repositories: z
      .array(repositorySnapshotIdentitySchema)
      .min(1)
      .max(BOOTSTRAP_LIMITS.maxRepositories),
    mode: z.enum(SNAPSHOT_MODES),
    architecture: findings,
    capabilities: findings,
    publicSurfaces: findings,
    domainObjects: findings,
    implementationPatterns: findings,
    constraints: findings,
    uncertainties: z
      .array(systemUncertaintySchema)
      .max(BOOTSTRAP_LIMITS.maxUncertainties)
      .default([]),
    existingProductTruth: z
      .array(productTruthReferenceSchema)
      .max(BOOTSTRAP_LIMITS.maxProductTruthRefs)
      .default([]),
    /** Bounded facts about the index this snapshot was synthesized from. */
    indexStats: z
      .object({
        entries: z.number().int().min(0),
        truncated: z.boolean(),
        skipped: z.number().int().min(0).default(0),
      })
      .passthrough(),
    /** Hash over the material content, for change detection and identity. */
    contentHash: idText,
  })
  .passthrough();
export type CurrentSystemSnapshot = z.infer<typeof currentSystemSnapshotSchema>;

/** Every finding in one snapshot, category-tagged, for iteration. */
export function allFindings(
  snapshot: CurrentSystemSnapshot,
): { category: string; finding: SystemFinding }[] {
  return [
    ...snapshot.architecture.map((finding) => ({ category: 'architecture', finding })),
    ...snapshot.capabilities.map((finding) => ({ category: 'capability', finding })),
    ...snapshot.publicSurfaces.map((finding) => ({ category: 'public-surface', finding })),
    ...snapshot.domainObjects.map((finding) => ({ category: 'domain-object', finding })),
    ...snapshot.implementationPatterns.map((finding) => ({
      category: 'implementation-pattern',
      finding,
    })),
    ...snapshot.constraints.map((finding) => ({ category: 'constraint', finding })),
  ];
}

// ---------------------------------------------------------------------------
// Repository manifest (optional, explicit multi-repo)
// ---------------------------------------------------------------------------

/**
 * The optional explicit multi-repo manifest, `.specbridge/repositories.json`.
 *
 * Absent for every single-repository workspace — no new configuration is
 * required to keep working. When present, every path is workspace-relative
 * and MUST resolve inside the workspace root: external sibling repositories
 * would require weakening `assertInsideWorkspace`, which guards every write
 * and read boundary in SpecBridge, so they are refused (fail closed) and the
 * limitation is documented rather than the invariant broadened.
 */
export const repositoryManifestSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/).default('1.0.0'),
    repositories: z
      .array(
        z
          .object({
            id: z
              .string()
              .min(1)
              .max(64)
              .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
            /** Workspace-relative directory. Must stay inside the workspace. */
            path: pathText,
            role: shortText.optional(),
          })
          .passthrough(),
      )
      .min(1)
      .max(BOOTSTRAP_LIMITS.maxRepositories),
  })
  .passthrough();
export type RepositoryManifest = z.infer<typeof repositoryManifestSchema>;
