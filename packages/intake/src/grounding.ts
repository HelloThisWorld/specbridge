import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { WorkspaceInfo } from '@specbridge/core';
import { discoverSpecs, listSteeringFiles } from '@specbridge/compat-kiro';
import { listSeals } from '@specbridge/autonomy';
import type { MissionState, ProductContract } from '@specbridge/mission';
import {
  listMissions,
  readAdrs,
  readConstitution,
  readContractRegistry,
} from '@specbridge/mission';
import type { IntakeDeps } from './deps.js';
import { nowIso } from './deps.js';
import type { RepositoryEvidence, RepositoryGrounding } from './state.js';
import { INTAKE_GROUNDING_SCHEMA_VERSION, INTAKE_LIMITS } from './state.js';
import { readProductBaseline } from './store.js';

/**
 * Repository-grounded discovery.
 *
 * The premise of this file is that discovery in an EXISTING repository is
 * not product design. The product already exists; it already made promises;
 * somebody already decided how it is laid out. A discovery pass that opened
 * with "what should the architecture be?" would be asking a question the
 * repository answered years ago, and the fastest way to make a zero-touch
 * intake feel like a chatbot is to let it do that.
 *
 * So: read first, ask later, and only about what reading could not settle.
 *
 * Two categories come out, and keeping them apart is the whole job.
 *
 *   AUTHORITATIVE evidence is existing PRODUCT TRUTH — sealed contracts,
 *   constitution rules, ADRs, prior seals, approved specs. It can answer a
 *   product question, and it is never overwritten by a new feature.
 *
 *   CONTEXT is everything else the repository happens to contain — modules,
 *   the build system, test surfaces, public interface files. It informs
 *   engineering decisions, which are delegated and therefore never asked
 *   about at all.
 *
 * Everything here is READ-ONLY and offline. No git subprocess, no model, no
 * network: the head commit comes from reading `.git` directly, because
 * spawning git for a fact this cheap is how a test suite ends up three
 * minutes slower for nothing.
 */

// ---------------------------------------------------------------------------
// Build system detection
// ---------------------------------------------------------------------------

const BUILD_MARKERS: readonly { file: string; system: string }[] = [
  { file: 'pnpm-workspace.yaml', system: 'pnpm' },
  { file: 'pnpm-lock.yaml', system: 'pnpm' },
  { file: 'yarn.lock', system: 'yarn' },
  { file: 'package-lock.json', system: 'npm' },
  { file: 'settings.gradle.kts', system: 'gradle' },
  { file: 'settings.gradle', system: 'gradle' },
  { file: 'build.gradle.kts', system: 'gradle' },
  { file: 'build.gradle', system: 'gradle' },
  { file: 'pom.xml', system: 'maven' },
  { file: 'Cargo.toml', system: 'cargo' },
  { file: 'go.mod', system: 'go' },
  { file: 'pyproject.toml', system: 'python' },
  { file: 'Gemfile', system: 'bundler' },
  { file: 'package.json', system: 'npm' },
];

function detectBuildSystem(rootDir: string): string | null {
  for (const marker of BUILD_MARKERS) {
    if (existsSync(path.join(rootDir, marker.file))) return marker.system;
  }
  return null;
}

/** Directories that are never product modules. */
const MODULE_DENYLIST = new Set([
  '.git',
  '.github',
  '.kiro',
  '.specbridge',
  '.idea',
  '.vscode',
  'node_modules',
  'dist',
  'build',
  'target',
  'out',
  'coverage',
  '.gradle',
  '.mvn',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
]);

/** File names that name a public interface without needing to be read. */
const PUBLIC_INTERFACE_PATTERNS: readonly RegExp[] = [
  /^openapi\.(ya?ml|json)$/i,
  /^swagger\.(ya?ml|json)$/i,
  /^.*\.proto$/i,
  /^.*\.graphql$/i,
  /^.*\.avsc$/i,
  /^.*-schema\.json$/i,
  /^schema\.(json|sql|graphql)$/i,
  /^index\.d\.ts$/i,
];

const TEST_DIR_PATTERN = /^(tests?|spec|specs|__tests__|it|integration-tests?|e2e)$/i;

// ---------------------------------------------------------------------------
// Git head, without a subprocess
// ---------------------------------------------------------------------------

/**
 * Resolve the current commit by reading `.git` directly.
 *
 * Handles the four shapes that occur in practice: a plain repository, a
 * detached HEAD, a packed ref, and a LINKED WORKTREE.
 *
 * The worktree case is the one that is easy to get wrong, and the vNext.10.1
 * dogfood got it wrong. A worktree's `.git` is a FILE naming a per-worktree
 * gitdir, and that directory has its own `HEAD` — but the REF that HEAD
 * points at lives in the COMMON directory named by `commondir`, along with
 * `packed-refs`. Reading the ref relative to the per-worktree gitdir finds
 * nothing, so the commit resolves to `null` and the feature lineage cannot
 * record what the work started from.
 *
 * A repository with no commits, or one this cannot make sense of, returns
 * `null` — a different fact from "unchanged", and recorded as one.
 */
export function readGitHead(rootDir: string): string | null {
  try {
    const dotGit = path.join(rootDir, '.git');
    if (!existsSync(dotGit)) return null;
    let gitDir = dotGit;
    if (statSync(dotGit).isFile()) {
      const pointer = readFileSync(dotGit, 'utf8').trim();
      const match = /^gitdir:\s*(.+)$/.exec(pointer);
      if (match === null) return null;
      const target = match[1] ?? '';
      gitDir = path.isAbsolute(target) ? target : path.resolve(rootDir, target);
    }
    const headFile = path.join(gitDir, 'HEAD');
    if (!existsSync(headFile)) return null;
    const head = readFileSync(headFile, 'utf8').trim();
    if (/^[0-9a-f]{40}$/i.test(head)) return head.toLowerCase();
    const refMatch = /^ref:\s*(.+)$/.exec(head);
    if (refMatch === null) return null;
    const ref = (refMatch[1] ?? '').trim();

    // Refs are resolved against the per-worktree directory first (a worktree
    // may carry its own `refs/bisect`, for instance) and then against the
    // common directory, which is where an ordinary branch actually lives.
    for (const dir of refDirsFor(gitDir)) {
      const refFile = path.join(dir, ...ref.split('/'));
      if (!existsSync(refFile)) continue;
      const sha = readFileSync(refFile, 'utf8').trim();
      if (/^[0-9a-f]{40}$/i.test(sha)) return sha.toLowerCase();
    }
    for (const dir of refDirsFor(gitDir)) {
      const packed = path.join(dir, 'packed-refs');
      if (!existsSync(packed)) continue;
      for (const line of readFileSync(packed, 'utf8').split('\n')) {
        const entry = /^([0-9a-f]{40})\s+(.+)$/.exec(line.trim());
        if (entry !== null && entry[2] === ref) return (entry[1] ?? '').toLowerCase();
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** The gitdir itself, then the common directory a worktree shares. */
function refDirsFor(gitDir: string): string[] {
  const dirs = [gitDir];
  const commonFile = path.join(gitDir, 'commondir');
  if (existsSync(commonFile)) {
    try {
      const target = readFileSync(commonFile, 'utf8').trim();
      if (target.length > 0) {
        dirs.push(path.isAbsolute(target) ? target : path.resolve(gitDir, target));
      }
    } catch {
      // An unreadable commondir means the common directory cannot be found;
      // the per-worktree directory alone is still worth trying.
    }
  }
  return dirs;
}

// ---------------------------------------------------------------------------
// Grounding
// ---------------------------------------------------------------------------

export interface GroundingRequest {
  intakeId: string;
  /** Missions to exclude — the intake's own mission is not prior truth. */
  excludeMissionIds?: readonly string[] | undefined;
}

/**
 * Read every durable thing this workspace already knows.
 *
 * Ordered so authoritative product truth comes first in the evidence list:
 * the question screen walks it in order, and finding the answer in a sealed
 * contract before finding it in a directory listing is both faster and more
 * honest about what settled the question.
 */
export function groundInRepository(
  deps: IntakeDeps,
  request: GroundingRequest,
): RepositoryGrounding {
  const workspace = deps.workspace;
  const exclude = new Set(request.excludeMissionIds ?? []);
  const evidence: RepositoryEvidence[] = [];
  const notes: string[] = [];
  let sequence = 0;
  const nextId = (): string => `E-${String(++sequence).padStart(4, '0')}`;

  // --- Prior product authority: missions, contracts, constitution, ADRs ----
  const missions = listMissions(workspace).missions.filter(
    (mission) => !exclude.has(mission.missionId) && mission.status !== 'ABANDONED',
  );
  const priorMissionIds: string[] = [];
  for (const mission of missions) {
    priorMissionIds.push(mission.missionId);
    evidence.push({
      evidenceId: nextId(),
      kind: 'EXISTING_MISSION',
      ref: mission.missionId,
      summary: `${mission.name} (${mission.status}): ${clip(mission.goal, 300)}`,
      authoritative: mission.status === 'APPROVED',
      topics: ['goal'],
    });
    collectMissionAuthority(workspace, mission, evidence, nextId);
  }

  // --- Prior seals ---------------------------------------------------------
  for (const seal of listSeals(workspace)) {
    if (exclude.has(seal.missionId)) continue;
    if (seal.status !== 'SEALED') continue;
    evidence.push({
      evidenceId: nextId(),
      kind: 'PRIOR_SEAL',
      ref: seal.sealId,
      summary:
        `authorized ${seal.contracts.length} contract(s) and ` +
        `${seal.acceptanceCriteria.length} acceptance criterion/criteria for mission ${seal.missionId}`,
      authoritative: true,
      topics: [],
    });
  }

  // --- Existing specs ------------------------------------------------------
  const existingSpecNames: string[] = [];
  for (const folder of safeSpecs(workspace, notes)) {
    existingSpecNames.push(folder.name);
    evidence.push({
      evidenceId: nextId(),
      kind: 'EXISTING_SPEC',
      ref: folder.name,
      summary: `existing Kiro spec with ${folder.files.length} document(s)`,
      authoritative: false,
      topics: [],
      path: path.posix.join('.kiro', 'specs', folder.name),
    });
  }

  // --- Steering ------------------------------------------------------------
  for (const steering of safeSteering(workspace, notes)) {
    evidence.push({
      evidenceId: nextId(),
      kind: 'STEERING',
      ref: steering.name,
      summary: `steering document (${steering.inclusion})`,
      authoritative: false,
      topics: [],
      path: path.posix.join('.kiro', 'steering', steering.fileName),
    });
  }

  // --- Repository shape: modules, build system, tests, public interfaces ---
  const buildSystem = detectBuildSystem(workspace.rootDir);
  if (buildSystem !== null) {
    evidence.push({
      evidenceId: nextId(),
      kind: 'BUILD_SYSTEM',
      ref: buildSystem,
      summary: `the repository builds with ${buildSystem}`,
      authoritative: false,
      topics: ['configuration-semantics'],
    });
  } else {
    notes.push('No build system marker was found at the repository root.');
  }

  const modules: string[] = [];
  for (const entry of safeReaddir(workspace.rootDir, notes)) {
    if (!entry.isDirectory()) continue;
    if (MODULE_DENYLIST.has(entry.name) || entry.name.startsWith('.')) continue;
    modules.push(entry.name);
    if (TEST_DIR_PATTERN.test(entry.name)) {
      evidence.push({
        evidenceId: nextId(),
        kind: 'TEST_SURFACE',
        ref: entry.name,
        summary: `existing test surface at ${entry.name}/`,
        authoritative: false,
        topics: [],
        path: entry.name,
      });
      continue;
    }
    evidence.push({
      evidenceId: nextId(),
      kind: 'MODULE',
      ref: entry.name,
      summary: `existing module or subproject at ${entry.name}/`,
      authoritative: false,
      topics: ['system-boundaries'],
      path: entry.name,
    });
  }
  // One level down too: a monorepo's real modules live under packages/ or
  // similar, and stopping at the root would report one "module" for a
  // repository with twenty.
  for (const container of modules.slice(0, 40)) {
    const dir = path.join(workspace.rootDir, container);
    for (const entry of safeReaddir(dir, notes)) {
      if (!entry.isDirectory()) continue;
      if (MODULE_DENYLIST.has(entry.name) || entry.name.startsWith('.')) continue;
      if (evidence.length >= INTAKE_LIMITS.maxEvidence) break;
      evidence.push({
        evidenceId: nextId(),
        kind: 'MODULE',
        ref: `${container}/${entry.name}`,
        summary: `existing module at ${container}/${entry.name}/`,
        authoritative: false,
        topics: ['system-boundaries'],
        path: `${container}/${entry.name}`,
      });
    }
  }

  for (const entry of safeReaddir(workspace.rootDir, notes)) {
    if (!entry.isFile()) continue;
    if (!PUBLIC_INTERFACE_PATTERNS.some((pattern) => pattern.test(entry.name))) continue;
    evidence.push({
      evidenceId: nextId(),
      kind: 'PUBLIC_INTERFACE',
      ref: entry.name,
      summary: `a public interface definition at ${entry.name}`,
      authoritative: true,
      topics: ['public-api', 'protocol-identity'],
      path: entry.name,
    });
  }

  // --- Feature lineage from prior intakes ----------------------------------
  const baseline = readProductBaseline(workspace);
  for (const feature of baseline.features) {
    if (feature.intakeId === request.intakeId) continue;
    evidence.push({
      evidenceId: nextId(),
      kind: 'BASELINE_LINEAGE',
      ref: feature.intakeId,
      summary:
        `feature "${feature.name}" created ${feature.newContractIds.length} contract(s), ` +
        `extended ${feature.extendedContractIds.length}, changed ${feature.changedContractIds.length}` +
        (feature.outcome !== undefined ? ` (${feature.outcome})` : ''),
      authoritative: true,
      topics: ['evolution-rules', 'compatibility'],
    });
  }

  const existingProduct =
    priorMissionIds.length > 0 ||
    existingSpecNames.length > 0 ||
    baseline.features.some((feature) => feature.intakeId !== request.intakeId);

  if (!existingProduct) {
    notes.push(
      'This workspace carries no prior SpecBridge product truth; discovery is grounded in ' +
        'repository structure only.',
    );
  }

  return {
    schemaVersion: INTAKE_GROUNDING_SCHEMA_VERSION,
    intakeId: request.intakeId,
    groundedAt: nowIso(deps),
    baselineCommit: readGitHead(workspace.rootDir),
    existingProduct,
    evidence: evidence.slice(0, INTAKE_LIMITS.maxEvidence),
    priorMissionIds: priorMissionIds.slice(0, INTAKE_LIMITS.maxRefsPerRecord),
    existingSpecNames: existingSpecNames.slice(0, INTAKE_LIMITS.maxItems),
    buildSystem,
    modules: modules.slice(0, INTAKE_LIMITS.maxItems),
    notes: notes.slice(0, INTAKE_LIMITS.maxItems),
  };
}

function collectMissionAuthority(
  workspace: WorkspaceInfo,
  mission: MissionState,
  evidence: RepositoryEvidence[],
  nextId: () => string,
): void {
  for (const contract of safeContracts(workspace, mission.missionId)) {
    if (contract.status === 'superseded') continue;
    evidence.push({
      evidenceId: nextId(),
      kind: 'SEALED_CONTRACT',
      ref: `${mission.missionId}/${contract.contractId}`,
      summary:
        `${contract.contractId} r${contract.revision} [${contract.classification}/` +
        `${contract.compatibilityPolicy}] ${contract.title}: ${clip(contract.summary, 300)}`,
      authoritative: true,
      topics: contract.classification === 'public' ? ['public-api', 'compatibility'] : [],
    });
  }
  const constitution = readConstitution(workspace, mission.missionId);
  for (const rule of constitution?.rules ?? []) {
    if (rule.status !== 'active') continue;
    evidence.push({
      evidenceId: nextId(),
      kind: 'CONSTITUTION_RULE',
      ref: `${mission.missionId}/${rule.ruleId}`,
      summary: clip(rule.statement, 400),
      authoritative: true,
      topics: ['architecture-ownership'],
    });
  }
  for (const adr of readAdrs(workspace, mission.missionId)) {
    if (adr.status !== 'accepted') continue;
    evidence.push({
      evidenceId: nextId(),
      kind: 'ADR',
      ref: `${mission.missionId}/${adr.adrId}`,
      summary: `${adr.title}: ${clip(adr.decision, 300)}`,
      authoritative: true,
      topics: ['architecture-ownership'],
    });
  }
}

/**
 * Every active product contract in this workspace, with the mission that
 * owns it.
 *
 * The delta analysis needs the OWNER as well as the contract: telling a user
 * that their new feature would change CTR-002 is not much use without saying
 * which earlier mission promised it.
 */
export interface OwnedContract {
  missionId: string;
  missionName: string;
  contract: ProductContract;
}

export function activeProductContracts(
  workspace: WorkspaceInfo,
  options: { excludeMissionIds?: readonly string[] } = {},
): OwnedContract[] {
  const exclude = new Set(options.excludeMissionIds ?? []);
  const out: OwnedContract[] = [];
  for (const mission of listMissions(workspace).missions) {
    if (exclude.has(mission.missionId) || mission.status === 'ABANDONED') continue;
    for (const contract of safeContracts(workspace, mission.missionId)) {
      if (contract.status === 'superseded') continue;
      out.push({ missionId: mission.missionId, missionName: mission.name, contract });
    }
  }
  return out;
}

/** Active constitution rules across every mission in the workspace. */
export function activeConstitutionRules(
  workspace: WorkspaceInfo,
  options: { excludeMissionIds?: readonly string[] } = {},
): { missionId: string; ruleId: string; statement: string; guardPatterns: string[] }[] {
  const exclude = new Set(options.excludeMissionIds ?? []);
  const out: { missionId: string; ruleId: string; statement: string; guardPatterns: string[] }[] = [];
  for (const mission of listMissions(workspace).missions) {
    if (exclude.has(mission.missionId) || mission.status === 'ABANDONED') continue;
    const constitution = readConstitution(workspace, mission.missionId);
    for (const rule of constitution?.rules ?? []) {
      if (rule.status !== 'active') continue;
      out.push({
        missionId: mission.missionId,
        ruleId: rule.ruleId,
        statement: rule.statement,
        guardPatterns: [...rule.guardPatterns],
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Defensive reads
// ---------------------------------------------------------------------------

function safeContracts(workspace: WorkspaceInfo, missionId: string): ProductContract[] {
  try {
    return readContractRegistry(workspace, missionId);
  } catch {
    return [];
  }
}

function safeSpecs(
  workspace: WorkspaceInfo,
  notes: string[],
): { name: string; files: unknown[] }[] {
  try {
    return discoverSpecs(workspace) as unknown as { name: string; files: unknown[] }[];
  } catch (cause) {
    notes.push(`Existing specs could not be listed: ${message(cause)}.`);
    return [];
  }
}

function safeSteering(
  workspace: WorkspaceInfo,
  notes: string[],
): { name: string; inclusion: string; fileName: string }[] {
  try {
    return listSteeringFiles(workspace) as unknown as {
      name: string;
      inclusion: string;
      fileName: string;
    }[];
  } catch (cause) {
    notes.push(`Steering documents could not be listed: ${message(cause)}.`);
    return [];
  }
}

function safeReaddir(dir: string, notes: string[]): { name: string; isDirectory(): boolean; isFile(): boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (cause) {
    notes.push(`Directory ${dir} could not be listed: ${message(cause)}.`);
    return [];
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function clip(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}
