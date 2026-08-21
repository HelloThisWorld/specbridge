import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginExecutorDispatch,
  beginPlanning,
  buildJobGraph,
  completeExecutorDispatch,
  createJob,
  createTaskCheckpoint,
  listTaskAttempts,
  prepareTaskResume,
  readExecutionLedger,
  readLatestTaskCheckpoint,
  recordClassification,
  recordCriticVerdict,
  recordPlan,
  repositoryStateFromSnapshot,
  requireGraphRevision,
  requireJobState,
  resumeJob,
  summarizeExecutionLedger,
} from '@specbridge/orchestration';
import type { AttemptContext, JobDeps } from '@specbridge/orchestration';
import { captureGitSnapshot } from '@specbridge/evidence';
import {
  ContextLifecycleManager,
  contextBudgetConfigSchema,
  renderContextPackage,
} from '@specbridge/context';
import {
  DeepSeekHarnessRunner,
  createDefaultRunnerRegistry,
  selectRunner,
} from '@specbridge/runners';
import type { DeepSeekHarnessProfileConfig } from '@specbridge/core';
import {
  BUILT_IN_PROFILE_NAMES,
  deepseekHarnessProfileSchema,
  defaultResolvedAgentConfig,
} from '@specbridge/core';
import { FAKE_DSH_PATH, idCounter, tickingClock } from '../helpers-execution.js';
import { setupOrchestrationFixture } from '../helpers-orchestration.js';

/**
 * The vNext.3 mandatory end-to-end validation scenario (§49): the SpecBridge
 * control plane driving DeepSeek Harness as a DISPOSABLE execution engine.
 *
 *   load workspace → vNext.1/vNext.2 runtime starts → explicit DSH profile →
 *   ExecutionAttempt + Checkpoint + ContextPackage → real DSH subprocess via
 *   the official SDK → bounded agentic edit → SpecBridge evidence → PASS →
 *   continuation with DSH-native compaction (durable context unaffected) →
 *   DSH process killed mid-attempt (attempt preserved, job recoverable) →
 *   restart → original DSH session UNAVAILABLE → canonical checkpoint
 *   reconstruction → fresh DSH session → PASS → delete ALL transient DSH
 *   state → restart SpecBridge → Job/Task/attempts/decisions/checkpoint/
 *   evidence all survive → with DSH disabled nothing changes.
 *
 * Every agentic leg spawns the REAL fake-DSH runtime through the REAL
 * pinned SDK client. If this scenario cannot pass, the Harness boundary is
 * not trustworthy.
 */

const WORKER_BUDGET = contextBudgetConfigSchema.parse({
  modelContextTokens: 8_000,
  reservedOutputTokens: 500,
  reservedReasoningTokens: 250,
  reservedGrowthTokens: 250,
});

const PINNED = {
  taskContract: 'Implement workflow validation for the settings feature.',
  acceptanceCriteria: ['All workflow definitions validate.', 'The full test suite passes.'],
  constraints: ['Do not modify the public CLI contract.'],
  invariants: ['Verification cannot be bypassed.'],
};

const PASSTHROUGH = ['FAKE_DSH_SCENARIO', 'FAKE_DSH_SESSIONS_DIR', 'FAKE_DSH_EDIT_PATH', 'FAKE_DSH_LOG'];

afterEach(() => {
  for (const name of PASSTHROUGH) delete process.env[name];
});

describe('final validation scenario (vNext.3 DeepSeek Harness boundary, end to end)', () => {
  it('a job treats DSH as a powerful but disposable execution engine', async () => {
    // (1–2) Load an existing SpecBridge workspace; the vNext.1/vNext.2
    // runtime starts normally (real git repository, real approval flow).
    const fixture = setupOrchestrationFixture({ git: true });
    const job = createJob(fixture.deps, {
      specName: fixture.specName,
      goal: 'Ship workflow validation end to end through the DSH boundary.',
    });
    await buildJobGraph(fixture.deps, job.jobId);
    const graph = requireGraphRevision(fixture.workspace, job.jobId, 1);
    const node = graph.nodes[0];
    if (node === undefined) throw new Error('fixture graph has no nodes');
    const context = (role: AttemptContext['role']): AttemptContext => ({
      nodeId: node.nodeId,
      role,
      workerId: 'dsh-validation-worker',
      startedAt: fixture.clock().toISOString(),
    });
    recordClassification(fixture.deps, job.jobId, { context: context('CLASSIFIER'), proposedClass: 'LOW' });
    beginPlanning(fixture.deps, job.jobId, node.nodeId);
    await recordPlan(fixture.deps, job.jobId, {
      context: context('PLANNER'),
      candidate: {
        goal: 'Implement workflow validation.',
        steps: [{ description: 'Add validation.' }, { description: 'Wire the service.' }],
        testStrategy: 'Unit tests.',
        verificationStrategy: 'Trusted verification commands.',
      },
      producedByTier: 'LOCAL_SMALL',
    });
    recordCriticVerdict(fixture.deps, job.jobId, {
      context: context('CRITIC'),
      verdict: 'ACCEPT',
      reasons: ['Sound.'],
    });

    // (3) Explicitly select an ENABLED DeepSeek Harness runner profile. All
    // transient runtime state lives OUTSIDE SpecBridge durable state.
    const dshRuntimeHome = path.join(fixture.root, '.dsh-runtime');
    mkdirSync(dshRuntimeHome, { recursive: true });
    process.env['FAKE_DSH_SESSIONS_DIR'] = path.join(dshRuntimeHome, 'sessions');
    process.env['FAKE_DSH_EDIT_PATH'] = path.join('src', 'dsh-e2e-change.txt');
    const profileConfig: DeepSeekHarnessProfileConfig = deepseekHarnessProfileSchema.parse({
      runner: 'deepseek-harness',
      enabled: true,
      command: { executable: process.execPath, args: [FAKE_DSH_PATH] },
      provider: 'fake-provider',
      model: 'fake-model',
      workspaceBoundary: 'runtime-profile',
      sessionPersistence: 'runtime-managed',
      environmentPassthrough: PASSTHROUGH,
      timeoutMs: 60_000,
    });
    const runner = new DeepSeekHarnessRunner(profileConfig);

    // (4–5) Start a normal SpecBridge Task: the durable ExecutionAttempt is
    // created BEFORE work, and the ContextPackage is assembled by SpecBridge
    // (pre-dispatch context assembly stays SpecBridge-owned — §23).
    beginExecutorDispatch(fixture.deps, job.jobId, {
      nodeId: node.nodeId,
      mode: 'implement',
      workerId: 'dsh-worker-1',
      provider: 'deepseek-harness',
      model: 'fake-model',
      providerSessionId: 'dsh-session-1',
    });
    const attempt1 = requireJobState(fixture.workspace, job.jobId).currentAttemptId as string;
    const survivalDeps = { workspace: fixture.workspace, clock: fixture.clock };
    const checkpoint1 = createTaskCheckpoint(survivalDeps, {
      jobId: job.jobId,
      nodeId: node.nodeId,
      taskId: node.parentTaskId,
      attemptId: attempt1,
      reason: 'milestone',
      objective: 'Implement workflow validation.',
      pinned: PINNED,
      importantDecisions: [
        { decision: 'Use zod schemas for validation.', rationale: 'Repository convention.' },
      ],
      failedApproaches: [
        { approach: 'Approach X: regex-based validation', reason: 'cannot express nested rules' },
      ],
      nextActions: ['Implement the validation module.'],
    });
    const manager = new ContextLifecycleManager({ budget: WORKER_BUDGET, clock: fixture.clock });
    manager.add({
      itemId: 'pinned-contract',
      layer: 'PINNED',
      kind: 'task-contract',
      title: 'TaskContract',
      content: `${PINNED.taskContract}\nAcceptanceCriteria:\n- ${PINNED.acceptanceCriteria.join('\n- ')}`,
      createdAt: fixture.clock().toISOString(),
      compacted: false,
    });
    manager.add({
      itemId: 'current-action',
      layer: 'CURRENT_ACTION',
      kind: 'next-action',
      title: 'Current action',
      content: 'Implement the validation module.',
      createdAt: fixture.clock().toISOString(),
      compacted: false,
    });
    const assembled = manager.assemble({ checkpointId: checkpoint1.checkpointId });
    const prompt = `${renderContextPackage(assembled.package)}\n\nImplement the task and end with the JSON task report.`;

    // (6–11) SpecBridge starts the DSH subprocess through the official SDK;
    // the agent reads the fixture repository, performs a bounded edit, runs
    // a tool, and returns a completion CLAIM. SpecBridge then evaluates the
    // repository independently.
    process.env['FAKE_DSH_SCENARIO'] = 'success';
    const before = await captureGitSnapshot(fixture.root, { clock: fixture.clock });
    const execution = {
      workspaceRoot: fixture.root,
      runDir: path.join(fixture.root, '.specbridge', 'runs', 'dsh-e2e-1'),
      timeoutMs: 60_000,
    };
    const run1 = await runner.executeTask(
      {
        specName: fixture.specName,
        taskId: node.parentTaskId,
        prompt,
        promptVersion: 'dsh-e2e',
        toolPolicy: 'implementation',
        sessionId: 'dsh-session-1',
      },
      execution,
    );
    expect(run1.outcome).toBe('completed');
    expect(run1.sessionId).toBe('dsh-session-1');
    expect(run1.resumeSupported).toBe(true);
    const after1 = await captureGitSnapshot(fixture.root, { clock: fixture.clock });
    const editedPath = 'src/dsh-e2e-change.txt';
    expect(before.entries.some((entry) => entry.path === editedPath)).toBe(false);
    expect(after1.entries.some((entry) => entry.path === editedPath)).toBe(true);
    expect(readFileSync(path.join(fixture.root, editedPath), 'utf8')).toContain('fake dsh implementation');

    // (12) Checkpoint / Attempt / Ledger state is persisted.
    const checkpointAfterRun1 = createTaskCheckpoint(survivalDeps, {
      jobId: job.jobId,
      nodeId: node.nodeId,
      taskId: node.parentTaskId,
      attemptId: attempt1,
      reason: 'milestone',
      objective: 'Implement workflow validation.',
      pinned: PINNED,
      completedWork: ['Validation module implemented through DSH.'],
      changedFiles: [{ path: editedPath }],
      repositoryState: repositoryStateFromSnapshot(after1),
      nextActions: ['Wire validation into the service startup path.'],
    });
    expect(listTaskAttempts(fixture.workspace, job.jobId, { nodeId: node.nodeId })).toHaveLength(1);

    // (13–15) Continue on the SAME session: DSH performs NATIVE compaction.
    // Its working memory changes; SpecBridge durable context must not.
    process.env['FAKE_DSH_SCENARIO'] = 'compaction';
    const checkpointJsonBefore = JSON.stringify(readLatestTaskCheckpoint(fixture.workspace, job.jobId, node.nodeId));
    const run2 = await runner.executeTask(
      {
        specName: fixture.specName,
        taskId: node.parentTaskId,
        prompt: `${prompt}\n\nContinue: wire the service.`,
        promptVersion: 'dsh-e2e',
        toolPolicy: 'implementation',
        sessionId: 'dsh-session-1',
      },
      { ...execution, runDir: path.join(fixture.root, '.specbridge', 'runs', 'dsh-e2e-2') },
    );
    expect(run2.outcome).toBe('completed');
    expect((run2.normalizedEvents ?? []).some((event) => event.type === 'compaction.occurred')).toBe(true);
    const checkpointJsonAfter = JSON.stringify(readLatestTaskCheckpoint(fixture.workspace, job.jobId, node.nodeId));
    expect(checkpointJsonAfter).toBe(checkpointJsonBefore); // durable context unaffected
    expect(readLatestTaskCheckpoint(fixture.workspace, job.jobId, node.nodeId)?.pinned).toEqual(PINNED);

    // (16–17) Interrupt the DSH process mid-attempt: the runtime dies with
    // work in flight. The attempt record survives; the job stays
    // recoverable; the checkpoint is intact. A Harness crash is a WORKER
    // failure, never Job corruption.
    process.env['FAKE_DSH_SCENARIO'] = 'crash-mid-run';
    const crashed = await runner.executeTask(
      {
        specName: fixture.specName,
        taskId: node.parentTaskId,
        prompt,
        promptVersion: 'dsh-e2e',
        toolPolicy: 'implementation',
        sessionId: 'dsh-session-1',
      },
      { ...execution, runDir: path.join(fixture.root, '.specbridge', 'runs', 'dsh-e2e-3') },
    );
    expect(crashed.outcome).toBe('failed');
    expect(crashed.error?.code).toBe('process_failed');

    // (18) Restart execution: SpecBridge reconciles the interrupted attempt.
    const restarted: JobDeps = {
      workspace: fixture.workspace,
      config: fixture.config,
      clock: tickingClock('2026-08-21T12:00:00.000Z'),
      idFactory: idCounter('dsh-restart'),
      host: 'test-restarted',
    };
    const resumeReport = await resumeJob(restarted, job.jobId);
    expect(resumeReport.interruptedAttemptIds).toEqual([attempt1]);
    expect(resumeReport.job.status).toBe('READY');
    const preserved = listTaskAttempts(fixture.workspace, job.jobId, { nodeId: node.nodeId });
    expect(preserved[0]?.status).toBe('INTERRUPTED');
    expect(preserved[0]?.checkpointIds).toContain(checkpointAfterRun1.checkpointId);

    // (19) Simulate the original DSH session being UNAVAILABLE: delete the
    // runtime's transient session store entirely.
    rmSync(path.join(dshRuntimeHome, 'sessions'), { recursive: true, force: true });

    // The resume FAST PATH must refuse rather than run on an empty session:
    // the seq-continuity guard detects the silently-recreated session.
    process.env['FAKE_DSH_SCENARIO'] = 'resume';
    const fastPath = await runner.resumeTask(
      {
        specName: fixture.specName,
        taskId: node.parentTaskId,
        prompt,
        promptVersion: 'dsh-e2e',
        toolPolicy: 'implementation',
        sessionId: 'dsh-session-1',
      },
      { ...execution, runDir: path.join(fixture.root, '.specbridge', 'runs', 'dsh-e2e-4') },
    );
    expect(fastPath.outcome).toBe('failed');
    expect(fastPath.error?.code).toBe('session_unavailable');

    // (20–21) Canonical fallback: latest SpecBridge Checkpoint + current
    // repository state + ContextLifecycle reconstruction → a FRESH DSH
    // session continues the task. A lost DSH session never loses the Task.
    const preparation = await prepareTaskResume(restarted, {
      jobId: job.jobId,
      nodeId: node.nodeId,
      budget: WORKER_BUDGET,
    });
    expect(preparation.resumeFromAttemptId).toBe(attempt1);
    const reconstructed = renderContextPackage(preparation.assembled.package);
    expect(reconstructed).toContain('Implement workflow validation for the settings feature.');
    expect(reconstructed).toContain('Approach X: regex-based validation');
    expect(reconstructed).toContain('Use zod schemas for validation.');
    expect(reconstructed).toContain(editedPath); // grounded in current repo state
    expect(reconstructed).not.toContain('dsh-session-1'); // no provider-session dependence

    beginExecutorDispatch(restarted, job.jobId, {
      nodeId: node.nodeId,
      mode: 'implement',
      workerId: 'dsh-worker-2',
      provider: 'deepseek-harness',
      model: 'fake-model',
      providerSessionId: 'dsh-session-2',
    });
    const attempt2 = requireJobState(fixture.workspace, job.jobId).currentAttemptId as string;
    process.env['FAKE_DSH_SCENARIO'] = 'success';
    const run3 = await runner.executeTask(
      {
        specName: fixture.specName,
        taskId: node.parentTaskId,
        prompt: `${reconstructed}\n\nContinue the task and end with the JSON task report.`,
        promptVersion: 'dsh-e2e',
        toolPolicy: 'implementation',
        sessionId: 'dsh-session-2',
      },
      { ...execution, runDir: path.join(fixture.root, '.specbridge', 'runs', 'dsh-e2e-5') },
    );
    expect(run3.outcome).toBe('completed');

    // (22) Verification passes: SpecBridge evidence (actual repository
    // state), never the agent's claim, completes the dispatch.
    const finalSnapshot = await captureGitSnapshot(fixture.root, { clock: fixture.clock });
    expect(finalSnapshot.entries.some((entry) => entry.path === editedPath)).toBe(true);
    const completion = completeExecutorDispatch(restarted, job.jobId, {
      context: {
        nodeId: node.nodeId,
        role: 'EXECUTOR',
        workerId: 'dsh-worker-2',
        startedAt: new Date('2026-08-21T12:30:00.000Z').toISOString(),
        runId: 'dsh-run-final',
        usage: {
          inputTokens: run3.usage?.inputTokens ?? null,
          outputTokens: run3.usage?.outputTokens ?? null,
          costUsd: null,
        },
      },
      mode: 'implement',
      evidenceStatus: 'verified',
      changedFiles: finalSnapshot.entries.map((entry) => ({ path: entry.path, contentHash: entry.status })),
    });
    expect(completion.nextAction === 'node-complete' || completion.nextAction === 'job-complete').toBe(true);

    // (23–25) Delete ALL transient DSH session/runtime state, then restart
    // SpecBridge with fresh deps: Job, Task state, attempts, decisions,
    // checkpoints, and evidence ALL survive. DSH state was disposable.
    rmSync(dshRuntimeHome, { recursive: true, force: true });
    expect(existsSync(dshRuntimeHome)).toBe(false);
    const survivor: JobDeps = {
      workspace: fixture.workspace,
      config: fixture.config,
      clock: tickingClock('2026-08-21T13:00:00.000Z'),
      idFactory: idCounter('dsh-survivor'),
      host: 'test-survivor',
    };
    const survivedJob = requireJobState(fixture.workspace, job.jobId);
    expect(survivedJob.jobId).toBe(job.jobId);
    const finalGraph = requireGraphRevision(fixture.workspace, job.jobId, survivedJob.graphRevision);
    expect(finalGraph.nodes.find((candidate) => candidate.nodeId === node.nodeId)?.status).toBe('COMPLETED');
    const attempts = listTaskAttempts(fixture.workspace, job.jobId, { nodeId: node.nodeId });
    expect(attempts.map((attempt) => [attempt.provider, attempt.status])).toEqual([
      ['deepseek-harness', 'INTERRUPTED'],
      ['deepseek-harness', 'COMPLETED'],
    ]);
    // §31: DSH attempts are distinguishable in execution history.
    expect(attempts[0]?.providerSessionId).toBe('dsh-session-1');
    expect(attempts[1]?.attemptId).toBe(attempt2);
    expect(attempts[1]?.providerSessionId).toBe('dsh-session-2');
    expect(attempts[1]?.resumedFromAttemptId).toBe(attempt1);
    // The latest checkpoint is the auto milestone written by the verified
    // completion; the carry-forward rule guarantees nothing recorded by the
    // earlier attempts was lost on the way there.
    const finalCheckpoint = readLatestTaskCheckpoint(fixture.workspace, job.jobId, node.nodeId);
    expect(finalCheckpoint?.pinned.taskContract).toBeTruthy();
    expect(finalCheckpoint?.importantDecisions.map((decision) => decision.decision)).toContain(
      'Use zod schemas for validation.',
    );
    expect(finalCheckpoint?.failedApproaches.map((failed) => failed.approach)).toContain(
      'Approach X: regex-based validation',
    );
    const summary = summarizeExecutionLedger(readExecutionLedger(fixture.workspace, job.jobId));
    expect(summary.byProvider['deepseek-harness']?.attempts).toBe(2);
    expect(summary.byProvider['deepseek-harness']?.completed).toBe(1);
    expect(summary.byProvider['deepseek-harness']?.interrupted).toBe(1);
    // The evidence (the edited file, committed history) is repository state,
    // untouched by deleting every byte of DSH runtime state.
    expect(readFileSync(path.join(fixture.root, editedPath), 'utf8')).toContain('fake dsh implementation');
    // A fresh resume pass over the surviving job stays consistent: nothing
    // left to reconcile, and the job identity is unchanged.
    const finalResume = await resumeJob(survivor, job.jobId);
    expect(finalResume.job.jobId).toBe(job.jobId);
    expect(finalResume.interruptedAttemptIds ?? []).toEqual([]);

    // (26–27) With DSH disabled (the DEFAULT), nothing changes: the built-in
    // profile exists, is disabled, is never the default runner, and is
    // refused by selection even as an explicit default. The full existing
    // regression suite (claude-code / codex / local-model / scheduler)
    // carries the rest of Test O.
    const defaults = defaultResolvedAgentConfig();
    expect(defaults.defaultRunner).toBe(BUILT_IN_PROFILE_NAMES['claude-code']);
    const builtIn = defaults.runnerProfiles[BUILT_IN_PROFILE_NAMES['deepseek-harness']];
    expect(builtIn?.runner).toBe('deepseek-harness');
    expect(builtIn?.enabled).toBe(false);
    const registry = createDefaultRunnerRegistry(defaults);
    const refusal = selectRunner(registry, defaults, {
      operation: 'task-execution',
      explicitProfile: BUILT_IN_PROFILE_NAMES['deepseek-harness'],
    });
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) expect(refusal.failure.error.code).toBe('runner_disabled');
  }, 120_000);
});
