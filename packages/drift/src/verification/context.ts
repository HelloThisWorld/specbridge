import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { SpecAnalysis, SpecFolder } from '@specbridge/compat-kiro';
import {
  analyzeSpec,
  buildRequirementCatalog,
  extractPathReferences,
  extractTaskRequirementReferences,
  taskFingerprint,
  tryTaskPlanHashOfFile,
} from '@specbridge/compat-kiro';
import type {
  RequirementCatalog,
  PathReference,
  TaskRequirementReference,
} from '@specbridge/compat-kiro';
import type { AgentConfig, SelectionMode, WorkspaceInfo } from '@specbridge/core';
import { stateStage } from '@specbridge/core';
import type {
  CommitAncestry,
  EvidenceAssessment,
  EvidenceFreshnessContext,
  TaskEvidenceAssessment,
  TaskEvidenceRecord,
} from '@specbridge/evidence';
import { assessTaskEvidence, listTaskEvidence, resolveCommitAncestry } from '@specbridge/evidence';
import { runSafeProcess } from '@specbridge/runners';
import type { WorkflowEvaluation } from '@specbridge/workflow';
import { evaluateWorkflow } from '@specbridge/workflow';
import type { ComparisonChangedFile, ResolvedComparison } from './comparison.js';
import type { EffectivePolicy } from './policy.js';
import { compilePathMatchers, resolveEffectivePolicy } from './policy.js';
import type { OrchestratedCommands } from './commands.js';

/**
 * Verification context assembly. Each spec is parsed exactly once per run;
 * evidence, traceability, and approval evaluation are computed here and
 * shared read-only by every rule.
 */

export interface SpecEvidenceView {
  assessmentsByTask: Map<string, TaskEvidenceAssessment>;
  /** Every assessment across tasks (for command reuse lookups). */
  flattened: EvidenceAssessment[];
  /** Structurally invalid record files encountered in the store. */
  invalidRecordCount: number;
}

export interface SpecTraceabilityView {
  catalog: RequirementCatalog;
  references: TaskRequirementReference[];
  designPathReferences: PathReference[];
}

export interface SpecVerificationContext {
  workspace: WorkspaceInfo;
  specName: string;
  spec: SpecAnalysis;
  /** How this verification run selected specs (some rules are mode-aware). */
  selectionMode: SelectionMode;
  /** Present when sidecar state exists and validates. */
  evaluation?: WorkflowEvaluation;
  policy: EffectivePolicy;
  comparison: ResolvedComparison;
  /** Every changed file in the comparison. */
  changedFiles: readonly ComparisonChangedFile[];
  /** Changed files relevant to this spec (spec dir, sidecar, impact areas, evidence). */
  specChangedFiles: ComparisonChangedFile[];
  traceability: SpecTraceabilityView;
  evidence: SpecEvidenceView;
  freshness: EvidenceFreshnessContext;
  /** Why the spec was selected in `--changed` mode; empty otherwise. */
  matchedBy: string[];
  /** Content of a file at the comparison base (cached; undefined if absent). */
  readBaseContent: (repoPath: string) => Promise<string | undefined>;
  now: Date;
}

export interface GlobalVerificationContext {
  workspace: WorkspaceInfo;
  comparison: ResolvedComparison;
  selection: { mode: SelectionMode };
  specContexts: SpecVerificationContext[];
  /** Changed files that no spec in the workspace claims (SBV014). */
  unmappedFiles: ComparisonChangedFile[];
  /** Files claimed by more than one spec, with the matching reasons (SBV022). */
  ambiguousFiles: { path: string; specs: { name: string; via: string[] }[] }[];
  commands: OrchestratedCommands;
  now: Date;
}

/* ------------------------------------------------------------------ *
 * Shared caches (per verification run)
 * ------------------------------------------------------------------ */

const GIT_TIMEOUT_MS = 30_000;

export interface RunCaches {
  /** `git show <base>:<path>` content cache. */
  baseContent: Map<string, string | undefined>;
  /** Commit ancestry cache across specs. */
  ancestry: Map<string, CommitAncestry>;
}

export function createRunCaches(): RunCaches {
  return { baseContent: new Map(), ancestry: new Map() };
}

function makeBaseContentReader(
  workspace: WorkspaceInfo,
  comparison: ResolvedComparison,
  caches: RunCaches,
  signal?: AbortSignal,
): (repoPath: string) => Promise<string | undefined> {
  return async (repoPath: string): Promise<string | undefined> => {
    if (caches.baseContent.has(repoPath)) return caches.baseContent.get(repoPath);
    const baseSha = comparison.descriptor.baseSha;
    if (baseSha === null) {
      caches.baseContent.set(repoPath, undefined);
      return undefined;
    }
    const result = await runSafeProcess({
      executable: 'git',
      argv: ['show', `${baseSha}:${repoPath}`],
      cwd: workspace.rootDir,
      timeoutMs: GIT_TIMEOUT_MS,
      maxStdoutBytes: 16 * 1024 * 1024,
      ...(signal !== undefined ? { signal } : {}),
    });
    const content = result.status === 'ok' ? result.stdout : undefined;
    caches.baseContent.set(repoPath, content);
    return content;
  };
}

async function resolveAncestryCached(
  workspace: WorkspaceInfo,
  shas: readonly string[],
  caches: RunCaches,
  signal?: AbortSignal,
): Promise<Map<string, CommitAncestry>> {
  const missing = shas.filter((sha) => !caches.ancestry.has(sha));
  if (missing.length > 0) {
    const resolved = await resolveCommitAncestry(workspace.rootDir, missing, signal);
    for (const [sha, ancestry] of resolved) caches.ancestry.set(sha, ancestry);
  }
  const view = new Map<string, CommitAncestry>();
  for (const sha of shas) {
    const ancestry = caches.ancestry.get(sha);
    if (ancestry !== undefined) view.set(sha, ancestry);
  }
  return view;
}

/* ------------------------------------------------------------------ *
 * Spec-relevance matching (shared with affected-spec resolution)
 * ------------------------------------------------------------------ */

export interface SpecMatchReason {
  file: string;
  via: string;
}

/** Deterministic "does this changed file belong to this spec?" matcher. */
export function specMatchReasons(
  specName: string,
  policy: EffectivePolicy,
  validEvidencePaths: ReadonlySet<string>,
  designPathReferences: readonly PathReference[],
  file: ComparisonChangedFile,
): string[] {
  const reasons: string[] = [];
  const posixPath = file.path;
  if (posixPath.startsWith(`.kiro/specs/${specName}/`)) {
    reasons.push('spec files');
  }
  if (posixPath === `.specbridge/state/specs/${specName}.json`) {
    reasons.push('sidecar state');
  }
  if (posixPath === `.specbridge/policies/${specName}.json`) {
    reasons.push('verification policy');
  }
  if (policy.impactAreas.length > 0) {
    const matched = compilePathMatchers(policy.impactAreas)(posixPath);
    for (const pattern of matched) reasons.push(`impact area ${pattern}`);
  }
  if (validEvidencePaths.has(posixPath)) {
    reasons.push('task evidence');
  }
  for (const reference of designPathReferences) {
    if (!reference.isGlob && reference.path === posixPath) {
      reasons.push('design reference');
      break;
    }
  }
  return reasons;
}

/* ------------------------------------------------------------------ *
 * Evidence loading
 * ------------------------------------------------------------------ */

interface RawSpecEvidence {
  byTask: Map<string, TaskEvidenceRecord[]>;
  invalidRecordCount: number;
}

/** Read every evidence record of a spec exactly once. */
function readSpecEvidenceRecords(workspace: WorkspaceInfo, specName: string): RawSpecEvidence {
  const byTask = new Map<string, TaskEvidenceRecord[]>();
  let invalidRecordCount = 0;
  const specDir = path.join(workspace.sidecarDir, 'evidence', specName);
  if (existsSync(specDir)) {
    const taskDirs = readdirSync(specDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'en'));
    for (const taskDir of taskDirs) {
      const { records, diagnostics } = listTaskEvidence(workspace, specName, taskDir);
      invalidRecordCount += diagnostics.length;
      if (records.length === 0) continue;
      const taskId = records[0]?.taskId ?? taskDir;
      const list = byTask.get(taskId) ?? [];
      list.push(...records);
      byTask.set(taskId, list);
    }
  }
  return { byTask, invalidRecordCount };
}

/* ------------------------------------------------------------------ *
 * Context builders
 * ------------------------------------------------------------------ */

export interface BuildSpecContextOptions {
  workspace: WorkspaceInfo;
  folder: SpecFolder;
  config: AgentConfig;
  comparison: ResolvedComparison;
  selectionMode: SelectionMode;
  caches: RunCaches;
  strict?: boolean;
  explicitPolicyPath?: string;
  matchedBy?: string[];
  now: Date;
  signal?: AbortSignal;
}

export async function buildSpecVerificationContext(
  options: BuildSpecContextOptions,
): Promise<SpecVerificationContext> {
  const { workspace, folder, comparison, caches, now } = options;
  const spec = analyzeSpec(workspace, folder);
  const evaluation = spec.state !== undefined ? evaluateWorkflow(workspace, spec.state) : undefined;

  const policy = resolveEffectivePolicy(workspace, folder.name, {
    globalProtectedPaths: options.config.execution.protectedPaths,
    ...(options.strict !== undefined ? { strict: options.strict } : {}),
    ...(options.explicitPolicyPath !== undefined
      ? { explicitPolicyPath: options.explicitPolicyPath }
      : {}),
  });

  // ---- Traceability (parsed models reused from analyzeSpec) ---------------
  const requirementsDocument = spec.documents.requirements;
  const catalog =
    spec.requirements !== undefined
      ? buildRequirementCatalog(spec.requirements, requirementsDocument)
      : { entries: [], requirements: [], byCanonical: new Map() };
  const tasksDocument = spec.documents.tasks;
  const references =
    tasksDocument !== undefined && spec.tasks !== undefined
      ? extractTaskRequirementReferences(tasksDocument, spec.tasks)
      : [];
  const designDocument = spec.documents.design;
  const designPathReferences =
    designDocument !== undefined ? extractPathReferences(designDocument) : [];

  // ---- Approval identity for evidence freshness ----------------------------
  const approved: EvidenceFreshnessContext['approved'] = {};
  const approvedAt: EvidenceFreshnessContext['approvedAt'] = {};
  if (spec.state !== undefined && evaluation !== undefined) {
    const documentStageName = spec.state.specType === 'bugfix' ? 'bugfix' : 'requirements';
    const documentStage = stateStage(spec.state, documentStageName);
    const designStage = stateStage(spec.state, 'design');
    const tasksStage = stateStage(spec.state, 'tasks');
    if (documentStage?.approvedAt != null) approvedAt.document = documentStage.approvedAt;
    if (designStage?.approvedAt != null) approvedAt.design = designStage.approvedAt;
    if (tasksStage?.approvedAt != null) approvedAt.tasks = tasksStage.approvedAt;

    const effective = (stage: string): boolean =>
      evaluation.stages.find((s) => s.stage === stage)?.effective === 'approved';
    if (effective(documentStageName) && documentStage?.approvedHash != null) {
      approved.documentHash = documentStage.approvedHash;
    }
    if (effective('design') && designStage?.approvedHash != null) {
      approved.designHash = designStage.approvedHash;
    }
    if (effective('tasks') && tasksStage !== undefined) {
      const planHash =
        typeof tasksStage.approvedPlanHash === 'string'
          ? tasksStage.approvedPlanHash
          : tryTaskPlanHashOfFile(
              path.join(workspace.rootDir, tasksStage.file.split('/').join(path.sep)),
            );
      if (planHash !== undefined) approved.tasksPlanHash = planHash;
    }
  }

  const currentTasks = new Map<
    string,
    { fingerprint: string; title: string; rawLineText: string; state: string }
  >();
  if (spec.tasks !== undefined && tasksDocument !== undefined) {
    for (const task of spec.tasks.allTasks) {
      currentTasks.set(task.id, {
        fingerprint: taskFingerprint(task),
        title: task.title,
        rawLineText: tasksDocument.lineAt(task.line).text,
        state: task.state,
      });
    }
  }

  // Read evidence once, resolve commit ancestry (shared cache), then assess.
  const rawEvidence = readSpecEvidenceRecords(workspace, folder.name);
  const freshness: EvidenceFreshnessContext = {
    specName: folder.name,
    approved,
    approvedAt,
    tasks: currentTasks,
    now,
  };
  const recordedShas = new Set<string>();
  for (const records of rawEvidence.byTask.values()) {
    for (const record of records) {
      if (record.repository.headAfter !== undefined) recordedShas.add(record.repository.headAfter);
    }
  }
  if (recordedShas.size > 0 && comparison.descriptor.headSha !== null) {
    freshness.ancestry = await resolveAncestryCached(
      workspace,
      [...recordedShas],
      caches,
      options.signal,
    );
  }

  const assessmentsByTask = new Map<string, TaskEvidenceAssessment>();
  const flattened: EvidenceAssessment[] = [];
  for (const [taskId, records] of rawEvidence.byTask) {
    const assessment = assessTaskEvidence(taskId, records, freshness);
    assessmentsByTask.set(taskId, assessment);
    flattened.push(...assessment.all);
  }
  const evidence: SpecEvidenceView = {
    assessmentsByTask,
    flattened,
    invalidRecordCount: rawEvidence.invalidRecordCount,
  };

  // ---- Spec-relevant changed files -----------------------------------------
  const validEvidencePaths = new Set<string>();
  for (const assessment of evidence.assessmentsByTask.values()) {
    const best = assessment.best;
    if (best === undefined || best.validity !== 'valid') continue;
    for (const file of best.record.changedFiles) validEvidencePaths.add(file.path);
  }
  const specChangedFiles = comparison.changedFiles.filter(
    (file) =>
      specMatchReasons(folder.name, policy, validEvidencePaths, designPathReferences, file)
        .length > 0,
  );

  return {
    workspace,
    specName: folder.name,
    spec,
    selectionMode: options.selectionMode,
    ...(evaluation !== undefined ? { evaluation } : {}),
    policy,
    comparison,
    changedFiles: comparison.changedFiles,
    specChangedFiles,
    traceability: { catalog, references, designPathReferences },
    evidence,
    freshness,
    matchedBy: options.matchedBy ?? [],
    readBaseContent: makeBaseContentReader(workspace, comparison, caches, options.signal),
    now,
  };
}
