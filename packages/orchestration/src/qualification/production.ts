import { sha256Hex } from '@specbridge/core';
import { z } from 'zod';

/**
 * vNext.10.2 production qualification is a release decision over the
 * evidence produced by the existing runtime. It deliberately owns no
 * scheduler, provider, verifier, or authority policy of its own.
 */
export const PRODUCTION_QUALIFICATION_SCHEMA_VERSION = '1.0.0';
export const PRODUCTION_QUALIFICATION_RELEASE = 'vNext.10.2';

export const PRODUCTION_GATE_RESULTS = ['PASS', 'FAIL', 'SKIPPED_NOT_ALLOWED'] as const;
export type ProductionGateResult = (typeof PRODUCTION_GATE_RESULTS)[number];

export const PRODUCTION_RELEASE_DECISIONS = ['READY', 'NOT_READY'] as const;
export type ProductionReleaseDecision = (typeof PRODUCTION_RELEASE_DECISIONS)[number];

export const PRODUCTION_EVIDENCE_KINDS = [
  'TEST_RUN',
  'REPORT',
  'FIXTURE',
  'LOG_ARTIFACT',
  'QUALIFICATION_JSON',
  'COMMIT',
] as const;
export type ProductionEvidenceKind = (typeof PRODUCTION_EVIDENCE_KINDS)[number];

export interface ProductionGateDefinition {
  letter: string;
  id: string;
  title: string;
  required: true;
  evidenceExpectation: string;
}

/** The formal A-T matrix. Removing or weakening an entry is a contract change. */
export const PRODUCTION_QUALIFICATION_GATES: readonly ProductionGateDefinition[] = Object.freeze([
  { letter: 'A', id: 'full-repository-suite', title: 'Full repository suite', required: true, evidenceExpectation: 'Frozen install, lint, typecheck, build, full test, smoke, and security command logs.' },
  { letter: 'B', id: 'public-contract-integrity', title: 'Public contract and generated artifact integrity', required: true, evidenceExpectation: 'Public-contract, registry, MCP documentation, and reproducible bundle checks.' },
  { letter: 'C', id: 'greenfield-zero-touch', title: 'Greenfield zero-touch qualification', required: true, evidenceExpectation: 'A sealed empty-project Mission reaches authoritative completion without intervention.' },
  { letter: 'D', id: 'brownfield-zero-touch', title: 'Brownfield zero-touch qualification', required: true, evidenceExpectation: 'A sealed existing-project Mission preserves existing behavior and reaches closure.' },
  { letter: 'E', id: 'workspace-bootstrap', title: 'Workspace Bootstrap qualification', required: true, evidenceExpectation: 'Bootstrap creates only governed workspace state and preserves project authority.' },
  { letter: 'F', id: 'research-lifecycle', title: 'Research lifecycle qualification', required: true, evidenceExpectation: 'Avoidance, reuse, QUICK/DEEP provider behavior, provenance, and lifecycle fallback evidence.' },
  { letter: 'G', id: 'deerflow-failure-fallback', title: 'DeerFlow failure and fallback qualification', required: true, evidenceExpectation: 'Auth, quota, timeout, malformed output, and absence degrade without product authority.' },
  { letter: 'H', id: 'secondary-builder', title: 'Secondary Builder qualification', required: true, evidenceExpectation: 'Eligibility, packet authority, isolated edits, verification, and routing evidence.' },
  { letter: 'I', id: 'real-local-model', title: 'Real local-model qualification', required: true, evidenceExpectation: 'A real configured local model is identified and completes an eligible unit safely.' },
  { letter: 'J', id: 'secondary-repair', title: 'Secondary failure and repair qualification', required: true, evidenceExpectation: 'Bounded repair, no-progress detection, and durable attempt-chain evidence.' },
  { letter: 'K', id: 'strong-fallback', title: 'Strong fallback qualification', required: true, evidenceExpectation: 'Strong receives original work, current source, Secondary diff/failure, history, and research references.' },
  { letter: 'L', id: 'subscription-cooldown', title: 'Strong subscription cooldown qualification', required: true, evidenceExpectation: 'Fake-time cooldown continuation, useful independent work, wait, restart, and resume evidence.' },
  { letter: 'M', id: 'restart-resume', title: 'Restart and resume qualification', required: true, evidenceExpectation: 'Durable restart-boundary replay without lost candidates or completed-work redo.' },
  { letter: 'N', id: 'historical-fault-replay', title: 'Historical StepRelay fault replay', required: true, evidenceExpectation: 'Every versioned historical fault catalog entry passes its deterministic regression.' },
  { letter: 'O', id: 'unattended-soak', title: 'Long unattended soak', required: true, evidenceExpectation: 'Bounded 1-3 hour or accelerated long-horizon workload with injected faults and zero runtime mutation.' },
  { letter: 'P', id: 'security-authority', title: 'Security and authority qualification', required: true, evidenceExpectation: 'Traversal, symlink, protected writes, credentials, endpoint, provider claim, approval, and MCP cases fail closed.' },
  { letter: 'Q', id: 'frontend-integration', title: 'Frontend integration qualification', required: true, evidenceExpectation: 'Codex and Claude bundles, launchers, schemas, and supported Windows paths validate.' },
  { letter: 'R', id: 'closure-completion', title: 'Final closure and completion qualification', required: true, evidenceExpectation: 'Trusted evidence closes every sealed item before authoritative COMPLETED.' },
  { letter: 'S', id: 'telemetry-report', title: 'Telemetry and report qualification', required: true, evidenceExpectation: 'Durable telemetry agrees with gate facts and zero-tolerance counters.' },
  { letter: 'T', id: 'release-reproducibility', title: 'Release reproducibility qualification', required: true, evidenceExpectation: 'The same clean candidate rebuilds without source, contract, or bundle drift.' },
]);

export const PRODUCTION_GATE_IDS = PRODUCTION_QUALIFICATION_GATES.map((gate) => gate.id);
export type ProductionGateId = (typeof PRODUCTION_GATE_IDS)[number];

export interface HistoricalFaultDefinition {
  id: string;
  description: string;
  historicalSymptom: string;
  regressionTargets: readonly string[];
  expectedOutcome: string;
}

/**
 * The named StepRelay fault ledger. Several entries intentionally cite an
 * existing broader regression file: Phase 10 groups proven tests instead of
 * copying their fixtures into a second implementation.
 */
export const HISTORICAL_FAULT_CATALOG: readonly HistoricalFaultDefinition[] = Object.freeze([
  { id: 'FAULT-001', description: 'Supervisor backoff keeps the process alive', historicalSymptom: 'The supervisor silently exited while waiting for its next retry.', regressionTargets: ['tests/autonomy/supervisor.test.ts'], expectedOutcome: 'The process remains live through backoff and resumes the same durable job.' },
  { id: 'FAULT-002', description: 'CANDIDATE_READY restart recovery', historicalSymptom: 'A persisted candidate was ignored or rebuilt after process restart.', regressionTargets: ['tests/orchestration/subscription-cooldown.test.ts'], expectedOutcome: 'The persisted candidate resumes at evaluation/integration without rebuilding.' },
  { id: 'FAULT-003', description: 'Human answer routing', historicalSymptom: 'A human answer failed to reach the blocked work that requested it.', regressionTargets: ['tests/orchestration/steprelay-mission-e2e.test.ts'], expectedOutcome: 'The answer resolves the original question and the same job continues.' },
  { id: 'FAULT-004', description: 'Dependency patch conflict reconciliation', historicalSymptom: 'Conflicting dependency patches killed a builder or corrupted integration.', regressionTargets: ['tests/orchestration/objectives-resume-parallel.test.ts'], expectedOutcome: 'One bounded reconciliation preserves both dependency intents or fails honestly.' },
  { id: 'FAULT-005', description: 'Stale dependency patch handling', historicalSymptom: 'A stale patch was applied to a newer dependency state.', regressionTargets: ['tests/orchestration/objectives-resume-parallel.test.ts'], expectedOutcome: 'Freshness is checked and the stale attempt is rebuilt without source corruption.' },
  { id: 'FAULT-006', description: 'Sibling invalidation containment', historicalSymptom: 'Progress by one sibling invalidated unrelated in-flight work.', regressionTargets: ['tests/orchestration/objectives-resume-parallel.test.ts'], expectedOutcome: 'Only materially dependent stale work is invalidated.' },
  { id: 'FAULT-007', description: 'Bounded evidence state remains writable', historicalSymptom: 'Evidence caps made the durable state impossible to write.', regressionTargets: ['tests/drift/evidence-and-state.test.ts'], expectedOutcome: 'Evidence is bounded deterministically and state remains writable.' },
  { id: 'FAULT-008', description: 'Git index residue recovery', historicalSymptom: 'A dead integration left conflict residue in the canonical Git index.', regressionTargets: ['tests/orchestration/objectives-aggregation-e2e.test.ts'], expectedOutcome: 'Residue is detected and cleared before a safe retry.' },
  { id: 'FAULT-009', description: 'Completion cannot bypass closure', historicalSymptom: 'A job reported completion while sealed items remained open.', regressionTargets: ['tests/autonomy/completion-gate.test.ts'], expectedOutcome: 'Authoritative completion refuses every unclosed sealed item.' },
  { id: 'FAULT-010', description: 'Closure handoff survives failure', historicalSymptom: 'A crash between implementation and closure lost the handoff.', regressionTargets: ['tests/autonomy/closure-lifecycle.test.ts'], expectedOutcome: 'The durable closure phase resumes without repeating completed implementation.' },
  { id: 'FAULT-011', description: 'Earned evidence reaches the closure ledger', historicalSymptom: 'Verified work existed but its evidence never reached closure.', regressionTargets: ['tests/autonomy/closure-oracle.test.ts'], expectedOutcome: 'Trusted earned evidence is attributed to and closes the correct ledger item.' },
  { id: 'FAULT-012', description: 'Scenario-owned closure work does not deadlock', historicalSymptom: 'Scenario-owned closure items waited on the scenario that they themselves blocked.', regressionTargets: ['tests/autonomy/closure-oracle.test.ts'], expectedOutcome: 'Scenario evidence follows the bounded qualification/repair sequence.' },
  { id: 'FAULT-013', description: 'Acceptance evidence attribution', historicalSymptom: 'Evidence for one criterion incorrectly closed another criterion.', regressionTargets: ['tests/autonomy/mission-qualification.test.ts'], expectedOutcome: 'Evidence closes only the exact sealed requirement or criterion it proves.' },
  { id: 'FAULT-014', description: 'Authentication and quota classification', historicalSymptom: 'Authentication failure was treated as quota, or quota as implementation failure.', regressionTargets: ['tests/research/deerflow.test.ts', 'tests/orchestration/quota-driver.test.ts'], expectedOutcome: 'Auth, quota, provider, and implementation failures retain distinct recovery semantics.' },
]);

export const HISTORICAL_FAULT_IDS = HISTORICAL_FAULT_CATALOG.map((fault) => fault.id);

const shortText = z.string().min(1).max(500);
const boundedText = z.string().min(1).max(4_000);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const semver = z.string().regex(/^\d+\.\d+\.\d+$/);
const count = z.number().int().min(0);
const ratio = z.number().min(0).max(1).nullable();
const credentialShape = /(?:\b(?:bearer|basic)\s+[A-Za-z0-9+/=_-]{12,}|\b(?:api[-_ ]?key|auth[-_ ]?token|access[-_ ]?token|password|secret)\s*[:=]\s*\S{8,}|:\/\/[^/\s]+@)/i;
const safeShortText = shortText.refine((value) => !credentialShape.test(value), 'must not contain credential-shaped text');
const safeBoundedText = boundedText.refine((value) => !credentialShape.test(value), 'must not contain credential-shaped text');

export const productionRuntimeEntrySchema = z.object({
  path: z.string().min(1).max(1_000),
  content: z.union([z.string(), z.instanceof(Buffer)]),
}).strict();
export type ProductionRuntimeEntry = z.infer<typeof productionRuntimeEntrySchema>;

export const productionBundleIdentitySchema = z.object({
  name: shortText,
  version: shortText,
  digest: sha256,
}).strict();

export const productionCandidateIdentitySchema = z.object({
  release: z.literal(PRODUCTION_QUALIFICATION_RELEASE),
  version: semver,
  commit: z.string().regex(/^[a-f0-9]{7,64}$/),
  runtimeDigest: sha256,
  runtimeFileCount: count,
  schemaVersions: z.record(semver),
  bundles: z.array(productionBundleIdentitySchema).max(50),
  sourceTreeClean: z.boolean(),
  frozenAt: shortText,
}).strict();
export type ProductionCandidateIdentity = z.infer<typeof productionCandidateIdentitySchema>;

export const productionEvidenceRefSchema = z.object({
  kind: z.enum(PRODUCTION_EVIDENCE_KINDS),
  ref: z.string().min(1).max(1_000).refine((value) => !credentialShape.test(value), 'must not contain credential-shaped text'),
  digest: sha256,
  observedAt: shortText,
  candidateCommit: z.string().regex(/^[a-f0-9]{7,64}$/),
  runtimeDigest: sha256,
  producer: safeShortText,
}).strict();
export type ProductionEvidenceRef = z.infer<typeof productionEvidenceRefSchema>;

export const productionGateObservationSchema = z.object({
  id: z.string().min(1).max(100),
  result: z.enum(PRODUCTION_GATE_RESULTS),
  summary: safeBoundedText,
  evidence: z.array(productionEvidenceRefSchema).max(100).default([]),
  diagnostics: z.array(safeBoundedText).max(100).default([]),
}).strict();
export type ProductionGateObservation = z.infer<typeof productionGateObservationSchema>;

export const historicalFaultObservationSchema = z.object({
  id: z.string().regex(/^FAULT-\d{3}$/),
  result: z.enum(PRODUCTION_GATE_RESULTS),
  evidence: z.array(productionEvidenceRefSchema).max(50).default([]),
  diagnostics: z.array(safeBoundedText).max(50).default([]),
}).strict();
export type HistoricalFaultObservation = z.infer<typeof historicalFaultObservationSchema>;

export const productionEnvironmentSchema = z.object({
  os: shortText,
  nodeVersion: shortText,
  pnpmVersion: shortText,
  gitVersion: shortText,
  localModel: z.object({
    provider: shortText,
    model: shortText,
    modelHash: sha256.nullable(),
    context: shortText,
    inferenceProfile: shortText,
  }).strict().nullable(),
  deerFlow: z.object({
    provider: shortText,
    apiVersion: shortText.nullable(),
    endpointIdentity: safeShortText,
  }).strict().nullable(),
  frontends: z.array(z.object({ name: shortText, version: shortText, digest: sha256 }).strict()).max(50),
}).strict();
export type ProductionEnvironment = z.infer<typeof productionEnvironmentSchema>;

export const productionQualificationMetricsSchema = z.object({
  humanInterventionsAfterSeal: count.nullable(),
  unexpectedBlocks: count.nullable(),
  unrecoveredDriverDeaths: count.nullable(),
  completedWorkRedoCount: count.nullable(),
  lostCandidates: count.nullable(),
  duplicateDispatches: count.nullable(),
  runtimeMutation: count.nullable(),
  zeroTouchAfterSeal: z.boolean().nullable(),
  finalJobStatus: shortText.nullable(),
  controlPlaneSelfRepairEnabled: z.boolean().nullable(),
  runtimeStartDigest: sha256.nullable(),
  runtimeEndDigest: sha256.nullable(),
  usefulWorkDuringSubscriptionCooldown: count.nullable(),
  strongBuilderAvoidanceRatio: ratio,
  researchAvoidanceRatio: ratio,
  soakDurationMs: count.nullable(),
}).strict();
export type ProductionQualificationMetrics = z.infer<typeof productionQualificationMetricsSchema>;

export const productionQualificationEvidenceFileSchema = z.object({
  gates: z.array(productionGateObservationSchema).max(PRODUCTION_QUALIFICATION_GATES.length * 2).default([]),
  historicalFaults: z.array(historicalFaultObservationSchema).max(HISTORICAL_FAULT_CATALOG.length * 2).default([]),
  metrics: productionQualificationMetricsSchema.partial().default({}),
  localModel: productionEnvironmentSchema.shape.localModel.optional(),
  deerFlow: productionEnvironmentSchema.shape.deerFlow.optional(),
  frontends: productionEnvironmentSchema.shape.frontends.optional(),
  knownLimitations: z.array(safeBoundedText).max(100).default([]),
}).strict();
export type ProductionQualificationEvidenceFile = z.infer<typeof productionQualificationEvidenceFileSchema>;

/** Unknown is represented by null; it is never silently coerced to zero. */
export function emptyProductionQualificationMetrics(): ProductionQualificationMetrics {
  return productionQualificationMetricsSchema.parse({
    humanInterventionsAfterSeal: null,
    unexpectedBlocks: null,
    unrecoveredDriverDeaths: null,
    completedWorkRedoCount: null,
    lostCandidates: null,
    duplicateDispatches: null,
    runtimeMutation: null,
    zeroTouchAfterSeal: null,
    finalJobStatus: null,
    controlPlaneSelfRepairEnabled: null,
    runtimeStartDigest: null,
    runtimeEndDigest: null,
    usefulWorkDuringSubscriptionCooldown: null,
    strongBuilderAvoidanceRatio: null,
    researchAvoidanceRatio: null,
    soakDurationMs: null,
  });
}

const materializedGateSchema = productionGateObservationSchema.extend({
  letter: shortText,
  title: shortText,
  required: z.literal(true),
  evidenceExpectation: boundedText,
}).strict();

const materializedFaultSchema = historicalFaultObservationSchema.extend({
  description: shortText,
  historicalSymptom: boundedText,
  regressionTargets: z.array(shortText).min(1),
  expectedOutcome: boundedText,
}).strict();

export const productionReadyMarkerSchema = z.object({
  status: z.literal('PRODUCTION_READY'),
  release: z.literal(PRODUCTION_QUALIFICATION_RELEASE),
  version: semver,
  commit: z.string().regex(/^[a-f0-9]{7,64}$/),
  runtimeDigest: sha256,
  qualificationRunId: shortText,
  manifest: shortText,
  report: shortText,
}).strict();
export type ProductionReadyMarker = z.infer<typeof productionReadyMarkerSchema>;

export const productionQualificationManifestSchema = z.object({
  schemaVersion: z.literal(PRODUCTION_QUALIFICATION_SCHEMA_VERSION),
  release: z.literal(PRODUCTION_QUALIFICATION_RELEASE),
  qualificationRunId: shortText,
  candidate: productionCandidateIdentitySchema,
  environment: productionEnvironmentSchema,
  gates: z.array(materializedGateSchema).length(PRODUCTION_QUALIFICATION_GATES.length),
  historicalFaults: z.array(materializedFaultSchema).length(HISTORICAL_FAULT_CATALOG.length),
  metrics: productionQualificationMetricsSchema,
  knownLimitations: z.array(safeBoundedText).max(100),
  decision: z.object({
    status: z.enum(PRODUCTION_RELEASE_DECISIONS),
    failedRequiredGateIds: z.array(shortText),
    blockers: z.array(boundedText),
  }).strict(),
  marker: productionReadyMarkerSchema.nullable(),
  generatedAt: shortText,
}).strict();
export type ProductionQualificationManifest = z.infer<typeof productionQualificationManifestSchema>;

export const PRODUCTION_QUALIFICATION_ARTIFACTS = Object.freeze({
  candidate: 'production-candidate.json',
  manifest: 'production-qualification-manifest.json',
  report: 'production-qualification-report.md',
  decision: 'production-release-decision.json',
  marker: 'PRODUCTION_READY.json',
  faultCoverage: 'historical-fault-coverage.json',
});

function normalizeRuntimePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`Runtime identity accepts only contained repository-relative paths: ${value}`);
  }
  return normalized;
}

/** Stable digest over both runtime file names and exact bytes. */
export function computeProductionRuntimeDigest(
  entries: readonly ProductionRuntimeEntry[],
): { digest: string; fileCount: number } {
  if (entries.length === 0) throw new Error('Runtime identity requires at least one production file.');
  const normalized = entries.map((entry) => {
    const parsed = productionRuntimeEntrySchema.parse(entry);
    return {
      path: normalizeRuntimePath(parsed.path),
      digest: sha256Hex(parsed.content),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]?.path === normalized[index]?.path) {
      throw new Error(`Duplicate runtime identity path: ${normalized[index]?.path ?? ''}`);
    }
  }
  return {
    digest: sha256Hex(JSON.stringify(normalized)),
    fileCount: normalized.length,
  };
}

export interface CreateProductionCandidateInput {
  version: string;
  commit: string;
  runtimeEntries: readonly ProductionRuntimeEntry[];
  schemaVersions: Readonly<Record<string, string>>;
  bundles: readonly z.infer<typeof productionBundleIdentitySchema>[];
  sourceTreeClean: boolean;
  frozenAt: string;
}

export function createProductionCandidate(
  input: CreateProductionCandidateInput,
): ProductionCandidateIdentity {
  const runtime = computeProductionRuntimeDigest(input.runtimeEntries);
  return productionCandidateIdentitySchema.parse({
    release: PRODUCTION_QUALIFICATION_RELEASE,
    version: input.version,
    commit: input.commit,
    runtimeDigest: runtime.digest,
    runtimeFileCount: runtime.fileCount,
    schemaVersions: { ...input.schemaVersions },
    bundles: [...input.bundles].sort((left, right) => left.name.localeCompare(right.name)),
    sourceTreeClean: input.sourceTreeClean,
    frozenAt: input.frozenAt,
  });
}

const ZERO_METRICS: readonly (keyof ProductionQualificationMetrics)[] = [
  'humanInterventionsAfterSeal',
  'unexpectedBlocks',
  'unrecoveredDriverDeaths',
  'completedWorkRedoCount',
  'lostCandidates',
  'duplicateDispatches',
  'runtimeMutation',
];

function evidenceBlockers(
  evidence: readonly ProductionEvidenceRef[],
  candidate: ProductionCandidateIdentity,
  subject: string,
): string[] {
  if (evidence.length === 0) return [`${subject} has no evidence reference.`];
  const blockers: string[] = [];
  for (const item of evidence) {
    if (item.candidateCommit !== candidate.commit || item.runtimeDigest !== candidate.runtimeDigest) {
      blockers.push(`${subject} evidence ${item.ref} belongs to a different candidate.`);
    }
  }
  return blockers;
}

export interface BuildProductionQualificationInput {
  qualificationRunId: string;
  candidate: ProductionCandidateIdentity;
  environment: ProductionEnvironment;
  gates: readonly ProductionGateObservation[];
  historicalFaults: readonly HistoricalFaultObservation[];
  metrics: ProductionQualificationMetrics;
  knownLimitations?: readonly string[] | undefined;
  generatedAt: string;
}

/**
 * Materialize every gate and fault, then decide fail-closed. Missing entries
 * become SKIPPED_NOT_ALLOWED; an invalid or duplicate attestation becomes a
 * blocker, never an exception that could erase the failed evidence.
 */
export function buildProductionQualificationManifest(
  input: BuildProductionQualificationInput,
): ProductionQualificationManifest {
  const candidate = productionCandidateIdentitySchema.parse(input.candidate);
  const environment = productionEnvironmentSchema.parse(input.environment);
  const metrics = productionQualificationMetricsSchema.parse(input.metrics);
  const parsedGates = input.gates.map((gate) => productionGateObservationSchema.parse(gate));
  const parsedFaults = input.historicalFaults.map((fault) => historicalFaultObservationSchema.parse(fault));
  const blockers: string[] = [];

  const knownGateIds = new Set(PRODUCTION_GATE_IDS);
  for (const observation of parsedGates) {
    if (!knownGateIds.has(observation.id)) blockers.push(`Unrecognized production gate ${observation.id}.`);
    if (parsedGates.filter((gate) => gate.id === observation.id).length > 1) blockers.push(`Duplicate production gate ${observation.id}.`);
  }
  const gates = PRODUCTION_QUALIFICATION_GATES.map((definition) => {
    const observation = parsedGates.find((gate) => gate.id === definition.id) ?? {
      id: definition.id,
      result: 'SKIPPED_NOT_ALLOWED' as const,
      summary: 'No qualification evidence was recorded for this mandatory gate.',
      evidence: [],
      diagnostics: [],
    };
    if (observation.result !== 'PASS') blockers.push(`Gate ${definition.id} is ${observation.result}.`);
    else blockers.push(...evidenceBlockers(observation.evidence, candidate, `Gate ${definition.id}`));
    return materializedGateSchema.parse({ ...definition, ...observation });
  });

  const knownFaultIds = new Set(HISTORICAL_FAULT_IDS);
  for (const observation of parsedFaults) {
    if (!knownFaultIds.has(observation.id)) blockers.push(`Unrecognized historical fault ${observation.id}.`);
    if (parsedFaults.filter((fault) => fault.id === observation.id).length > 1) blockers.push(`Duplicate historical fault ${observation.id}.`);
  }
  const historicalFaults = HISTORICAL_FAULT_CATALOG.map((definition) => {
    const observation = parsedFaults.find((fault) => fault.id === definition.id) ?? {
      id: definition.id,
      result: 'SKIPPED_NOT_ALLOWED' as const,
      evidence: [],
      diagnostics: [],
    };
    if (observation.result !== 'PASS') blockers.push(`Historical fault ${definition.id} is ${observation.result}.`);
    else blockers.push(...evidenceBlockers(observation.evidence, candidate, `Historical fault ${definition.id}`));
    return materializedFaultSchema.parse({ ...definition, ...observation });
  });

  if (!candidate.sourceTreeClean) blockers.push('The release candidate source tree was not clean when frozen.');
  for (const metricName of ZERO_METRICS) {
    const value = metrics[metricName];
    if (value === null) blockers.push(`Required metric ${metricName} is unavailable.`);
    else if (value !== 0) blockers.push(`Required metric ${metricName} is ${String(value)}, expected 0.`);
  }
  if (metrics.zeroTouchAfterSeal !== true) blockers.push('zeroTouchAfterSeal is not true.');
  if (metrics.finalJobStatus !== 'COMPLETED') blockers.push('The canonical qualification Job did not reach authoritative COMPLETED.');
  if (metrics.controlPlaneSelfRepairEnabled !== false) blockers.push('Control-plane self-repair was not proven disabled.');
  if (metrics.runtimeStartDigest !== candidate.runtimeDigest) blockers.push('Mission start runtime digest does not match the frozen candidate.');
  if (metrics.runtimeEndDigest !== candidate.runtimeDigest) blockers.push('Mission end runtime digest does not match the frozen candidate.');

  const uniqueBlockers = [...new Set(blockers)];
  const status: ProductionReleaseDecision = uniqueBlockers.length === 0 ? 'READY' : 'NOT_READY';
  const failedRequiredGateIds = new Set(gates
    .filter((gate) => gate.result !== 'PASS' || evidenceBlockers(gate.evidence, candidate, `Gate ${gate.id}`).length > 0)
    .map((gate) => gate.id));
  if (historicalFaults.some((fault) =>
    fault.result !== 'PASS' || evidenceBlockers(fault.evidence, candidate, `Historical fault ${fault.id}`).length > 0)) {
    failedRequiredGateIds.add('historical-fault-replay');
  }
  if (
    !candidate.sourceTreeClean ||
    metrics.runtimeMutation !== 0 ||
    metrics.runtimeStartDigest !== candidate.runtimeDigest ||
    metrics.runtimeEndDigest !== candidate.runtimeDigest
  ) {
    failedRequiredGateIds.add('release-reproducibility');
  }
  if (metrics.controlPlaneSelfRepairEnabled !== false) failedRequiredGateIds.add('security-authority');
  if (
    metrics.zeroTouchAfterSeal !== true ||
    metrics.finalJobStatus !== 'COMPLETED' ||
    metrics.humanInterventionsAfterSeal !== 0 ||
    metrics.unexpectedBlocks !== 0
  ) {
    failedRequiredGateIds.add('closure-completion');
  }
  if (
    metrics.unrecoveredDriverDeaths !== 0 ||
    metrics.completedWorkRedoCount !== 0 ||
    metrics.lostCandidates !== 0 ||
    metrics.duplicateDispatches !== 0
  ) {
    failedRequiredGateIds.add('restart-resume');
  }
  if (ZERO_METRICS.some((metric) => metrics[metric] === null)) failedRequiredGateIds.add('telemetry-report');
  const marker = status === 'READY'
    ? productionReadyMarkerSchema.parse({
        status: 'PRODUCTION_READY',
        release: PRODUCTION_QUALIFICATION_RELEASE,
        version: candidate.version,
        commit: candidate.commit,
        runtimeDigest: candidate.runtimeDigest,
        qualificationRunId: input.qualificationRunId,
        manifest: PRODUCTION_QUALIFICATION_ARTIFACTS.manifest,
        report: PRODUCTION_QUALIFICATION_ARTIFACTS.report,
      })
    : null;

  return productionQualificationManifestSchema.parse({
    schemaVersion: PRODUCTION_QUALIFICATION_SCHEMA_VERSION,
    release: PRODUCTION_QUALIFICATION_RELEASE,
    qualificationRunId: input.qualificationRunId,
    candidate,
    environment,
    gates,
    historicalFaults,
    metrics,
    knownLimitations: [...(input.knownLimitations ?? [])],
    decision: { status, failedRequiredGateIds: [...failedRequiredGateIds], blockers: uniqueBlockers },
    marker,
    generatedAt: input.generatedAt,
  });
}

function displayMetric(value: number | boolean | string | null): string {
  return value === null ? 'UNAVAILABLE' : String(value);
}

/** Human-readable report derived only from the machine manifest. */
export function renderProductionQualificationMarkdown(
  manifest: ProductionQualificationManifest,
): string {
  const parsed = productionQualificationManifestSchema.parse(manifest);
  const lines: string[] = [];
  const push = (line = ''): void => { lines.push(line); };
  push(`# SpecBridge ${parsed.release} Production Qualification Report`);
  push();
  push('## Candidate');
  push();
  push(`- Version: ${parsed.candidate.version}`);
  push(`- Commit: \`${parsed.candidate.commit}\``);
  push(`- Runtime digest: \`${parsed.candidate.runtimeDigest}\``);
  push(`- Runtime files: ${parsed.candidate.runtimeFileCount}`);
  push(`- Frozen: ${parsed.candidate.frozenAt}`);
  push(`- Clean source tree: ${String(parsed.candidate.sourceTreeClean)}`);
  push();
  push('## Gate matrix');
  push();
  push('| Gate | Qualification | Result | Evidence |');
  push('| --- | --- | --- | ---: |');
  for (const gate of parsed.gates) push(`| ${gate.letter} | ${gate.title} | ${gate.result} | ${gate.evidence.length} |`);
  push();
  push('## Historical StepRelay fault replay');
  push();
  for (const fault of parsed.historicalFaults) push(`- ${fault.id} ${fault.description} — ${fault.result}`);
  push();
  push('## Zero-tolerance and runtime facts');
  push();
  for (const metric of ZERO_METRICS) push(`- ${metric}: ${displayMetric(parsed.metrics[metric])}`);
  push(`- zeroTouchAfterSeal: ${displayMetric(parsed.metrics.zeroTouchAfterSeal)}`);
  push(`- finalJobStatus: ${displayMetric(parsed.metrics.finalJobStatus)}`);
  push(`- controlPlaneSelfRepairEnabled: ${displayMetric(parsed.metrics.controlPlaneSelfRepairEnabled)}`);
  push(`- usefulWorkDuringSubscriptionCooldown: ${displayMetric(parsed.metrics.usefulWorkDuringSubscriptionCooldown)}`);
  push(`- strongBuilderAvoidanceRatio: ${displayMetric(parsed.metrics.strongBuilderAvoidanceRatio)}`);
  push(`- researchAvoidanceRatio: ${displayMetric(parsed.metrics.researchAvoidanceRatio)}`);
  push(`- soakDurationMs: ${displayMetric(parsed.metrics.soakDurationMs)}`);
  push();
  push('## Environment');
  push();
  push(`- OS: ${parsed.environment.os}`);
  push(`- Node: ${parsed.environment.nodeVersion}`);
  push(`- pnpm: ${parsed.environment.pnpmVersion}`);
  push(`- Git: ${parsed.environment.gitVersion}`);
  push(`- Local model: ${parsed.environment.localModel?.model ?? 'NOT_EXERCISED'}`);
  push(`- DeerFlow: ${parsed.environment.deerFlow?.provider ?? 'NOT_EXERCISED'}`);
  push();
  push('## Known limitations');
  push();
  if (parsed.knownLimitations.length === 0) push('- None recorded.');
  else for (const limitation of parsed.knownLimitations) push(`- ${limitation}`);
  push();
  push('## Release decision');
  push();
  push(`**${parsed.decision.status}**`);
  if (parsed.decision.blockers.length > 0) {
    push();
    push('Blockers:');
    push();
    for (const blocker of parsed.decision.blockers) push(`- ${blocker}`);
  }
  if (parsed.marker !== null) {
    push();
    push(`Marker: **${parsed.marker.status}**`);
  }
  push();
  push(`Generated ${parsed.generatedAt} from candidate-bound evidence for run ${parsed.qualificationRunId}.`);
  return `${lines.join('\n')}\n`;
}
