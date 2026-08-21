import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { AgentConfig, LocalExecutionMode, WorkspaceInfo } from '@specbridge/core';
import { readAgentConfig, resolveWorkspace } from '@specbridge/core';
import { createDefaultRunnerRegistry, runSafeProcess } from '@specbridge/runners';
import type { Clock } from '@specbridge/workflow';
import { OrchestrationError } from '../errors.js';
import { jobNodeSchema } from '../jobs/state.js';
import type { JobNode } from '../jobs/state.js';
import type { LocalExecutorInference } from './local-execution.js';
import { dispatchLocalExecution } from './local-execution.js';
import type { LocalHarnessExecutionResult } from './local-harness.js';
import { dispatchLocalHarnessExecution } from './local-harness.js';
import { resolveLocalHarnessBinding } from './local-binding.js';

/**
 * Local runtime A/B evaluation (vNext.4 §33–§36).
 *
 * Runs the SAME task through DIRECT_MODEL and HARNESS and reports what
 * actually happened, so "should the adaptive policy prefer the harness for
 * this kind of work?" becomes a measured question rather than an opinion.
 *
 * Two rules make it safe enough to run against a real repository:
 *
 *   1. Every arm gets its own detached git worktree at HEAD. The arms never
 *      share a mutable workspace and never touch the user's working tree,
 *      so a harness that edits files cannot corrupt the comparison — or the
 *      branch the user is standing on.
 *   2. It is EXPLICIT. Production dispatch never runs twice; nothing here is
 *      reachable from the scheduler. Evaluation is a command you run.
 *
 * The comparison metric is trusted evidence, not vibes: an arm "wins" by
 * producing a repository state that SpecBridge's own verification accepts.
 * Metrics the runtime did not report stay null — comparing against a
 * fabricated zero would be worse than comparing against nothing.
 */

const GIT_TIMEOUT_MS = 120_000;

export interface LocalRuntimeEvaluationCase {
  /** Stable id for the case (used in the report and the worktree name). */
  caseId: string;
  specName: string;
  /** The approved task id to implement. */
  taskId: string;
  /** Task title (drives the same classifiers production would use). */
  title: string;
}

export interface LocalRuntimeArmResult {
  caseId: string;
  mode: LocalExecutionMode;
  /**
   * VERIFIED           trusted evidence accepted the result
   * UNVERIFIED         the arm produced changes that verification rejected
   * FAILED             the arm produced no usable attempt
   * UNAVAILABLE        the mode could not run at all (not the model's fault)
   */
  outcome: 'VERIFIED' | 'UNVERIFIED' | 'FAILED' | 'UNAVAILABLE';
  evidenceStatus: string | null;
  wallTimeMs: number;
  /** Files the arm changed in its own isolated checkout. */
  changedFiles: string[];
  /** Changes that touched protected control-plane paths (must be zero). */
  unexpectedFiles: string[];
  /** True when the arm declined or was escalated off the local lane. */
  escalated: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  toolCalls: number | null;
  commandRuns: number | null;
  compactions: number | null;
  failureCategory: string | null;
  detail: string;
}

export interface LocalRuntimeEvaluationReport {
  schemaVersion: string;
  startedAt: string;
  finishedAt: string;
  /** The harness profile the HARNESS arm used, when it ran. */
  harnessProfile: string | null;
  harnessLocality: string | null;
  cases: {
    caseId: string;
    taskId: string;
    arms: LocalRuntimeArmResult[];
  }[];
  summary: {
    mode: LocalExecutionMode;
    arms: number;
    verified: number;
    unverified: number;
    failed: number;
    unavailable: number;
    /** Median wall time across arms that ran. Null when none did. */
    medianWallTimeMs: number | null;
    /** Median changed-file count across arms that ran. */
    medianChangedFiles: number | null;
  }[];
}

export const LOCAL_RUNTIME_EVALUATION_SCHEMA_VERSION = '1.0.0';

export interface LocalRuntimeEvaluationInput {
  /** The canonical workspace. It is READ ONLY for the whole evaluation. */
  workspace: WorkspaceInfo;
  config: AgentConfig;
  cases: readonly LocalRuntimeEvaluationCase[];
  /** Modes to compare (default: both). */
  modes?: readonly LocalExecutionMode[] | undefined;
  /**
   * Structured-inference implementation for the DIRECT arm. Tests inject a
   * deterministic fake; the live benchmark injects the managed local model.
   * Absent means the DIRECT arm reports UNAVAILABLE rather than guessing.
   */
  inference?: LocalExecutorInference | undefined;
  /** Harness profile override; defaults to the LOCAL lane's binding. */
  harnessProfile?: string | undefined;
  maxHarnessWallTimeMs?: number | undefined;
  /** Directory for the isolated checkouts (default: sidecar workspace dir). */
  workRoot?: string | undefined;
  /** Keep the isolated checkouts after the run (debugging). */
  keepWorktrees?: boolean | undefined;
  clock?: Clock | undefined;
  idFactory?: (() => string) | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((message: string) => void) | undefined;
}

/**
 * Control-plane paths an execution arm must never mutate. `.specbridge/` is
 * absent on purpose: the sidecar is SpecBridge's OWN working area (run
 * records, locks, evidence), so its files are never attributed to the arm —
 * exactly as the evidence pipeline excludes it from the agent diff.
 */
const CONTROL_PLANE_PREFIXES = ['.kiro/', '.git/'];

/** Sidecar paths: SpecBridge's own bookkeeping, never an arm's change. */
const SIDECAR_PREFIX = '.specbridge/';

async function git(cwd: string, argv: string[], timeoutMs = GIT_TIMEOUT_MS) {
  const result = await runSafeProcess({
    executable: 'git',
    argv,
    cwd,
    timeoutMs,
    maxStdoutBytes: 8 * 1024 * 1024,
    maxStderrBytes: 1024 * 1024,
  });
  return { ok: result.status === 'ok', stdout: result.stdout, stderr: result.stderr };
}

/**
 * Copy the sidecar state an isolated checkout needs to be a usable
 * workspace: the configuration and the spec approval records. Deliberately
 * narrow — runs, jobs, attempts, and telemetry are NOT copied, so an
 * evaluation can never be mistaken for (or contaminate) real job history.
 */
function seedSidecar(source: WorkspaceInfo, targetRoot: string, specNames: readonly string[]): void {
  const sidecar = path.join(targetRoot, '.specbridge');
  mkdirSync(sidecar, { recursive: true });
  const config = path.join(source.sidecarDir, 'config.json');
  if (existsSync(config)) copyFileSync(config, path.join(sidecar, 'config.json'));
  const stateDir = path.join(source.sidecarDir, 'state', 'specs');
  if (!existsSync(stateDir)) return;
  const targetState = path.join(sidecar, 'state', 'specs');
  mkdirSync(targetState, { recursive: true });
  for (const name of new Set(specNames)) {
    const file = path.join(stateDir, `${name}.json`);
    if (existsSync(file)) copyFileSync(file, path.join(targetState, `${name}.json`));
  }
}

function syntheticNode(evaluationCase: LocalRuntimeEvaluationCase): JobNode {
  return jobNodeSchema.parse({
    nodeId: `eval-${evaluationCase.caseId}`.slice(0, 64),
    parentTaskId: evaluationCase.taskId,
    title: evaluationCase.title,
    taskFingerprint: `eval-${evaluationCase.caseId}`.slice(0, 64),
    status: 'READY',
    planApproved: true,
  });
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const low = sorted[middle - 1];
  const high = sorted[middle];
  return low === undefined || high === undefined ? null : (low + high) / 2;
}

/**
 * Run the evaluation. One isolated checkout per (case, mode); the canonical
 * workspace is never written to.
 */
export async function evaluateLocalRuntime(
  input: LocalRuntimeEvaluationInput,
): Promise<LocalRuntimeEvaluationReport> {
  const clock = input.clock ?? (() => new Date());
  const startedAt = clock().toISOString();
  const modes = input.modes ?? (['DIRECT_MODEL', 'HARNESS'] as const);
  const binding = resolveLocalHarnessBinding(input.config);
  const harnessProfile = input.harnessProfile ?? binding.profileName ?? undefined;
  const workRoot =
    input.workRoot ?? path.join(input.workspace.sidecarDir, 'local-runtime-eval');
  mkdirSync(workRoot, { recursive: true });

  const head = await git(input.workspace.rootDir, ['rev-parse', 'HEAD']);
  if (!head.ok) {
    throw new OrchestrationError(
      'SBO048',
      'Local runtime evaluation needs a readable git HEAD: every arm runs in an isolated checkout of it.',
      {
        remediation: ['Commit the current state, then re-run the evaluation.'],
        failureCategory: 'BLOCKED_DEPENDENCY',
      },
    );
  }
  const baseline = head.stdout.trim();

  const cases: LocalRuntimeEvaluationReport['cases'] = [];
  for (const evaluationCase of input.cases) {
    const arms: LocalRuntimeArmResult[] = [];
    for (const mode of modes) {
      if (input.signal?.aborted === true) break;
      input.onProgress?.(`evaluating ${evaluationCase.caseId} [${mode}]`);
      arms.push(
        await runArm({
          input,
          evaluationCase,
          mode,
          baseline,
          workRoot,
          ...(harnessProfile !== undefined ? { harnessProfile } : {}),
          clock,
        }),
      );
    }
    cases.push({ caseId: evaluationCase.caseId, taskId: evaluationCase.taskId, arms });
  }

  const allArms = cases.flatMap((entry) => entry.arms);
  return {
    schemaVersion: LOCAL_RUNTIME_EVALUATION_SCHEMA_VERSION,
    startedAt,
    finishedAt: clock().toISOString(),
    harnessProfile: harnessProfile ?? null,
    harnessLocality: binding.locality,
    cases,
    summary: modes.map((mode) => {
      const forMode = allArms.filter((arm) => arm.mode === mode);
      const ran = forMode.filter((arm) => arm.outcome !== 'UNAVAILABLE');
      return {
        mode,
        arms: forMode.length,
        verified: forMode.filter((arm) => arm.outcome === 'VERIFIED').length,
        unverified: forMode.filter((arm) => arm.outcome === 'UNVERIFIED').length,
        failed: forMode.filter((arm) => arm.outcome === 'FAILED').length,
        unavailable: forMode.filter((arm) => arm.outcome === 'UNAVAILABLE').length,
        medianWallTimeMs: median(ran.map((arm) => arm.wallTimeMs)),
        medianChangedFiles: median(ran.map((arm) => arm.changedFiles.length)),
      };
    }),
  };
}

async function runArm(options: {
  input: LocalRuntimeEvaluationInput;
  evaluationCase: LocalRuntimeEvaluationCase;
  mode: LocalExecutionMode;
  baseline: string;
  workRoot: string;
  harnessProfile?: string | undefined;
  clock: Clock;
}): Promise<LocalRuntimeArmResult> {
  const { input, evaluationCase, mode, workRoot } = options;
  const armDir = path.join(
    workRoot,
    `${evaluationCase.caseId}-${mode === 'HARNESS' ? 'harness' : 'direct'}`.replace(
      /[^A-Za-z0-9._-]/g,
      '_',
    ),
  );
  const started = Date.now();
  const unavailable = (detail: string): LocalRuntimeArmResult => ({
    caseId: evaluationCase.caseId,
    mode,
    outcome: 'UNAVAILABLE',
    evidenceStatus: null,
    wallTimeMs: 0,
    changedFiles: [],
    unexpectedFiles: [],
    escalated: false,
    inputTokens: null,
    outputTokens: null,
    toolCalls: null,
    commandRuns: null,
    compactions: null,
    failureCategory: null,
    detail,
  });

  if (mode === 'DIRECT_MODEL' && input.inference === undefined) {
    return unavailable('no local inference implementation was provided for the direct arm');
  }
  if (mode === 'HARNESS' && options.harnessProfile === undefined) {
    return unavailable('no harness profile is bound or configured for the harness arm');
  }

  if (existsSync(armDir)) {
    await git(input.workspace.rootDir, ['worktree', 'remove', '--force', armDir]);
    rmSync(armDir, { recursive: true, force: true });
  }
  const added = await git(
    input.workspace.rootDir,
    ['worktree', 'add', '--detach', armDir, options.baseline],
    180_000,
  );
  if (!added.ok) {
    return unavailable(`git worktree add failed: ${added.stderr.slice(0, 300)}`);
  }

  try {
    seedSidecar(input.workspace, armDir, [evaluationCase.specName]);
    const armWorkspace = resolveWorkspace(armDir);
    if (armWorkspace === undefined) {
      return unavailable('the isolated checkout is not a SpecBridge workspace (no .kiro directory)');
    }
    const read = readAgentConfig(armWorkspace);
    const armConfig = read.config ?? input.config;
    const registry = createDefaultRunnerRegistry(armConfig);
    const node = syntheticNode(evaluationCase);

    const result =
      mode === 'HARNESS'
        ? await dispatchLocalHarnessExecution({
            workspace: armWorkspace,
            config: armConfig,
            registry,
            node,
            specName: evaluationCase.specName,
            jobId: `eval-${evaluationCase.caseId}`,
            mode: 'implement',
            allowDirty: false,
            profileName: options.harnessProfile as string,
            maxWallTimeMs: input.maxHarnessWallTimeMs ?? 1_800_000,
            ...(input.idFactory !== undefined ? { idFactory: input.idFactory } : {}),
            ...(input.signal !== undefined ? { signal: input.signal } : {}),
            ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
          })
        : await dispatchLocalExecution({
            workspace: armWorkspace,
            config: armConfig,
            node,
            specName: evaluationCase.specName,
            mode: 'implement',
            allowDirty: false,
            inference: input.inference as LocalExecutorInference,
            ...(input.idFactory !== undefined ? { idFactory: input.idFactory } : {}),
            ...(input.signal !== undefined ? { signal: input.signal } : {}),
            ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
          });

    const status = await git(armDir, ['status', '--porcelain']);
    const touched = status.stdout
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.replace(/\\/g, '/'))
      .filter((entry) => !entry.startsWith(SIDECAR_PREFIX));
    // SpecBridge writes exactly one file under .kiro itself: the task
    // checkbox, and only for verified evidence. Everything else under a
    // control-plane prefix is an arm reaching where it must not.
    const sanctioned = `.kiro/specs/${evaluationCase.specName}/tasks.md`;
    const unexpectedFiles = touched.filter(
      (file) =>
        file !== sanctioned && CONTROL_PLANE_PREFIXES.some((prefix) => file.startsWith(prefix)),
    );
    const changedFiles = touched.filter((file) => file !== sanctioned);
    const verified =
      result.evidenceStatus === 'verified' || result.evidenceStatus === 'manually-accepted';
    const observed: LocalHarnessExecutionResult['observed'] | undefined =
      'observed' in result ? (result as LocalHarnessExecutionResult).observed : undefined;
    return {
      caseId: evaluationCase.caseId,
      mode,
      outcome: verified
        ? 'VERIFIED'
        : result.evidenceStatus !== undefined
          ? 'UNVERIFIED'
          : 'FAILED',
      evidenceStatus: result.evidenceStatus ?? null,
      wallTimeMs: Math.max(0, Date.now() - started),
      changedFiles,
      unexpectedFiles,
      escalated: result.escalated,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      toolCalls: observed?.toolCalls ?? null,
      commandRuns: observed?.commandRuns ?? null,
      compactions: observed?.compactions ?? null,
      failureCategory: result.failure?.category ?? null,
      detail: (result.failure?.message ?? result.evidenceStatus ?? 'completed').slice(0, 500),
    };
  } finally {
    if (input.keepWorktrees !== true) {
      await git(input.workspace.rootDir, ['worktree', 'remove', '--force', armDir]);
      try {
        rmSync(armDir, { recursive: true, force: true });
      } catch {
        // Windows file handles can defer removal; prune reconciles below.
      }
      await git(input.workspace.rootDir, ['worktree', 'prune']);
    }
  }
}

/** Remove leftover evaluation checkouts (crash reconciliation). */
export async function pruneLocalRuntimeEvaluations(
  workspace: WorkspaceInfo,
  workRoot?: string,
): Promise<string[]> {
  const root = workRoot ?? path.join(workspace.sidecarDir, 'local-runtime-eval');
  const removed: string[] = [];
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      await git(workspace.rootDir, ['worktree', 'remove', '--force', dir]);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort; the prune below reconciles the registry.
      }
      removed.push(entry.name);
    }
  }
  await git(workspace.rootDir, ['worktree', 'prune']);
  return removed;
}
