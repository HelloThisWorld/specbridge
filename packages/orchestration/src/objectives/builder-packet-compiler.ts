import { z } from 'zod';
import type { AgentConfig, WorkspaceInfo } from '@specbridge/core';
import { sha256Hex } from '@specbridge/core';
import type {
  ContextExpansionLevel,
  ContextRetrievalQuery,
  ContextSelectionPlan,
  RepositoryContextIndex,
  SelectedContextItem,
} from '@specbridge/context';
import {
  CONTEXT_EXPANSION_LEVELS,
  buildEfficientContext,
  buildRetrievalQuery,
  contextAllocationPolicySchema,
  contextBudgetConfigSchema,
  contextSelectionPlanSchema,
  extractPathReferences,
  extractSymbolReferences,
  rankCandidates,
  refreshRepositoryIndex,
  workspaceKeyFor,
  RepositoryContextIndex as RepositoryContextIndexValue,
} from '@specbridge/context';
import { captureGitSnapshot } from '@specbridge/evidence';
import { ensureRepositoryIndex, indexProtectedPaths } from '../context/index-service.js';
import { writeContextSelectionPlan } from '../context/store.js';
import type { ContextProjection, WorkUnit } from './state.js';
import {
  SECONDARY_BUILDER_LIMITS,
  SECONDARY_BUILDER_SYSTEM_PROMPT,
  buildSecondaryBuilderPacket,
  renderSecondaryBuilderPrompt,
  secondaryBuilderPacketSchema,
  secondaryBuilderPacketMetricsSchema,
  secondaryBuilderPacketQualitySchema,
  secondarySourceContextSchema,
} from './secondary-builder.js';
import type {
  NormalizedSecondarySourceContext,
  SecondaryBuilderPacket,
} from './secondary-builder.js';

/**
 * Phase 5's deterministic compiler:
 *
 * WorkUnit + approved projection + repository-index metadata
 *   -> bounded ranking/structural expansion
 *   -> fresh worktree sections
 *   -> explainable implementation packet
 *
 * It never invokes a model and never gives the eventual model repository
 * authority. The existing context package owns indexing, ranking, section
 * extraction, protected-path exclusion, and freshness checks.
 */

export const BUILDER_PACKET_COMPILATION_SCHEMA_VERSION = '1.0.0';

export const BUILDER_PACKET_COMPILATION_FAILURES = [
  'INSUFFICIENT_CONTEXT',
  'AMBIGUOUS_TARGET',
  'STALE_SOURCE_CONTEXT',
] as const;
export type BuilderPacketCompilationFailureKind =
  (typeof BUILDER_PACKET_COMPILATION_FAILURES)[number];

export interface BuilderRepositoryContext {
  /** Stable repository identity carried into every selected item. */
  repositoryId: string;
  /** Root whose current bytes will be materialized. */
  rootDir: string;
  /** Existing metadata index. Supplying it is the multi-repo/caller seam. */
  index: RepositoryContextIndex;
  /** Paths known to differ from the index baseline. */
  changedPaths?: readonly string[] | undefined;
  /** Whether this metadata came from a reusable index rather than a scan. */
  indexReused?: boolean | undefined;
  /** Explicit justification; required for non-primary repositories. */
  justification?: string | undefined;
}

export interface VerifiedDependencyContextInput {
  workUnitId: string;
  summary: string;
  changedFiles: readonly { repositoryId?: string | undefined; path: string }[];
  exportedSymbols?: readonly string[] | undefined;
  /** Only true dependency candidates are accepted by the compiler. */
  verificationPassed: true;
}

export interface BuilderPacketBudget {
  maxSelectedFiles: number;
  maxTests: number;
  maxReferencePatterns: number;
  maxSourceCharacters: number;
  maxCharactersPerSection: number;
}

export interface BuilderPacketCompilationInput {
  workspace: WorkspaceInfo;
  config: AgentConfig;
  jobId: string;
  objectiveNodeId: string;
  workUnit: WorkUnit;
  projection: ContextProjection;
  attempt: number;
  /** Isolated worktree after verified dependency patches were applied. */
  worktreeRoot: string;
  baselineRef?: string | undefined;
  dependencyContext?: readonly VerifiedDependencyContextInput[] | undefined;
  missingDependencyIds?: readonly string[] | undefined;
  priorFailureEvidence?: readonly string[] | undefined;
  priorRelevantPaths?: readonly string[] | undefined;
  verificationHints?: readonly string[] | undefined;
  repositories?: readonly BuilderRepositoryContext[] | undefined;
  expansionLevel?: ContextExpansionLevel | undefined;
  budget?: Partial<BuilderPacketBudget> | undefined;
  maximumInputCharacters?: number | undefined;
  createdAt?: string | undefined;
  persist?: boolean | undefined;
}

export type BuilderPacketCompilationResult =
  | {
      ok: true;
      schemaVersion: typeof BUILDER_PACKET_COMPILATION_SCHEMA_VERSION;
      packet: SecondaryBuilderPacket;
      plans: ContextSelectionPlan[];
      planRefs: string[];
      metrics: z.infer<typeof secondaryBuilderPacketMetricsSchema>;
      quality: z.infer<typeof secondaryBuilderPacketQualitySchema>;
      repositoryRoots: Readonly<Record<string, string>>;
    }
  | {
      ok: false;
      schemaVersion: typeof BUILDER_PACKET_COMPILATION_SCHEMA_VERSION;
      failure: { kind: BuilderPacketCompilationFailureKind; reasons: string[] };
      plans: ContextSelectionPlan[];
      planRefs: string[];
      metrics: z.infer<typeof secondaryBuilderPacketMetricsSchema>;
      quality: z.infer<typeof secondaryBuilderPacketQualitySchema>;
    };

/** Versioned public shape for durable/tooling validation of compiler output. */
export const builderPacketCompilationResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      schemaVersion: z.literal(BUILDER_PACKET_COMPILATION_SCHEMA_VERSION),
      packet: secondaryBuilderPacketSchema,
      plans: z.array(contextSelectionPlanSchema).max(12),
      planRefs: z.array(z.string().min(1).max(512)).max(12),
      metrics: secondaryBuilderPacketMetricsSchema,
      quality: secondaryBuilderPacketQualitySchema,
      repositoryRoots: z.record(z.string().min(1)),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      schemaVersion: z.literal(BUILDER_PACKET_COMPILATION_SCHEMA_VERSION),
      failure: z
        .object({
          kind: z.enum(BUILDER_PACKET_COMPILATION_FAILURES),
          reasons: z.array(z.string().min(1).max(2_000)).min(1).max(8),
        })
        .strict(),
      plans: z.array(contextSelectionPlanSchema).max(12),
      planRefs: z.array(z.string().min(1).max(512)).max(12),
      metrics: secondaryBuilderPacketMetricsSchema,
      quality: secondaryBuilderPacketQualitySchema,
    })
    .strict(),
]);

export interface BuilderPacketCompiler {
  compile(input: BuilderPacketCompilationInput): Promise<BuilderPacketCompilationResult>;
}

export class SecondaryBuilderContextCompiler implements BuilderPacketCompiler {
  compile(input: BuilderPacketCompilationInput): Promise<BuilderPacketCompilationResult> {
    return compileSecondaryBuilderPacket(input);
  }
}

interface PreparedRepository {
  repositoryId: string;
  rootDir: string;
  index: RepositoryContextIndex;
  changedPaths: string[];
  indexReused: boolean;
  staleMetadataPaths: string[];
}

interface LocatedTarget {
  repositoryId: string;
  path: string;
  symbols: string[];
}

interface PreparedRetrieval {
  repository: PreparedRepository;
  query: ContextRetrievalQuery;
  preliminary: ReturnType<typeof rankCandidates>;
}

const defaultBudget: BuilderPacketBudget = {
  maxSelectedFiles: SECONDARY_BUILDER_LIMITS.maxSourceFiles,
  maxTests: SECONDARY_BUILDER_LIMITS.maxTests,
  maxReferencePatterns: SECONDARY_BUILDER_LIMITS.maxReferencePatterns,
  maxSourceCharacters: SECONDARY_BUILDER_LIMITS.maxSourceBytes,
  maxCharactersPerSection: SECONDARY_BUILDER_LIMITS.maxSourceFileChars,
};

function boundedBudget(input: BuilderPacketCompilationInput): BuilderPacketBudget {
  const supplied = input.budget ?? {};
  return {
    maxSelectedFiles: Math.max(
      1,
      Math.min(SECONDARY_BUILDER_LIMITS.maxSourceFiles, supplied.maxSelectedFiles ?? defaultBudget.maxSelectedFiles),
    ),
    maxTests: Math.max(0, Math.min(SECONDARY_BUILDER_LIMITS.maxTests, supplied.maxTests ?? defaultBudget.maxTests)),
    maxReferencePatterns: Math.max(
      0,
      Math.min(
        SECONDARY_BUILDER_LIMITS.maxReferencePatterns,
        supplied.maxReferencePatterns ?? defaultBudget.maxReferencePatterns,
      ),
    ),
    maxSourceCharacters: Math.max(
      1_000,
      Math.min(SECONDARY_BUILDER_LIMITS.maxSourceBytes, supplied.maxSourceCharacters ?? defaultBudget.maxSourceCharacters),
    ),
    maxCharactersPerSection: Math.max(
      500,
      Math.min(
        SECONDARY_BUILDER_LIMITS.maxSourceFileChars,
        supplied.maxCharactersPerSection ?? defaultBudget.maxCharactersPerSection,
      ),
    ),
  };
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80) || 'repository';
}

function nowIso(input: BuilderPacketCompilationInput): string {
  return input.createdAt ?? new Date().toISOString();
}

async function prepareRepositories(
  input: BuilderPacketCompilationInput,
  createdAt: string,
): Promise<PreparedRepository[]> {
  if (input.repositories !== undefined) {
    const seen = new Set<string>();
    return input.repositories.map((repository, position) => {
      if (seen.has(repository.repositoryId)) {
        throw new Error(`duplicate repository identity ${repository.repositoryId}`);
      }
      seen.add(repository.repositoryId);
      if (
        position > 0 &&
        repository.repositoryId !== 'primary' &&
        (repository.justification === undefined || repository.justification.trim() === '')
      ) {
        throw new Error(`secondary repository ${repository.repositoryId} needs an explicit justification`);
      }
      return {
        repositoryId: repository.repositoryId,
        rootDir: repository.rootDir,
        index: repository.index,
        changedPaths: unique((repository.changedPaths ?? []).map(normalizePath)),
        indexReused: repository.indexReused ?? true,
        staleMetadataPaths: [],
      };
    });
  }

  // Reuse the canonical metadata index, then overlay only the paths whose
  // bytes differ in the isolated builder baseline. This is the important
  // performance/correctness combination: no per-attempt repository scan,
  // but dependency-patched declarations/imports are current before ranking.
  const canonicalSnapshot = await captureGitSnapshot(input.workspace.rootDir);
  const base = ensureRepositoryIndex({
    workspace: input.workspace,
    config: input.config,
    now: createdAt,
    gitSnapshot: canonicalSnapshot,
  });
  const worktreeSnapshot = await captureGitSnapshot(input.worktreeRoot);
  const dependencyPaths = (input.dependencyContext ?? []).flatMap((dependency) =>
    dependency.changedFiles
      .filter((file) => (file.repositoryId ?? 'primary') === 'primary')
      .map((file) => normalizePath(file.path)),
  );
  const changedPaths = unique([
    ...canonicalSnapshot.entries.map((entry) => normalizePath(entry.path)),
    ...worktreeSnapshot.entries.map((entry) => normalizePath(entry.path)),
    ...dependencyPaths,
  ]);
  const policy = input.config.orchestration.jobs.context.efficiency;
  const overlaid = refreshRepositoryIndex(
    { ...base.state, workspaceKey: workspaceKeyFor(input.worktreeRoot) },
    {
      rootDir: input.worktreeRoot,
      now: createdAt,
      protectedPaths: indexProtectedPaths(input.config),
      respectGitignore: policy.respectGitignore,
      maxEntries: policy.maxIndexedFiles,
      maxFileBytes: policy.maxIndexedFileBytes,
      baselineRef: input.baselineRef ?? worktreeSnapshot.head ?? base.state.baselineRef,
      changedPaths,
    },
  );
  return [
    {
      repositoryId: 'primary',
      rootDir: input.worktreeRoot,
      index: new RepositoryContextIndexValue(overlaid.state),
      changedPaths,
      indexReused: true,
      staleMetadataPaths: overlaid.refreshedPaths,
    },
  ];
}

function workUnitText(input: BuilderPacketCompilationInput): string {
  return [
    input.workUnit.title,
    input.workUnit.goal,
    ...input.workUnit.expectedArtifacts,
    ...input.workUnit.expectedAreas,
  ].join('\n');
}

function pathRepoHint(reference: string, repositoryId: string): boolean {
  const lower = reference.toLowerCase();
  const repo = repositoryId.toLowerCase();
  return lower.startsWith(`${repo}:`) || lower.startsWith(`${repo}/`);
}

function areaScore(input: BuilderPacketCompilationInput, repositoryId: string, candidatePath: string): number {
  const haystack = `${repositoryId}/${candidatePath}`.toLowerCase();
  return input.workUnit.expectedAreas.reduce((score, area) => {
    const normalized = normalizePath(area).toLowerCase().replace(/^[^:]+:/, '');
    return score + (normalized.length >= 2 && haystack.includes(normalized) ? 1 : 0);
  }, 0);
}

function chooseUnique<T extends { repositoryId: string; path: string }>(
  input: BuilderPacketCompilationInput,
  candidates: readonly T[],
  reference: string,
): { value?: T; ambiguous: boolean } {
  if (candidates.length === 0) return { ambiguous: false };
  if (candidates.length === 1) return { value: candidates[0] as T, ambiguous: false };
  const hinted = candidates.filter((candidate) => pathRepoHint(reference, candidate.repositoryId));
  if (hinted.length === 1) return { value: hinted[0] as T, ambiguous: false };
  const scored = candidates
    .map((candidate) => ({ candidate, score: areaScore(input, candidate.repositoryId, candidate.path) }))
    .sort((left, right) => right.score - left.score);
  if ((scored[0]?.score ?? 0) > (scored[1]?.score ?? 0)) {
    return { value: scored[0]!.candidate, ambiguous: false };
  }
  return { ambiguous: true };
}

function locateExplicitTargets(
  input: BuilderPacketCompilationInput,
  repositories: readonly PreparedRepository[],
): { targets: LocatedTarget[]; missing: string[]; ambiguous: string[]; explicitEvidence: boolean } {
  const text = workUnitText(input);
  const references = unique(extractPathReferences(text).map(normalizePath));
  const symbols = unique(extractSymbolReferences(text));
  const targets = new Map<string, LocatedTarget>();
  const missing: string[] = [];
  const ambiguous: string[] = [];

  for (const reference of references) {
    const located: LocatedTarget[] = [];
    for (const repository of repositories) {
      const repoPrefix = `${repository.repositoryId}:`;
      const withoutRepo = reference.startsWith(repoPrefix) ? reference.slice(repoPrefix.length) : reference;
      const exact = repository.index.get(withoutRepo);
      const paths = exact !== undefined
        ? [exact.path]
        : withoutRepo.includes('/')
          ? []
          : repository.index.namedExactly(withoutRepo);
      for (const candidatePath of paths) {
        const entry = repository.index.get(candidatePath);
        if (entry !== undefined) {
          located.push({ repositoryId: repository.repositoryId, path: entry.path, symbols: entry.symbols.slice(0, 12) });
        }
      }
    }
    const selected = chooseUnique(input, located, reference);
    if (selected.ambiguous) ambiguous.push(reference);
    else if (selected.value !== undefined) {
      targets.set(`${selected.value.repositoryId}:${selected.value.path}`, selected.value);
    } else {
      missing.push(reference);
    }
  }

  for (const symbol of symbols) {
    const located: LocatedTarget[] = [];
    for (const repository of repositories) {
      for (const candidatePath of repository.index.declaring(symbol)) {
        const entry = repository.index.get(candidatePath);
        if (entry !== undefined) {
          located.push({ repositoryId: repository.repositoryId, path: entry.path, symbols: [symbol] });
        }
      }
    }
    if (located.length === 0) continue;
    const alreadyBound = located.find((candidate) =>
      targets.has(`${candidate.repositoryId}:${candidate.path}`),
    );
    const selected = alreadyBound === undefined ? chooseUnique(input, located, symbol) : { value: alreadyBound, ambiguous: false };
    if (selected.ambiguous) ambiguous.push(symbol);
    else if (selected.value !== undefined) {
      const key = `${selected.value.repositoryId}:${selected.value.path}`;
      const previous = targets.get(key);
      targets.set(key, {
        ...selected.value,
        symbols: unique([...(previous?.symbols ?? []), symbol]).slice(0, 12),
      });
    }
  }

  // A named existing implementation is a target. A missing path may be a
  // CREATE artifact only when the WorkUnit actually says so.
  const createsNewArtifact = /\b(create|introduce|new file|add file)\b/i.test(text);
  return {
    targets: [...targets.values()],
    missing: createsNewArtifact ? [] : missing,
    ambiguous,
    explicitEvidence: references.length > 0 || symbols.length > 0,
  };
}

function queryFor(
  input: BuilderPacketCompilationInput,
  repository: PreparedRepository,
  targets: readonly LocatedTarget[],
  expansionLevel: ContextExpansionLevel,
): ContextRetrievalQuery {
  const dependencyPaths = (input.dependencyContext ?? []).flatMap((dependency) =>
    dependency.changedFiles
      .filter((file) => (file.repositoryId ?? 'primary') === repository.repositoryId)
      .map((file) => normalizePath(file.path)),
  );
  const approved = input.projection.contracts.flatMap((contract) => [
    contract.title,
    contract.summary,
    ...contract.requirements,
    ...contract.invariants,
  ]);
  const query = buildRetrievalQuery({
    taskId: input.workUnit.parentTaskId,
    nodeId: input.objectiveNodeId,
    attemptId: `${input.workUnit.workUnitId}-a${input.attempt}-secondary`,
    role: 'EXECUTOR',
    contract: [
      ...input.workUnit.expectedArtifacts,
      ...input.workUnit.expectedAreas,
      ...input.workUnit.relevantContractIds,
      ...approved,
    ].join('\n'),
    objective: `${input.workUnit.title}\n${input.workUnit.goal}`,
    acceptanceCriteria: input.projection.objective.acceptance,
    currentAction: [
      input.workUnit.goal,
      ...targets.filter((target) => target.repositoryId === repository.repositoryId).map((target) => target.path),
    ].join('\n'),
    failureText: (input.priorFailureEvidence ?? []).join('\n').slice(0, 20_000),
    changedPaths: dependencyPaths,
    checkpointChangedPaths: dependencyPaths,
    priorRelevantPaths: input.priorRelevantPaths,
    expansionLevel,
  });
  query.actionPaths = unique([
    ...targets.filter((target) => target.repositoryId === repository.repositoryId).map((target) => target.path),
    ...query.actionPaths,
  ]);
  return query;
}

function contextBudget(input: BuilderPacketCompilationInput) {
  const characterCeiling = Math.min(
    SECONDARY_BUILDER_LIMITS.maxPacketCharacters,
    input.maximumInputCharacters ?? SECONDARY_BUILDER_LIMITS.maxPacketCharacters,
  );
  return contextBudgetConfigSchema.parse({
    modelContextTokens: Math.max(1_000, Math.floor(characterCeiling / 4)),
    reservedOutputTokens: 0,
    reservedReasoningTokens: 0,
    reservedGrowthTokens: 0,
  });
}

function itemFor(
  planEntry: SelectedContextItem,
  result: Awaited<ReturnType<typeof buildEfficientContext>>,
) {
  return result.assembled.package.items.find(
    (item) => item.provenance?.path === planEntry.path && item.layer === 'WORKING_SET',
  );
}

function sectionFrom(
  repository: PreparedRepository,
  selected: SelectedContextItem,
  content: string,
): NormalizedSecondarySourceContext {
  const entry = repository.index.get(selected.path);
  return secondarySourceContextSchema.parse({
    repositoryId: repository.repositoryId,
    path: selected.path,
    contentHash: selected.contentHash,
    sectionHash: sha256Hex(content),
    content,
    reason: selected.reason,
    ...(selected.startLine !== undefined ? { startLine: selected.startLine } : {}),
    ...(selected.endLine !== undefined ? { endLine: selected.endLine } : {}),
    symbols: unique([
      ...(selected.symbol !== undefined ? [selected.symbol] : []),
      ...(entry?.symbols ?? []),
    ]).slice(0, 12),
  });
}

function priority(
  targetKeys: ReadonlySet<string>,
  repositoryId: string,
  selected: SelectedContextItem,
  kind: string | undefined,
): number {
  if (targetKeys.has(`${repositoryId}:${selected.path}`)) return 0;
  if (selected.reason === 'EXPLICIT_FAILURE_REFERENCE') return 1;
  if (kind === 'test') return 2;
  if (selected.reason === 'DEPENDENCY_PROXIMITY') return 3;
  if (selected.reason === 'REFERENCE_PATTERN') return 4;
  return 5;
}

function pairedTestMatches(testPath: string, targetPath: string): boolean {
  const stem = (value: string): string =>
    value
      .split('/')
      .at(-1)!
      .replace(/\.(?:test|spec)\.[^.]+$/, '')
      .replace(/\.[^.]+$/, '')
      .replace(/(?:[-_.]?(?:test|tests|spec))$/i, '')
      .toLowerCase();
  if (stem(testPath) !== stem(targetPath)) return false;
  const meaningfulDirs = (value: string): string[] =>
    value
      .split('/')
      .slice(0, -1)
      .map((part) => part.toLowerCase())
      .filter((part) => !['src', 'test', 'tests', '__tests__'].includes(part));
  const targetDirs = meaningfulDirs(targetPath);
  if (targetDirs.length === 0) return true;
  const testDirs = new Set(meaningfulDirs(testPath));
  return targetDirs.some((part) => testDirs.has(part));
}

/** Compile one implementation-ready packet without inference or verification. */
export async function compileSecondaryBuilderPacket(
  input: BuilderPacketCompilationInput,
): Promise<BuilderPacketCompilationResult> {
  const startedAt = Date.now();
  const createdAt = nowIso(input);
  const budget = boundedBudget(input);
  const expansionLevel = input.expansionLevel ?? 'ADJACENT_DEPENDENCIES';
  const expansionDepth = CONTEXT_EXPANSION_LEVELS.indexOf(expansionLevel);
  const repositories = await prepareRepositories(input, createdAt);
  const located = locateExplicitTargets(input, repositories);
  const prepared: PreparedRetrieval[] = repositories.map((repository) => {
    const query = queryFor(input, repository, located.targets, expansionLevel);
    return { repository, query, preliminary: rankCandidates(repository.index, query) };
  });

  let targets = [...located.targets];
  const ambiguity = [...located.ambiguous];
  if (targets.length === 0 && located.missing.length === 0) {
    const plausible = prepared
      .flatMap((entry) =>
        entry.preliminary
          .filter((candidate) => candidate.entry.kind === 'source' || candidate.entry.kind === 'config')
          .slice(0, 2)
          .map((candidate) => ({ repository: entry.repository, candidate })),
      )
      .sort((left, right) =>
        right.candidate.score !== left.candidate.score
          ? right.candidate.score - left.candidate.score
          : `${left.repository.repositoryId}:${left.candidate.path}`.localeCompare(
              `${right.repository.repositoryId}:${right.candidate.path}`,
            ),
      );
    if (
      plausible[0] !== undefined &&
      plausible[1] !== undefined &&
      plausible[0].candidate.score === plausible[1].candidate.score &&
      plausible[0].candidate.entry.module !== plausible[1].candidate.entry.module
    ) {
      ambiguity.push(
        `${plausible[0].repository.repositoryId}:${plausible[0].candidate.path} or ${plausible[1].repository.repositoryId}:${plausible[1].candidate.path}`,
      );
    } else if (plausible[0] !== undefined) {
      targets = [
        {
          repositoryId: plausible[0].repository.repositoryId,
          path: plausible[0].candidate.path,
          symbols: plausible[0].candidate.entry.symbols.slice(0, 12),
        },
      ];
      const matching = prepared.find(
        (entry) => entry.repository.repositoryId === plausible[0]?.repository.repositoryId,
      );
      if (matching !== undefined) {
        matching.query.actionPaths = unique([plausible[0].candidate.path, ...matching.query.actionPaths]);
      }
    }
  }

  const policy = input.config.orchestration.jobs.context.efficiency;
  const allocationPolicy = contextAllocationPolicySchema.parse({
    pinnedReserveRatio: policy.pinnedReserveRatio,
    durableReserveRatio: policy.durableReserveRatio,
    recoveryReserveRatio: policy.recoveryReserveRatio,
    deltaReserveRatio: policy.deltaReserveRatio,
    workingSetMaxRatio: policy.workingSetMaxRatio,
    pointerShapeWorkingSetMaxRatio: policy.pointerShapeWorkingSetMaxRatio,
    maxSingleItemRatio: policy.maxSingleItemRatio,
  });
  const results: {
    repository: PreparedRepository;
    result: Awaited<ReturnType<typeof buildEfficientContext>>;
  }[] = [];
  for (const entry of prepared) {
    const planId = [
      'builder',
      safeId(input.objectiveNodeId),
      safeId(input.workUnit.workUnitId),
      `a${input.attempt}`,
      safeId(entry.repository.repositoryId),
      safeId(expansionLevel.toLowerCase()),
    ].join('-').slice(0, 120);
    const result = await buildEfficientContext({
      strategy: 'SELECTIVE',
      shape: 'MATERIALIZED',
      expansionLevel,
      canonicalItems: [],
      budget: contextBudget(input),
      allocationPolicy,
      createdAt,
      planId,
      taskId: input.workUnit.parentTaskId,
      jobId: input.jobId,
      nodeId: input.objectiveNodeId,
      attemptId: `${input.workUnit.workUnitId}-a${input.attempt}-secondary`,
      executionLane: 'LOCAL',
      executionMode: 'DIRECT_MODEL',
      runner: 'secondary-objective-builder',
      index: entry.repository.index,
      rootDir: entry.repository.rootDir,
      query: entry.query,
      rankOptions: {
        maxCandidates: policy.maxCandidates,
        excludedPaths: indexProtectedPaths(input.config),
      },
      sectionOptions: {
        wholeFileUnderChars: Math.min(policy.wholeFileUnderChars, budget.maxCharactersPerSection),
        targetSectionChars: Math.min(policy.targetSectionChars, budget.maxCharactersPerSection),
      },
      maxSelectedItems: budget.maxSelectedFiles,
      maxPointers: 0,
    });
    results.push({ repository: entry.repository, result });
  }

  const targetKeys = new Set(targets.map((target) => `${target.repositoryId}:${target.path}`));
  const selectedSections = results
    .flatMap(({ repository, result }) =>
      result.plan.selectedWorkingItems.flatMap((selected) => {
        const selectedKey = `${repository.repositoryId}:${selected.path}`;
        const entryKind = repository.index.get(selected.path)?.kind;
        if (
          targetKeys.size > 0 &&
          !targetKeys.has(selectedKey) &&
          (selected.reason === 'TOKEN_OVERLAP' || selected.reason === 'MODULE_PROXIMITY')
        ) {
          return [];
        }
        if (selected.reason === 'TEST_SOURCE_PAIR' && !targetKeys.has(selectedKey)) {
          if (entryKind !== 'test') return [];
          const matchesTarget = targets.some(
            (target) =>
              target.repositoryId === repository.repositoryId &&
              (repository.index.testsFor(target.path).includes(selected.path) ||
                repository.index.sourcesFor(selected.path).includes(target.path) ||
                pairedTestMatches(selected.path, target.path)),
          );
          if (!matchesTarget) return [];
        }
        const item = itemFor(selected, result);
        if (item === undefined || item.content.length > budget.maxCharactersPerSection) return [];
        return [
          {
            repository,
            selected,
            kind: entryKind,
            section: sectionFrom(repository, selected, item.content),
          },
        ];
      }),
    )
    .sort((left, right) => {
      const leftPriority = priority(targetKeys, left.repository.repositoryId, left.selected, left.kind);
      const rightPriority = priority(targetKeys, right.repository.repositoryId, right.selected, right.kind);
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      return right.selected.score - left.selected.score;
    });

  const sourceContext: NormalizedSecondarySourceContext[] = [];
  const tests: NormalizedSecondarySourceContext[] = [];
  const referencePatterns: NormalizedSecondarySourceContext[] = [];
  let usedCharacters = 0;
  let selectedFileCount = 0;
  for (const selected of selectedSections) {
    // This capability-neutral file bound applies across all repositories,
    // not once per repository. A target that cannot fit is reported as
    // insufficient below instead of silently expanding the packet ceiling.
    if (selectedFileCount >= budget.maxSelectedFiles) continue;
    if (usedCharacters + selected.section.content.length > budget.maxSourceCharacters) continue;
    if (selected.kind === 'test') {
      if (tests.length >= budget.maxTests) continue;
      tests.push(selected.section);
    } else if (selected.selected.reason === 'REFERENCE_PATTERN') {
      if (referencePatterns.length >= budget.maxReferencePatterns) continue;
      referencePatterns.push(selected.section);
    } else {
      sourceContext.push(selected.section);
    }
    usedCharacters += selected.section.content.length;
    selectedFileCount += 1;
  }

  const selectedKeys = new Set(
    [...sourceContext, ...tests, ...referencePatterns].map(
      (section) => `${section.repositoryId}:${section.path}`,
    ),
  );
  const unresolvedTargets = targets.filter(
    (target) => !selectedKeys.has(`${target.repositoryId}:${target.path}`),
  );
  const dependencyContext = (input.dependencyContext ?? [])
    .filter((dependency) => dependency.verificationPassed)
    .slice(0, SECONDARY_BUILDER_LIMITS.maxDependencyContext)
    .map((dependency) => ({
      workUnitId: dependency.workUnitId,
      summary: dependency.summary.slice(0, 2_000),
      changedFiles: dependency.changedFiles.slice(0, 60).map((file) => ({
        repositoryId: file.repositoryId ?? 'primary',
        path: normalizePath(file.path),
      })),
      exportedSymbols: [...(dependency.exportedSymbols ?? [])].slice(0, 30),
      verificationPassed: true as const,
    }));
  const missingDependencies = [...(input.missingDependencyIds ?? [])];
  const sourceCharacters = sourceContext.reduce((sum, section) => sum + section.content.length, 0);
  const testCharacters = tests.reduce((sum, section) => sum + section.content.length, 0);
  const planRefs = results.map(({ result }) => `context/plans/${result.plan.planId}`);
  const metrics = secondaryBuilderPacketMetricsSchema.parse({
    indexedFilesConsidered: repositories.reduce((sum, repository) => sum + repository.index.size, 0),
    candidateCount: results.reduce((sum, entry) => sum + entry.result.deterministicCandidates.length, 0),
    selectedFiles: sourceContext.length + tests.length + referencePatterns.length,
    selectedSections: [...sourceContext, ...tests, ...referencePatterns].filter(
      (section) => section.startLine !== undefined,
    ).length,
    sourceCharacters,
    testCharacters,
    referencePatternCount: referencePatterns.length,
    dependencyContextCount: dependencyContext.length,
    budgetUtilization: usedCharacters / budget.maxSourceCharacters,
    mandatoryRefsRetained: targets.length - unresolvedTargets.length,
    expansionDepth,
    staleEntriesEncountered:
      results.reduce((sum, entry) => sum + entry.result.refreshedPaths.length, 0) +
      repositories.reduce((sum, repository) => sum + repository.staleMetadataPaths.length, 0),
    selectionDurationMs: Math.max(0, Date.now() - startedAt),
    indexReused: repositories.every((repository) => repository.indexReused),
  });
  const failureReasons = [
    ...located.missing.map((reference) => `explicit target ${reference} was not found`),
    ...unresolvedTargets.map(
      (target) => `target ${target.repositoryId}:${target.path} could not be materialized within policy`,
    ),
    ...missingDependencies.map((dependency) => `verified dependency evidence for ${dependency} is missing`),
    ...(sourceContext.length === 0 ? ['no implementable source target was selected'] : []),
  ];
  const contextSufficient = ambiguity.length === 0 && failureReasons.length === 0;
  const quality = secondaryBuilderPacketQualitySchema.parse({
    explicitTargetResolved: located.explicitEvidence && located.missing.length === 0 && targets.length > 0,
    targetAmbiguity: ambiguity.length > 0,
    testsFound: tests.length > 0,
    verificationHintsAvailable: (input.verificationHints?.length ?? 0) > 0,
    referencePatternFound: referencePatterns.length > 0,
    dependencyContextComplete: missingDependencies.length === 0,
    sourceBudgetUtilization: usedCharacters / budget.maxSourceCharacters,
    contextSufficient,
  });

  let plans = results.map(({ repository, result }) => {
      const delivered = new Set(
        [...sourceContext, ...tests, ...referencePatterns]
          .filter((section) => section.repositoryId === repository.repositoryId)
          .map((section) => section.path),
      );
      const dropped = result.plan.selectedWorkingItems.filter((entry) => !delivered.has(entry.path));
      return contextSelectionPlanSchema.parse({
        ...result.plan,
        repositoryId: repository.repositoryId,
        selectedWorkingItems: result.plan.selectedWorkingItems
          .filter((entry) => delivered.has(entry.path))
          .map((entry) => ({ ...entry, repositoryId: repository.repositoryId })),
        pointers: result.plan.pointers.map((entry) => ({ ...entry, repositoryId: repository.repositoryId })),
        excludedCandidates: [
          ...result.plan.excludedCandidates.map((entry) => ({
            ...entry,
            repositoryId: repository.repositoryId,
          })),
          ...dropped.map((entry) => ({
            repositoryId: repository.repositoryId,
            path: entry.path,
            reason: 'RANKED_BELOW_CUTOFF' as const,
            score: entry.score,
            detail: 'excluded by Builder Packet category or character budget',
          })),
        ].slice(0, 200),
        builderPacket: quality,
      });
  });
  const persistPlans = (): void => {
    if (input.persist !== false) {
      for (const plan of plans) writeContextSelectionPlan(input.workspace, plan);
    }
  };

  if (ambiguity.length > 0) {
    persistPlans();
    return {
      ok: false,
      schemaVersion: BUILDER_PACKET_COMPILATION_SCHEMA_VERSION,
      failure: {
        kind: 'AMBIGUOUS_TARGET',
        reasons: ambiguity.slice(0, 8).map((entry) => `equally plausible target: ${entry}`),
      },
      plans,
      planRefs,
      metrics,
      quality,
    };
  }
  if (!contextSufficient) {
    persistPlans();
    return {
      ok: false,
      schemaVersion: BUILDER_PACKET_COMPILATION_SCHEMA_VERSION,
      failure: { kind: 'INSUFFICIENT_CONTEXT', reasons: failureReasons.slice(0, 8) },
      plans,
      planRefs,
      metrics,
      quality,
    };
  }

  let packet: SecondaryBuilderPacket;
  try {
    packet = buildSecondaryBuilderPacket({
      projection: input.projection,
      sourceContext,
      targets: targets.map((target) => {
        const selected = [...sourceContext, ...tests, ...referencePatterns].find(
          (section) => section.repositoryId === target.repositoryId && section.path === target.path,
        );
        return {
          repositoryId: target.repositoryId,
          path: target.path,
          symbols: target.symbols,
          reason: selected?.reason ?? 'EXPLICIT_ACTION_REFERENCE',
        };
      }),
      tests,
      referencePatterns,
      dependencyContext,
      priorFailureEvidence: (input.priorFailureEvidence ?? []).map((entry) => entry.slice(0, 2_000)).slice(0, 20),
      verificationHints: (input.verificationHints ?? []).map((hint) => hint.slice(0, 1_000)).slice(0, 30),
      retrievalPlanRefs: planRefs,
      expansionLevel,
      contextMetrics: metrics,
      quality,
      createdAt,
    });
    const inputCharacters = SECONDARY_BUILDER_SYSTEM_PROMPT.length + renderSecondaryBuilderPrompt(packet).length;
    const inputCeiling = input.maximumInputCharacters ?? SECONDARY_BUILDER_LIMITS.maxPacketCharacters;
    if (inputCharacters > inputCeiling) {
      throw new Error(`compiled input is ${inputCharacters} characters; limit is ${inputCeiling}`);
    }
  } catch (cause) {
    const insufficientQuality = secondaryBuilderPacketQualitySchema.parse({
      ...quality,
      contextSufficient: false,
    });
    plans = plans.map((plan) => contextSelectionPlanSchema.parse({
      ...plan,
      builderPacket: insufficientQuality,
    }));
    persistPlans();
    return {
      ok: false,
      schemaVersion: BUILDER_PACKET_COMPILATION_SCHEMA_VERSION,
      failure: {
        kind: 'INSUFFICIENT_CONTEXT',
        reasons: [`packet assembly could not fit within policy: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 2_000)],
      },
      plans,
      planRefs,
      metrics,
      quality: insufficientQuality,
    };
  }
  persistPlans();
  return {
    ok: true,
    schemaVersion: BUILDER_PACKET_COMPILATION_SCHEMA_VERSION,
    packet,
    plans,
    planRefs,
    metrics,
    quality,
    repositoryRoots: Object.fromEntries(
      repositories.map((repository) => [repository.repositoryId, repository.rootDir]),
    ),
  };
}
