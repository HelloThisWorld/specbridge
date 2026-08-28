import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkspaceInfo } from '@specbridge/core';
import type { RepositoryContextIndex, RepositoryIndexEntry } from '@specbridge/context';
import type { ProductContract } from '@specbridge/mission';
import { readAdrs } from '@specbridge/mission';
import { listSeals } from '@specbridge/autonomy';
import type { OwnedContract } from '../grounding.js';
import { activeConstitutionRules, activeProductContracts } from '../grounding.js';
import type {
  ProductTruthReference,
  SnapshotMode,
  SystemEvidenceRef,
  SystemFinding,
  SystemUncertainty,
} from './state.js';
import { BOOTSTRAP_LIMITS } from './state.js';
import type { ResolvedRepository } from './repositories.js';
import { repositoryOfPath, repositoryRelativePath } from './repositories.js';

/**
 * Deterministic snapshot synthesis.
 *
 * Everything here is a pure function of the repository index, bounded reads
 * of manifest files the index already admitted, and existing canonical
 * SpecBridge product truth. No model is involved: Phase 1 prefers
 * deterministic extraction, and every finding below carries the evidence it
 * was computed from, so "where did this claim come from?" always has a
 * file-and-hash answer.
 *
 * The extractor UNDER-CLAIMS on purpose. A capability it misses costs one
 * clarifying question in conversation; a capability it invents becomes a
 * false premise the whole product discussion builds on. Thresholds below
 * (minimum supporting files for a pattern, known-dependency lists for
 * frameworks) all err toward silence, and what could not be determined is
 * reported as an uncertainty rather than papered over.
 */

// ---------------------------------------------------------------------------
// Vocabulary the extractor recognises
// ---------------------------------------------------------------------------

/** Symbol suffixes that name an operational capability. Conservative. */
const CAPABILITY_SUFFIXES: readonly string[] = [
  'Service',
  'Scheduler',
  'Manager',
  'Registry',
  'Audit',
  'Auditor',
  'AuditLog',
  'Engine',
  'Gateway',
  'Orchestrator',
  'Dispatcher',
  'Coordinator',
  'Provider',
  'Authenticator',
  'Authorizer',
];

/** Symbols that are infrastructure noise, never domain objects. */
const DOMAIN_NOISE_PATTERN =
  /(Error|Exception|Config(uration)?|Options?|Utils?|Helper|Factory|Builder|Test|Mock|Stub|Fixture|Impl|Base|Abstract|Props|State|Context|Provider|Module|Plugin|Constants?)$/;

/** File names that declare a public interface by existing. */
const PUBLIC_INTERFACE_FILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)openapi\.(ya?ml|json)$/i,
  /(^|\/)swagger\.(ya?ml|json)$/i,
  /\.proto$/i,
  /\.graphql$/i,
  /\.avsc$/i,
  /(^|\/)schema\.(json|sql|graphql)$/i,
  /(^|\/)index\.d\.ts$/i,
];

/** Path shapes that constitute interoperability surfaces. */
const MIGRATION_PATH_PATTERN = /(^|\/)(migrations?|db\/migrate|flyway|liquibase)(\/|$)/i;

/**
 * Known dependency → architecture label. Only names on this list produce
 * architecture findings; an unknown dependency produces nothing rather than
 * a guess. Additive by design.
 */
const DEPENDENCY_ARCHITECTURE: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /spring-?boot|springframework\.boot/i, label: 'Spring Boot backend framework' },
  { pattern: /"react"/, label: 'React frontend' },
  { pattern: /"vue"/, label: 'Vue frontend' },
  { pattern: /"next"/, label: 'Next.js frontend framework' },
  { pattern: /"express"/, label: 'Express HTTP server' },
  { pattern: /"fastify"/, label: 'Fastify HTTP server' },
  { pattern: /\bkafka\b/i, label: 'Kafka messaging' },
  { pattern: /rabbitmq|amqp/i, label: 'AMQP messaging' },
  { pattern: /postgres|postgresql|\bpg\b/i, label: 'PostgreSQL persistence' },
  { pattern: /\bmysql\b/i, label: 'MySQL persistence' },
  { pattern: /mongodb|mongoose/i, label: 'MongoDB persistence' },
  { pattern: /\bredis\b/i, label: 'Redis' },
  { pattern: /prometheus|micrometer/i, label: 'Prometheus metrics integration' },
  { pattern: /grafana/i, label: 'Grafana integration' },
  { pattern: /kubernetes|k8s|client-java|kubectl/i, label: 'Kubernetes integration' },
  { pattern: /grpc/i, label: 'gRPC communication' },
  { pattern: /graphql/i, label: 'GraphQL API' },
  { pattern: /testcontainers/i, label: 'Testcontainers-based integration testing' },
];

/** Manifest basenames worth a bounded read for dependencies/constraints. */
const MANIFEST_BASENAMES = new Set([
  'package.json',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'pom.xml',
  'go.mod',
  'cargo.toml',
  'pyproject.toml',
  'requirements.txt',
  'gemfile',
  'docker-compose.yml',
  'docker-compose.yaml',
]);

const MAX_MANIFEST_READ_BYTES = 262_144;

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

export interface SynthesisInput {
  workspace: WorkspaceInfo;
  repositories: readonly ResolvedRepository[];
  index: RepositoryContextIndex;
  /** Extra uncertainty notes from resolution (bounded). */
  notes?: readonly string[] | undefined;
}

export interface SynthesizedFindings {
  mode: SnapshotMode;
  architecture: SystemFinding[];
  capabilities: SystemFinding[];
  publicSurfaces: SystemFinding[];
  domainObjects: SystemFinding[];
  implementationPatterns: SystemFinding[];
  constraints: SystemFinding[];
  uncertainties: SystemUncertainty[];
  existingProductTruth: ProductTruthReference[];
}

export function synthesizeSystemFindings(input: SynthesisInput): SynthesizedFindings {
  const ids = idFactory();
  const entries = input.index.entries;
  const uncertainties: SystemUncertainty[] = [];
  for (const note of input.notes ?? []) {
    uncertainties.push({ area: 'repository resolution', detail: clip(note) });
  }

  const fileRef = (entry: RepositoryIndexEntry, symbol?: string): SystemEvidenceRef => {
    const repo = repositoryOfPath(input.repositories, entry.path);
    return {
      repositoryId: repo?.repositoryId ?? 'workspace',
      path: repo !== undefined ? repositoryRelativePath(repo, entry.path) : entry.path,
      contentHash: entry.contentHash,
      ...(symbol !== undefined ? { symbol } : {}),
    };
  };

  // --- Existing product truth (SEALED_PRODUCT_TRUTH) ----------------------
  const contracts = safeContracts(input.workspace);
  const rules = safeRules(input.workspace);
  const truth: ProductTruthReference[] = [];
  for (const owned of contracts) {
    truth.push({
      kind: 'contract',
      missionId: owned.missionId,
      ref: owned.contract.contractId,
      revision: owned.contract.revision,
      title: clip(`${owned.contract.title} — ${owned.contract.summary}`),
    });
  }
  for (const rule of rules) {
    truth.push({
      kind: 'constitution-rule',
      missionId: rule.missionId,
      ref: rule.ruleId,
      title: clip(rule.statement),
    });
  }
  for (const owned of contracts.slice(0, 3)) {
    // ADRs are read per mission; one pass per distinct mission.
    void owned;
  }
  for (const missionId of [...new Set(contracts.map((owned) => owned.missionId))]) {
    for (const adr of safeAdrs(input.workspace, missionId)) {
      if (adr.status !== 'accepted') continue;
      truth.push({
        kind: 'adr',
        missionId,
        ref: adr.adrId,
        title: clip(`${adr.title}: ${adr.decision}`),
      });
    }
  }
  for (const seal of safeSeals(input.workspace)) {
    if (seal.status !== 'SEALED') continue;
    truth.push({
      kind: 'seal',
      missionId: seal.missionId,
      ref: seal.sealId,
      title: clip(
        `sealed ${seal.contracts.length} contract(s), ${seal.acceptanceCriteria.length} acceptance criteria`,
      ),
    });
  }

  // --- Constraints from sealed compatibility promises ---------------------
  const constraints: SystemFinding[] = [];
  for (const owned of contracts) {
    if (owned.contract.classification !== 'public') continue;
    constraints.push({
      findingId: ids('con'),
      class: 'SEALED_PRODUCT_TRUTH',
      statement: clip(
        `Existing compatibility promise: ${owned.contract.title} is ` +
          `${owned.contract.compatibilityPolicy} (${owned.contract.contractId} r${owned.contract.revision}).`,
      ),
      evidence: [
        {
          repositoryId: 'specbridge',
          missionId: owned.missionId,
          contractId: owned.contract.contractId,
          contractRevision: owned.contract.revision,
        },
      ],
    });
  }

  // --- Language + build observation (OBSERVED_IMPLEMENTATION) -------------
  const architecture: SystemFinding[] = [];
  const sourceEntries = entries.filter((entry) => entry.kind === 'source');
  const languageCounts = new Map<string, { count: number; sample: RepositoryIndexEntry }>();
  for (const entry of sourceEntries) {
    const existing = languageCounts.get(entry.language);
    if (existing === undefined) languageCounts.set(entry.language, { count: 1, sample: entry });
    else existing.count += 1;
  }
  const topLanguages = [...languageCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 3);
  if (topLanguages.length > 0) {
    architecture.push({
      findingId: ids('arc'),
      class: 'OBSERVED_IMPLEMENTATION',
      statement: clip(
        `Primary implementation language(s): ${topLanguages
          .map(([language, info]) => `${language} (${info.count} source file(s))`)
          .join(', ')}.`,
      ),
      evidence: topLanguages.map(([, info]) => fileRef(info.sample)),
    });
  }

  // --- Manifest-derived architecture and constraints ----------------------
  const manifestEntries = entries.filter((entry) =>
    MANIFEST_BASENAMES.has(path.posix.basename(entry.path).toLowerCase()),
  );
  const architectureLabels = new Map<string, RepositoryIndexEntry>();
  for (const entry of manifestEntries.slice(0, 40)) {
    const body = boundedRead(input.workspace, entry.path);
    if (body === undefined) {
      uncertainties.push({
        area: 'build manifests',
        detail: clip(`${entry.path} could not be read; dependency-derived findings may be missing.`),
      });
      continue;
    }
    for (const { pattern, label } of DEPENDENCY_ARCHITECTURE) {
      if (pattern.test(body) && !architectureLabels.has(label)) {
        architectureLabels.set(label, entry);
      }
    }
    const javaVersion = /(?:sourceCompatibility|languageVersion|maven\.compiler\.source|java\.version)\D{0,20}(\d{1,2})/.exec(
      body,
    );
    if (javaVersion !== null && entry.path.match(/gradle|pom/i) !== null) {
      constraints.push({
        findingId: ids('con'),
        class: 'OBSERVED_IMPLEMENTATION',
        statement: clip(`The build declares Java ${javaVersion[1]}.`),
        evidence: [fileRef(entry)],
      });
    }
    const engines = /"engines"\s*:\s*\{[^}]*"node"\s*:\s*"([^"]+)"/.exec(body);
    if (engines !== null) {
      constraints.push({
        findingId: ids('con'),
        class: 'OBSERVED_IMPLEMENTATION',
        statement: clip(`The package declares a Node engine constraint of ${engines[1]}.`),
        evidence: [fileRef(entry)],
      });
    }
  }
  for (const [label, entry] of [...architectureLabels.entries()].slice(
    0,
    BOOTSTRAP_LIMITS.maxFindingsPerCategory - architecture.length,
  )) {
    architecture.push({
      findingId: ids('arc'),
      class: 'OBSERVED_IMPLEMENTATION',
      statement: clip(`${label} (declared by ${path.posix.basename(entry.path)}).`),
      evidence: [fileRef(entry)],
    });
  }

  // --- Documented architecture (DOCUMENTED_ARCHITECTURE) ------------------
  const docEntries = entries
    .filter((entry) => entry.kind === 'doc')
    .filter((entry) =>
      /(^|\/)(readme|architecture|design|adr[s]?[/-]|docs\/)/i.test(entry.path) ||
      /(^|\/)docs\//i.test(entry.path),
    )
    .slice(0, 10);
  for (const entry of docEntries) {
    const heading = firstHeading(input.workspace, entry.path);
    architecture.push({
      findingId: ids('arc'),
      class: 'DOCUMENTED_ARCHITECTURE',
      statement: clip(
        heading !== undefined
          ? `Documentation: "${heading}" (${entry.path}).`
          : `Documentation present at ${entry.path}.`,
      ),
      evidence: [fileRef(entry)],
    });
    if (architecture.length >= BOOTSTRAP_LIMITS.maxFindingsPerCategory) break;
  }

  // --- Capabilities from declared symbols ---------------------------------
  const capabilities: SystemFinding[] = [];
  const capabilitySeen = new Set<string>();
  const rankedSources = [...sourceEntries].sort(
    (a, b) => fanIn(input.index, b.path) - fanIn(input.index, a.path),
  );
  for (const entry of rankedSources) {
    for (const symbol of entry.symbols) {
      if (capabilitySeen.has(symbol)) continue;
      const suffix = CAPABILITY_SUFFIXES.find((candidate) => symbol.endsWith(candidate));
      if (suffix === undefined || symbol.length <= suffix.length) continue;
      capabilitySeen.add(symbol);
      capabilities.push({
        findingId: ids('cap'),
        class: 'OBSERVED_IMPLEMENTATION',
        statement: clip(`Existing capability: ${symbol} (${entry.path}).`),
        evidence: [fileRef(entry, symbol)],
      });
      if (capabilities.length >= BOOTSTRAP_LIMITS.maxFindingsPerCategory) break;
    }
    if (capabilities.length >= BOOTSTRAP_LIMITS.maxFindingsPerCategory) break;
  }

  // --- Domain objects ------------------------------------------------------
  const domainObjects: SystemFinding[] = [];
  const domainSeen = new Set<string>();
  for (const entry of rankedSources) {
    for (const symbol of entry.symbols) {
      if (domainSeen.has(symbol) || capabilitySeen.has(symbol)) continue;
      if (!/^[A-Z][A-Za-z0-9]{2,40}$/.test(symbol)) continue;
      if (DOMAIN_NOISE_PATTERN.test(symbol)) continue;
      if (CAPABILITY_SUFFIXES.some((suffix) => symbol.endsWith(suffix))) continue;
      domainSeen.add(symbol);
      domainObjects.push({
        findingId: ids('dom'),
        class: 'OBSERVED_IMPLEMENTATION',
        statement: clip(`Domain object: ${symbol} (${entry.path}).`),
        evidence: [fileRef(entry, symbol)],
      });
      if (domainObjects.length >= 20) break;
    }
    if (domainObjects.length >= 20) break;
  }

  // --- Public surfaces -----------------------------------------------------
  const publicSurfaces: SystemFinding[] = [];
  for (const entry of entries) {
    if (publicSurfaces.length >= BOOTSTRAP_LIMITS.maxFindingsPerCategory) break;
    if (PUBLIC_INTERFACE_FILE_PATTERNS.some((pattern) => pattern.test(entry.path))) {
      publicSurfaces.push({
        findingId: ids('pub'),
        class: 'OBSERVED_IMPLEMENTATION',
        statement: clip(`Public interface definition: ${entry.path}.`),
        evidence: [fileRef(entry)],
      });
      continue;
    }
    if (MIGRATION_PATH_PATTERN.test(entry.path) && entry.kind !== 'other') {
      publicSurfaces.push({
        findingId: ids('pub'),
        class: 'OBSERVED_IMPLEMENTATION',
        statement: clip(`Database migration surface: ${entry.path}.`),
        evidence: [fileRef(entry)],
      });
    }
  }
  // Controller-shaped files as a REST-ish surface, conservatively.
  const controllerEntries = sourceEntries.filter((entry) =>
    entry.symbols.some((symbol) => /Controller$/.test(symbol)),
  );
  if (controllerEntries.length > 0 && publicSurfaces.length < BOOTSTRAP_LIMITS.maxFindingsPerCategory) {
    publicSurfaces.push({
      findingId: ids('pub'),
      class: 'OBSERVED_IMPLEMENTATION',
      statement: clip(
        `HTTP controller surface: ${controllerEntries.length} controller class(es), e.g. ` +
          `${controllerEntries[0]?.symbols.find((symbol) => /Controller$/.test(symbol)) ?? 'Controller'}.`,
      ),
      evidence: controllerEntries
        .slice(0, 3)
        .map((entry) =>
          fileRef(entry, entry.symbols.find((symbol) => /Controller$/.test(symbol))),
        ),
    });
  }

  // --- Implementation patterns (INFERRED_PATTERN) --------------------------
  const implementationPatterns: SystemFinding[] = [];
  const withSuffix = (suffix: RegExp): RepositoryIndexEntry[] =>
    sourceEntries.filter((entry) => entry.symbols.some((symbol) => suffix.test(symbol)));
  const controllers = withSuffix(/Controller$/);
  const services = withSuffix(/Service$/);
  const repositoriesLayer = withSuffix(/(Repository|Dao)$/);
  if (controllers.length >= 2 && services.length >= 2 && repositoriesLayer.length >= 2) {
    implementationPatterns.push({
      findingId: ids('pat'),
      class: 'INFERRED_PATTERN',
      statement: clip(
        `The backend appears to use controller → service → repository layering ` +
          `(${controllers.length}/${services.length}/${repositoriesLayer.length} classes).`,
      ),
      evidence: [controllers[0], services[0], repositoriesLayer[0]]
        .filter((entry): entry is RepositoryIndexEntry => entry !== undefined)
        .map((entry) => fileRef(entry)),
    });
  }
  const asyncShapes = sourceEntries.filter((entry) =>
    entry.symbols.some((symbol) => /(Job|Worker|Consumer|Listener|Handler)$/.test(symbol)),
  );
  if (asyncShapes.length >= 3) {
    implementationPatterns.push({
      findingId: ids('pat'),
      class: 'INFERRED_PATTERN',
      statement: clip(
        `Work appears to run through asynchronous job/handler classes (${asyncShapes.length} found).`,
      ),
      evidence: asyncShapes.slice(0, 3).map((entry) => fileRef(entry)),
    });
  }
  const testedSources = new Set(
    entries.filter((entry) => entry.kind === 'test').flatMap((entry) => entry.testTargets),
  );
  if (testedSources.size >= 3) {
    implementationPatterns.push({
      findingId: ids('pat'),
      class: 'INFERRED_PATTERN',
      statement: clip(
        `Tests appear to accompany sources by convention (${testedSources.size} source file(s) with matched tests).`,
      ),
      evidence: entries
        .filter((entry) => entry.kind === 'test' && entry.testTargets.length > 0)
        .slice(0, 3)
        .map((entry) => fileRef(entry)),
    });
  }

  // --- Build-system constraints per repository -----------------------------
  for (const repo of input.repositories) {
    const marker = manifestEntries.find(
      (entry) => repositoryOfPath(input.repositories, entry.path)?.repositoryId === repo.repositoryId,
    );
    if (marker === undefined) continue;
    constraints.push({
      findingId: ids('con'),
      class: 'OBSERVED_IMPLEMENTATION',
      statement: clip(
        `Repository "${repo.repositoryId}" builds with ${path.posix.basename(marker.path)}.`,
      ),
      evidence: [fileRef(marker)],
    });
    if (constraints.length >= BOOTSTRAP_LIMITS.maxFindingsPerCategory) break;
  }

  // --- Uncertainties -------------------------------------------------------
  if (input.index.state.truncated) {
    uncertainties.push({
      area: 'index coverage',
      detail: clip(
        `The repository index hit its entry ceiling (${entries.length}); findings describe the indexed part only.`,
      ),
    });
  }
  if (sourceEntries.length > 0 && sourceEntries.every((entry) => entry.symbols.length === 0)) {
    uncertainties.push({
      area: 'symbol extraction',
      detail:
        'No declared symbols could be extracted; capability and domain-object findings are unavailable.',
    });
  }
  for (const repo of input.repositories) {
    if (repo.isGitRepository && repo.gitHead === null) {
      uncertainties.push({
        area: 'repository baseline',
        detail: clip(`Repository "${repo.repositoryId}" has a .git but no resolvable HEAD.`),
      });
    }
  }

  // --- Mode ----------------------------------------------------------------
  const mode = detectMode({
    sourceFiles: sourceEntries.length,
    hasProductTruth: truth.length > 0,
    truncated: input.index.state.truncated,
    resolutionNotes: (input.notes ?? []).length,
  });
  if (mode === 'GREENFIELD') {
    uncertainties.length = 0; // an empty baseline is a clean fact, not doubt
  }

  return {
    mode,
    architecture: bounded(architecture),
    capabilities: bounded(capabilities),
    publicSurfaces: bounded(publicSurfaces),
    domainObjects: bounded(domainObjects),
    implementationPatterns: bounded(implementationPatterns),
    constraints: bounded(constraints),
    uncertainties: uncertainties.slice(0, BOOTSTRAP_LIMITS.maxUncertainties),
    existingProductTruth: truth.slice(0, BOOTSTRAP_LIMITS.maxProductTruthRefs),
  };
}

/**
 * Brownfield vs Greenfield, decided from deterministic evidence only.
 *
 * Three or more source files, or any existing product truth, is a system
 * worth describing: BROWNFIELD. Nothing at all is a clean empty baseline:
 * GREENFIELD, and explicitly not an error. The sliver between — one or two
 * files, or an index that could not see everything — is PARTIAL, which is
 * an honest "not enough evidence to call it".
 */
export function detectMode(input: {
  sourceFiles: number;
  hasProductTruth: boolean;
  truncated: boolean;
  resolutionNotes: number;
}): SnapshotMode {
  if (input.hasProductTruth || input.sourceFiles >= 3) {
    return input.resolutionNotes > 0 ? 'PARTIAL' : 'BROWNFIELD';
  }
  if (input.sourceFiles === 0 && !input.truncated) return 'GREENFIELD';
  return 'PARTIAL';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function idFactory(): (prefix: string) => string {
  let sequence = 0;
  return (prefix: string) => `${prefix}-${String(++sequence).padStart(3, '0')}`;
}

function bounded(findings: SystemFinding[]): SystemFinding[] {
  return findings.slice(0, BOOTSTRAP_LIMITS.maxFindingsPerCategory);
}

function fanIn(index: RepositoryContextIndex, filePath: string): number {
  return index.dependentsOf(filePath).length;
}

function clip(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > BOOTSTRAP_LIMITS.maxTextChars
    ? `${collapsed.slice(0, BOOTSTRAP_LIMITS.maxTextChars - 1)}…`
    : collapsed;
}

/**
 * Read a file the INDEX already admitted, bounded.
 *
 * Only indexed paths reach this function, so every exclusion the scan
 * enforced — protected paths, credential-shaped names, binaries, size —
 * is inherited rather than re-implemented.
 */
function boundedRead(workspace: WorkspaceInfo, relPath: string): string | undefined {
  try {
    const abs = path.join(workspace.rootDir, relPath);
    if (!existsSync(abs)) return undefined;
    const body = readFileSync(abs, 'utf8');
    return body.length > MAX_MANIFEST_READ_BYTES ? body.slice(0, MAX_MANIFEST_READ_BYTES) : body;
  } catch {
    return undefined;
  }
}

function firstHeading(workspace: WorkspaceInfo, relPath: string): string | undefined {
  const body = boundedRead(workspace, relPath);
  if (body === undefined) return undefined;
  const match = /^#{1,3}\s+(.{3,120})$/m.exec(body.slice(0, 4_000));
  return match?.[1]?.trim();
}

function safeContracts(workspace: WorkspaceInfo): OwnedContract[] {
  try {
    return activeProductContracts(workspace);
  } catch {
    return [];
  }
}

function safeRules(
  workspace: WorkspaceInfo,
): { missionId: string; ruleId: string; statement: string }[] {
  try {
    return activeConstitutionRules(workspace);
  } catch {
    return [];
  }
}

function safeAdrs(
  workspace: WorkspaceInfo,
  missionId: string,
): { adrId: string; title: string; decision: string; status: string }[] {
  try {
    return readAdrs(workspace, missionId);
  } catch {
    return [];
  }
}

function safeSeals(workspace: WorkspaceInfo): {
  sealId: string;
  missionId: string;
  status: string;
  contracts: readonly unknown[];
  acceptanceCriteria: readonly unknown[];
}[] {
  try {
    return listSeals(workspace);
  } catch {
    return [];
  }
}

export type { ProductContract };
