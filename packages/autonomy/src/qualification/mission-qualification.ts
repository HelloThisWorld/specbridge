import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { VerificationCommand, WorkspaceInfo } from '@specbridge/core';
import { runVerificationCommands } from '@specbridge/evidence';
import { runSafeProcess } from '@specbridge/runners';
import {
  collectWorktreeChanges,
  createWorkerWorktree,
  recordJobEvent,
  removeWorkerWorktree,
  runLargeObjectiveRole,
  runWorktreeVerification,
} from '@specbridge/orchestration';
import type { AutonomyDeps } from '../deps.js';
import { autonomyPolicyOf, jobDepsOf, newRecordId, nowIso } from '../deps.js';
import { autonomyPath, listJsonRecords } from '../store.js';
import { environmentPlanSchema } from '../environment/state.js';
import type { EnvironmentRuntime } from '../environment/service.js';
import type { ProbeExecutor } from '../environment/probe-runner.js';
import type { BrowserDriver } from '../browser/contract.js';
import { listBrowserScenarios } from '../browser/service.js';
import type { GapWorkItem } from '../closure/state.js';
import {
  advanceClosurePhase,
  readClosureLedger,
  registerClosureEvidence,
} from '../closure/service.js';
import { isClosingStatus } from '../vocabulary.js';
import type { SystemScenario } from './system-scenario.js';
import { listSystemScenarios, runSystemScenario, saveSystemScenario } from './system-scenario.js';
import type { ReproducibilityStep } from './reproducibility.js';
import { runReproducibilityQualification } from './reproducibility.js';

/**
 * Mission-level qualification: the EXECUTORS behind the closure ladder.
 *
 * This module exists because of defect 39 of the vNext.10.1 dogfood. The
 * closure oracle asked for system scenarios, a release qualification, and a
 * reproducibility run — and the runtime answered each request by stamping
 * the phase onto the ledger and moving on. The counters said the phases
 * happened; nothing had ever run. `reproducibilityPassed: false` on a
 * COMPLETED job was the tell.
 *
 * The rule this module enforces everywhere: a phase advances the ledger only
 * from the code path that actually executed it, and every recorded cycle is
 * an EXECUTED cycle. There is no entry point that moves a counter without
 * running the thing the counter counts.
 */

// ---------------------------------------------------------------------------
// Scenario synthesis
// ---------------------------------------------------------------------------

export interface EnsureScenariosResult {
  /** Scenarios covering the open scenario-owned items, existing plus synthesized. */
  scenarios: SystemScenario[];
  /** Item ids no scenario covers (nothing left to synthesize from). */
  uncovered: string[];
}

/**
 * Make sure every open scenario-owned ledger item has a scenario to run.
 *
 * Synthesis is DETERMINISTIC and made only of things that already carry
 * trust: steps are the workspace's trusted verification commands (the one
 * command set agents cannot edit), the environment plan is used only when
 * the workspace has exactly one (an ambiguous choice is a human's), and
 * browser scenarios are attached only if someone authored them. Nothing here
 * invents a test; it composes the proofs the workspace already declared.
 *
 * The synthesized scenario has a deterministic id per job, so re-running
 * this on every cycle rewrites the same record rather than growing a pile.
 */
export function ensureSystemScenarios(
  deps: AutonomyDeps,
  input: { jobId: string },
): EnsureScenariosResult {
  const ledger = readClosureLedger(deps.workspace, input.jobId);
  const open =
    ledger?.entries.filter(
      (entry) =>
        (entry.requiresSystemScenario || entry.requiresBrowserScenario) &&
        !isClosingStatus(entry.status),
    ) ?? [];
  if (open.length === 0) return { scenarios: [], uncovered: [] };

  const existing = listSystemScenarios(deps.workspace);
  const openIds = new Set(open.map((entry) => entry.itemId));
  const covering = existing.filter((scenario) =>
    scenario.itemIds.some((itemId) => openIds.has(itemId)),
  );
  const covered = new Set(covering.flatMap((scenario) => scenario.itemIds));
  const uncoveredIds = open.map((entry) => entry.itemId).filter((itemId) => !covered.has(itemId));
  if (uncoveredIds.length === 0) return { scenarios: covering, uncovered: [] };

  const commands = deps.config.verification.commands;
  if (commands.length === 0) {
    // No trusted commands means nothing to compose a scenario from. The
    // items stay open and the phase reports exactly that.
    return { scenarios: covering, uncovered: uncoveredIds };
  }

  const plans = listJsonRecords(autonomyPath(deps.workspace, 'environments', 'plans'), (raw) =>
    environmentPlanSchema.parse(raw),
  );
  const browserScenarioIds = listBrowserScenarios(deps.workspace)
    .map((scenario) => scenario.scenarioId)
    .slice(0, 20);

  const synthesized = saveSystemScenario(deps, {
    scenarioId: `ss-default-${input.jobId}`.slice(0, 200),
    name: 'Default mission qualification scenario',
    intent:
      'Synthesized deterministically from the trusted verification commands: run the full ' +
      'suite against the integrated product' +
      (plans.length === 1 ? ' with its declared environment provisioned' : '') +
      (browserScenarioIds.length > 0 ? ', then the authored browser scenarios' : '') +
      '.',
    ...(plans.length === 1 && plans[0] !== undefined
      ? { environmentPlanId: plans[0].planId }
      : {}),
    steps: commands.slice(0, 50).map((command, index) => ({
      stepId: `vc-${index + 1}`,
      name: command.name.slice(0, 200),
      argv: [...command.argv],
      timeoutMs: command.timeoutMs,
    })),
    browserScenarioIds,
    itemIds: uncoveredIds.slice(0, 100),
    jobId: input.jobId,
  });
  return { scenarios: [...covering, synthesized], uncovered: [] };
}

// ---------------------------------------------------------------------------
// Phase: system scenarios
// ---------------------------------------------------------------------------

export interface SystemScenarioPhaseOptions {
  jobId: string;
  runtime?: EnvironmentRuntime | undefined;
  probeExecutor?: ProbeExecutor | undefined;
  browserDriver?: BrowserDriver | undefined;
  signal?: AbortSignal | undefined;
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  emit?: ((message: string) => void) | undefined;
  /** Injected command runner (tests). Production shells out safely. */
  commandRunner?:
    | ((input: { argv: readonly string[]; cwd: string; timeoutMs: number }) => Promise<{ ok: boolean; detail: string }>)
    | undefined;
}

export interface SystemScenarioPhaseResult {
  executed: number;
  passed: number;
  failed: number;
  environmentUnavailable: number;
  /** Item ids that had no scenario to run for them. */
  uncovered: string[];
}

/**
 * Execute one system-scenario qualification cycle.
 *
 * The cycle counter advances HERE, after the scenarios ran — including a
 * cycle in which nothing could run, which is a real (and bounded) outcome:
 * the oracle sees the executed cycles mount without evidence appearing and
 * gives up honestly instead of spinning.
 */
export async function runSystemScenarioPhase(
  deps: AutonomyDeps,
  options: SystemScenarioPhaseOptions,
): Promise<SystemScenarioPhaseResult> {
  const { scenarios, uncovered } = ensureSystemScenarios(deps, { jobId: options.jobId });
  const result: SystemScenarioPhaseResult = {
    executed: 0,
    passed: 0,
    failed: 0,
    environmentUnavailable: 0,
    uncovered,
  };
  for (const scenario of scenarios) {
    if (options.signal?.aborted === true) break;
    options.emit?.(`running system scenario ${scenario.scenarioId} (${scenario.name})`);
    const run = await runSystemScenario(deps, {
      scenarioId: scenario.scenarioId,
      jobId: options.jobId,
      ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
      ...(options.probeExecutor !== undefined ? { probeExecutor: options.probeExecutor } : {}),
      ...(options.browserDriver !== undefined ? { browserDriver: options.browserDriver } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
      ...(options.commandRunner !== undefined ? { commandRunner: options.commandRunner } : {}),
      registerClosure: true,
    });
    result.executed += 1;
    if (run.status === 'PASSED') result.passed += 1;
    else if (run.status === 'ENVIRONMENT_UNAVAILABLE') result.environmentUnavailable += 1;
    else result.failed += 1;
    options.emit?.(`scenario ${scenario.scenarioId}: ${run.status}`);
  }
  if (uncovered.length > 0) {
    options.emit?.(
      `${uncovered.length} scenario-owned item(s) have no scenario to run ` +
        '(no trusted verification commands to synthesize one from)',
    );
  }
  advanceClosurePhase(deps, {
    jobId: options.jobId,
    phase: 'SYSTEM_SCENARIO_QUALIFICATION',
    systemCycle: true,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Phase: release qualification
// ---------------------------------------------------------------------------

export interface ReleaseQualificationResult {
  passed: boolean;
  detail: string;
}

/**
 * Run the full trusted verification suite against the INTEGRATED tree.
 *
 * Per-unit verification proved each change in its own worktree against the
 * baseline it started from; this proves the changes still hold after all of
 * them landed together. The pass/fail lands on the ledger as
 * `releaseQualificationPassed`, which the oracle and the completion gate
 * both read — a completion can no longer outrun it.
 */
export async function runReleaseQualificationPhase(
  deps: AutonomyDeps,
  options: {
    jobId: string;
    signal?: AbortSignal | undefined;
    emit?: ((message: string) => void) | undefined;
    /** Injected suite runner (tests). Production runs the real commands. */
    verify?:
      | ((commands: readonly VerificationCommand[]) => Promise<{ passed: boolean; requiredFailed: string[] }>)
      | undefined;
  },
): Promise<ReleaseQualificationResult> {
  const commands = deps.config.verification.commands;
  // Executed-cycle accounting first, so a run that dies mid-suite still
  // counted the attempt.
  advanceClosurePhase(deps, {
    jobId: options.jobId,
    phase: 'RELEASE_QUALIFICATION',
    releaseQualificationCycle: true,
  });
  let passed: boolean;
  let detail: string;
  if (commands.length === 0) {
    // Nothing is configured to prove the integrated tree. That is a real
    // state of the workspace, not a pass: a policy that requires this phase
    // is asking for evidence the workspace cannot produce, and the honest
    // answers are configuring commands or turning the requirement off.
    passed = false;
    detail = 'no trusted verification commands are configured; the integrated tree cannot be qualified';
  } else {
    options.emit?.(`release qualification: running ${commands.length} trusted command(s) against the integrated tree`);
    const run =
      options.verify !== undefined
        ? await options.verify(commands)
        : await runVerificationCommands(deps.workspace.rootDir, [...commands], {
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
          });
    passed = run.passed;
    detail = run.passed
      ? `all ${commands.length} trusted command(s) passed against the integrated tree`
      : `required command(s) failed: ${run.requiredFailed.join(', ').slice(0, 300)}`;
  }
  if (passed) {
    advanceClosurePhase(deps, {
      jobId: options.jobId,
      phase: 'RELEASE_QUALIFICATION',
      releaseQualificationPassed: true,
    });
  }
  try {
    recordJobEvent(jobDepsOf(deps), options.jobId, 'release_qualification_completed', {
      passed,
      detail: detail.slice(0, 300),
    });
  } catch {
    // Certification fixtures qualify with no job record.
  }
  options.emit?.(`release qualification: ${passed ? 'PASSED' : 'FAILED'} — ${detail}`);
  return { passed, detail };
}

// ---------------------------------------------------------------------------
// Phase: reproducibility
// ---------------------------------------------------------------------------

export interface ReproducibilityPhaseResult {
  status: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'NOT_RUN';
  detail: string;
}

/**
 * Run the reproducibility qualification in a genuinely clean checkout.
 *
 * The checkout is a detached git worktree of the canonical HEAD: same
 * history, none of the working tree's accumulated state, no build caches,
 * no installed dependencies. The step set is the workspace's own trusted
 * verification commands, prefixed with a dependency install when the
 * project's lockfile names its package manager. `runReproducibilityQualification`
 * owns the honesty rules from there — UNAVAILABLE steps make the run
 * INCONCLUSIVE, and only a PASS flips `reproducibilityPassed`.
 */
export async function runReproducibilityPhase(
  deps: AutonomyDeps,
  options: {
    jobId: string;
    signal?: AbortSignal | undefined;
    emit?: ((message: string) => void) | undefined;
    /** Injected step runner (tests), threaded to the reproducibility runner. */
    commandRunner?:
      | ((input: {
          argv: readonly string[];
          cwd: string;
          timeoutMs: number;
        }) => Promise<{ outcome: 'PASSED' | 'FAILED' | 'UNAVAILABLE'; detail: string }>)
      | undefined;
  },
): Promise<ReproducibilityPhaseResult> {
  advanceClosurePhase(deps, {
    jobId: options.jobId,
    phase: 'REPRODUCIBILITY',
    reproducibilityCycle: true,
  });
  const commands = deps.config.verification.commands;
  if (commands.length === 0) {
    const detail =
      'no trusted verification commands are configured; there is nothing to reproduce';
    options.emit?.(`reproducibility: NOT_RUN — ${detail}`);
    return { status: 'NOT_RUN', detail };
  }

  const runId = newRecordId(deps, 'rp');
  const checkoutPath = autonomyPath(deps.workspace, 'reproducibility', 'checkouts', runId);
  mkdirSync(path.dirname(checkoutPath), { recursive: true });
  const head = await runSafeProcess({
    executable: 'git',
    argv: ['rev-parse', 'HEAD'],
    cwd: deps.workspace.rootDir,
    timeoutMs: 60_000,
    maxStdoutBytes: 4_096,
    maxStderrBytes: 4_096,
  });
  const gitHead = head.status === 'ok' ? head.stdout.trim().slice(0, 64) : undefined;
  const checkout = await runSafeProcess({
    executable: 'git',
    argv: ['worktree', 'add', '--detach', checkoutPath, 'HEAD'],
    cwd: deps.workspace.rootDir,
    timeoutMs: 300_000,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024,
  });
  if (checkout.status !== 'ok') {
    const detail = `a clean checkout could not be created: ${checkout.stderr.split('\n')[0] ?? checkout.status}`;
    options.emit?.(`reproducibility: INCONCLUSIVE — ${detail}`);
    return { status: 'INCONCLUSIVE', detail };
  }

  const steps: ReproducibilityStep[] = [];
  const installer = detectNodeInstaller(deps.workspace);
  if (installer !== undefined) {
    steps.push({
      stepId: 'install',
      dimension: 'FRESH_DEPENDENCY_RESOLUTION',
      name: `${installer.join(' ')} in the clean checkout`,
      argv: [...installer],
      timeoutMs: 1_800_000,
    });
  }
  commands.slice(0, 25).forEach((command, index) => {
    steps.push({
      stepId: `vc-${index + 1}`,
      dimension: 'REPEATED_QUALIFICATION',
      name: command.name.slice(0, 200),
      argv: [...command.argv],
      timeoutMs: command.timeoutMs,
    });
  });

  try {
    const result = await runReproducibilityQualification(deps, {
      jobId: options.jobId,
      steps,
      checkoutPath,
      ...(gitHead !== undefined ? { gitHead } : {}),
      runId,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.commandRunner !== undefined ? { commandRunner: options.commandRunner } : {}),
    });
    const detail =
      result.status === 'PASSED'
        ? `reproduced from a clean checkout of ${gitHead ?? 'HEAD'}`
        : (result.failureDetail ?? result.inconclusiveReason ?? `reproducibility ${result.status}`);
    options.emit?.(`reproducibility: ${result.status} — ${detail}`);
    if (result.status === 'PASSED') {
      await removeCheckout(deps.workspace, checkoutPath);
    } else {
      options.emit?.(`the checkout is retained for diagnosis at ${checkoutPath}`);
    }
    return { status: result.status, detail };
  } catch (error) {
    await removeCheckout(deps.workspace, checkoutPath);
    throw error;
  }
}

/** The install command the checkout's lockfile names, when it names one. */
function detectNodeInstaller(workspace: WorkspaceInfo): readonly string[] | undefined {
  const root = workspace.rootDir;
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) return ['pnpm', 'install', '--frozen-lockfile'];
  if (existsSync(path.join(root, 'package-lock.json'))) return ['npm', 'ci'];
  if (existsSync(path.join(root, 'yarn.lock'))) return ['yarn', 'install', '--frozen-lockfile'];
  return undefined;
}

async function removeCheckout(workspace: WorkspaceInfo, checkoutPath: string): Promise<void> {
  await runSafeProcess({
    executable: 'git',
    argv: ['worktree', 'remove', '--force', checkoutPath],
    cwd: workspace.rootDir,
    timeoutMs: 300_000,
    maxStdoutBytes: 16 * 1024,
    maxStderrBytes: 16 * 1024,
  });
}

// ---------------------------------------------------------------------------
// Gap repair — the executor gap work never had
// ---------------------------------------------------------------------------

export interface GapRepairOptions {
  jobId: string;
  items: readonly GapWorkItem[];
  signal?: AbortSignal | undefined;
  emit?: ((message: string) => void) | undefined;
}

export interface GapRepairResult {
  repaired: string[];
  failed: { gapId: string; reason: string }[];
}

/**
 * Execute generated gap work.
 *
 * The vNext.10.1 dogfood generated gap work twelve times and nothing ever
 * ran it — the files sat on disk while the audit loop regenerated them.
 * This is the missing executor: one bounded BUILDER per gap item, in an
 * isolated worktree, whose changes land only if the FULL trusted
 * verification suite passes there and the patch applies cleanly to the
 * canonical tree.
 *
 * Evidence discipline: a successful repair registers TRUSTED_VERIFICATION
 * for the item. For an implementation-owned item that is the closing kind.
 * For a scenario-owned item it deliberately is NOT — the oracle reads it
 * only as "repaired since the last failed run" and routes the item back to
 * the scenario phase, because only the scenario can close it.
 *
 * A repair that lands also RESETS `releaseQualificationPassed` and
 * `reproducibilityPassed`: those were claims about a tree that no longer
 * exists.
 */
export async function runGapRepairs(
  deps: AutonomyDeps,
  options: GapRepairOptions,
): Promise<GapRepairResult> {
  const policy = deps.config.orchestration.jobs.objectives;
  const commands = deps.config.verification.commands;
  const ledger = readClosureLedger(deps.workspace, options.jobId);
  const result: GapRepairResult = { repaired: [], failed: [] };

  for (const item of options.items) {
    if (options.signal?.aborted === true) {
      result.failed.push({ gapId: item.gapId, reason: 'the run was cancelled' });
      break;
    }
    const entry = ledger?.entries.find((candidate) => candidate.itemId === item.itemId);
    const failureContext = entry?.evidence
      .filter((ref) => !ref.passed)
      .slice(-2)
      .map((ref) => `- ${ref.kind} ${ref.ref}: ${(ref.detail ?? 'failed').slice(0, 600)}`)
      .join('\n');
    const fail = (reason: string): void => {
      options.emit?.(`gap ${item.gapId} (${item.itemId}): ${reason}`);
      result.failed.push({ gapId: item.gapId, reason });
      recordGapEvent(deps, options.jobId, item, false, reason);
    };

    const worktree = await createWorkerWorktree({
      workspace: deps.workspace,
      jobId: options.jobId,
      workUnitId: `gap-${item.gapId}`.slice(0, 40),
      attempt: 1,
    });
    try {
      const packet = [
        'You are repairing ONE sealed contract item of an otherwise finished product.',
        '',
        `Sealed item ${item.itemId} (${item.gapKind}):`,
        item.objective,
        '',
        ...(failureContext !== undefined && failureContext.length > 0
          ? ['The failing evidence on record:', failureContext, '']
          : []),
        'Make the minimal change that makes the sealed statement demonstrably true.',
        'The FULL trusted verification suite must pass afterwards; do not weaken or skip tests.',
        'Do not touch .kiro/ or .specbridge/. Do not run git commands that rewrite history, push, or merge.',
      ].join('\n');
      options.emit?.(`gap ${item.gapId} (${item.itemId}): repair builder started`);
      const built = await runLargeObjectiveRole({
        workspace: deps.workspace,
        config: deps.config,
        runnerProfile: deps.config.defaultRunner,
        role: 'BUILDER',
        packet,
        cwd: worktree.dir,
        scratchDir: autonomyPath(deps.workspace, 'closure', options.jobId, 'scratch', item.gapId),
        timeoutMs: policy.builderTimeoutMs,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      if (!built.ok) {
        fail(`repair builder unavailable — ${built.kind}: ${built.problem.slice(0, 300)}`);
        continue;
      }
      if (built.output.outcome !== 'CANDIDATE_COMPLETE') {
        fail(`repair builder outcome ${built.output.outcome}: ${(built.output.summary ?? '').slice(0, 300)}`);
        continue;
      }
      const collected = await collectWorktreeChanges(worktree, { protectedPaths: [] });
      if (collected.protectedViolations.length > 0) {
        fail(`repair touched protected paths: ${collected.protectedViolations.slice(0, 5).join(', ')}`);
        continue;
      }
      if (collected.changedFiles.length === 0) {
        fail('the repair changed nothing; there is nothing to verify');
        continue;
      }
      const verification = await runWorktreeVerification(worktree, [...commands], options.signal);
      if (!verification.passed) {
        fail(`the trusted suite failed in the repair worktree: ${verification.requiredFailed.join(', ').slice(0, 200)}`);
        continue;
      }
      const patchFile = path.join(
        autonomyPath(deps.workspace, 'closure', options.jobId, 'scratch', item.gapId),
        'repair.patch',
      );
      mkdirSync(path.dirname(patchFile), { recursive: true });
      writeFileSync(patchFile, collected.patch, 'utf8');
      const applied = await runSafeProcess({
        executable: 'git',
        argv: ['apply', '--3way', patchFile],
        cwd: deps.workspace.rootDir,
        timeoutMs: 300_000,
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 64 * 1024,
      });
      if (applied.status !== 'ok') {
        fail(`the verified repair no longer applies to the canonical tree: ${applied.stderr.split('\n')[0] ?? applied.status}`);
        continue;
      }
      registerClosureEvidence(deps, {
        jobId: options.jobId,
        itemIds: [item.itemId],
        kind: 'TRUSTED_VERIFICATION',
        ref: `gap:${item.gapId}`,
        passed: true,
        detail: `Gap repair (${item.gapKind}) verified by the full trusted suite in an isolated worktree.`,
      });
      // The tree changed; whole-tree claims made before this repair are void.
      advanceClosurePhase(deps, {
        jobId: options.jobId,
        phase: 'GAP_IMPLEMENTATION',
        releaseQualificationPassed: false,
        reproducibilityPassed: false,
      });
      result.repaired.push(item.gapId);
      options.emit?.(`gap ${item.gapId} (${item.itemId}): repaired, verified, and integrated`);
      recordGapEvent(deps, options.jobId, item, true, `${collected.changedFiles.length} file(s) changed`);
    } finally {
      await removeWorkerWorktree(deps.workspace, options.jobId, worktree);
    }
  }
  return result;
}

function recordGapEvent(
  deps: AutonomyDeps,
  jobId: string,
  item: GapWorkItem,
  ok: boolean,
  detail: string,
): void {
  try {
    recordJobEvent(jobDepsOf(deps), jobId, 'gap_repair_completed', {
      gapId: item.gapId,
      itemId: item.itemId,
      gapKind: item.gapKind,
      ok,
      detail: detail.slice(0, 300),
    });
  } catch {
    // Certification fixtures repair with no job record.
  }
}

/** The instant recorded on synthesized qualification records. */
export function missionQualificationNow(deps: AutonomyDeps): string {
  return nowIso(deps);
}

/** Re-exported for callers that bound phases by policy. */
export function maxQualificationCycles(deps: AutonomyDeps): number {
  return autonomyPolicyOf(deps).closure.maxSystemQualificationCycles;
}
