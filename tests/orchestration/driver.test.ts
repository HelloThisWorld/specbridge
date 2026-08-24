import { describe, expect, it } from 'vitest';
import {
  CLAUDE_WORKER_ID,
  LOCAL_WORKER_ID,
  driveJob,
  createJob,
  listJobs,
  readJobEvents,
  requireGraphRevision,
  requireJobState,
  reviewNodePlan,
} from '@specbridge/orchestration';
import type { DriverDeps, DriverEvent } from '@specbridge/orchestration';
import type { ExecutionFixture } from '../helpers-execution.js';
import { setupExecutionFixture } from '../helpers-execution.js';
import { fixturePath } from '../helpers.js';

/**
 * The long-running driver, end to end and fully offline:
 *
 *   local reasoning  → the REAL fake llama-server child process over HTTP
 *   large reasoning  → the REAL fake Claude CLI child process
 *   execution        → the REAL mock (or fake Claude) runner through the
 *                      unchanged evidence pipeline: git snapshots, trusted
 *                      verification, verified-only checkbox completion
 *
 * These are the StepRelay readiness scenarios: simple local plan → executor,
 * HIGH-complexity escalation, verification failure → diagnose → repair,
 * interruption → resume, local model failure isolation, and budget stops.
 */

const FAKE_LLAMA = fixturePath('fake-llama', 'fake-llama-server.mjs');

interface DriverFixture extends ExecutionFixture {
  driverDeps: DriverDeps;
}

function driverFixture(options: {
  git?: boolean;
  local?: boolean | { scenario: string };
  jobs?: Record<string, unknown>;
  defaultRunner?: string;
  useFakeClaude?: boolean;
  verificationCommands?: Record<string, unknown>[];
  scenario?: string;
}): DriverFixture {
  const local = options.local ?? true;
  const fixture = setupExecutionFixture({
    git: options.git ?? true,
    ...(options.defaultRunner !== undefined ? { defaultRunner: options.defaultRunner } : {}),
    ...(options.useFakeClaude !== undefined ? { useFakeClaude: options.useFakeClaude } : {}),
    ...(options.verificationCommands !== undefined
      ? { verificationCommands: options.verificationCommands }
      : {}),
    ...(options.scenario !== undefined ? { scenario: options.scenario as never } : {}),
    extraConfig: {
      ...(local !== false
        ? {
            localInference: {
              enabled: true,
              executable: process.execPath,
              executableArgs: [FAKE_LLAMA],
              model: FAKE_LLAMA,
              startupTimeoutMs: 30_000,
              requestTimeoutMs: 30_000,
              ...(typeof local === 'object' ? { extraArgs: [`--scenario=${local.scenario}`] } : {}),
            },
          }
        : {}),
      orchestration: { jobs: options.jobs ?? {} },
    },
  });
  return {
    ...fixture,
    driverDeps: {
      workspace: fixture.workspace,
      config: fixture.config,
      registry: fixture.registry,
      clock: fixture.clock,
      idFactory: fixture.idFactory,
      host: 'test',
    },
  };
}

function startJob(fixture: DriverFixture, goal = 'Implement the approved plan.'): string {
  const job = createJob(fixture.driverDeps, { specName: fixture.specName, goal });
  return job.jobId;
}

describe('driveJob — StepRelay readiness scenarios', () => {
  it('scenario: simple tasks flow local plan → local critique → executor → verified completion', async () => {
    const fixture = driverFixture({});
    const jobId = startJob(fixture);
    const events: DriverEvent[] = [];
    const result = await driveJob(fixture.driverDeps, jobId, {
      onEvent: (event) => events.push(event),
    });

    expect(result.stop.kind).toBe('completed');
    expect(result.job.status).toBe('COMPLETED');

    const graph = requireGraphRevision(fixture.workspace, jobId, result.job.graphRevision);
    expect(graph.nodes.every((node) => node.status === 'COMPLETED')).toBe(true);
    // Every completion went through the evidence pipeline.
    for (const node of graph.nodes) {
      expect(node.latestEvidence?.evidenceStatus).toBe('verified');
      expect(node.latestEvidence?.runId).toBeDefined();
    }
    // Local reasoning carried classification/planning/critique; the
    // repository-writing dispatches went to the large-agent worker.
    const attempts = graph.nodes.flatMap((node) => node.attempts);
    expect(attempts.some((attempt) => attempt.role === 'PLANNER' && attempt.workerId === LOCAL_WORKER_ID)).toBe(true);
    expect(attempts.some((attempt) => attempt.role === 'CRITIC' && attempt.workerId === LOCAL_WORKER_ID)).toBe(true);
    expect(
      attempts
        .filter((attempt) => attempt.role === 'EXECUTOR')
        .every((attempt) => attempt.workerId === CLAUDE_WORKER_ID),
    ).toBe(true);
    // The audit trail answers "why" questions from persisted state.
    const trail = readJobEvents(fixture.workspace, jobId, { limit: 500 });
    const types = trail.events.map((event) => event.type);
    for (const expected of [
      'graph_created',
      'worker_selected',
      'plan_created',
      'critic_completed',
      'execution_started',
      'node_completed',
      'job_completed',
      'checkpoint_created',
      'local_model_started',
    ]) {
      expect(types, `event ${expected}`).toContain(expected);
    }
  }, 180_000);

  it('scenario: verification failure → local diagnosis → bounded repair → honest budget stop', async () => {
    const fixture = driverFixture({
      verificationCommands: [
        { name: 'test', argv: [process.execPath, '-e', 'process.exit(1)'], timeoutMs: 60_000, required: true },
      ],
      jobs: { budgets: { maxRepairCyclesPerTask: 1, maxReplansPerTask: 0, maxJobReplans: 0 } },
    });
    const jobId = startJob(fixture);
    const result = await driveJob(fixture.driverDeps, jobId, {});

    // The failing verifier can never pass, so the honest outcome is a
    // bounded stop with evidence preserved — never a completed claim.
    expect(result.stop.kind).toBe('blocked');
    expect(result.job.status).toBe('BLOCKED');
    expect(result.job.blocker?.category).toBe('BUDGET_EXHAUSTED');

    const graph = requireGraphRevision(fixture.workspace, jobId, result.job.graphRevision);
    const first = graph.nodes[0];
    expect(first?.latestFailure?.category).toBe('VERIFICATION_FAILURE');
    expect(first?.latestDiagnosis).toBeDefined();
    expect(first?.repairCycles).toBeGreaterThanOrEqual(1);
    // No checkbox was updated: the task stays open in tasks.md.
    const trail = readJobEvents(fixture.workspace, jobId, { limit: 500 });
    const types = trail.events.map((event) => event.type);
    expect(types).toContain('verification_failed');
    expect(types).toContain('diagnosis_completed');
    expect(types).toContain('repair_started');
    expect(types).not.toContain('job_completed');
  }, 180_000);

  it('scenario: HIGH complexity escalates planning to the large agent and gates on human review', async () => {
    process.env['FAKE_CLAUDE_SCENARIO'] = 'success';
    try {
      const fixture = driverFixture({
        defaultRunner: 'claude-code',
        useFakeClaude: true,
        // The local classifier proposes MEDIUM; force HIGH determinism by
        // keeping the classifier local but relying on the fake local
        // CLASSIFIER (MEDIUM) — so make routing planner-large explicit via
        // policy instead, which also records ROLE_POLICY escalation.
        jobs: { routing: { planner: 'large-agent' }, planReview: 'always' },
      });
      const jobId = startJob(fixture);
      const first = await driveJob(fixture.driverDeps, jobId, {});
      expect(first.stop).toMatchObject({ kind: 'needs-human', what: 'plan-review' });

      const graph = requireGraphRevision(fixture.workspace, jobId, first.job.graphRevision);
      const node = graph.nodes.find((candidate) => candidate.humanReviewRequired);
      expect(node).toBeDefined();
      expect(node?.planProducedByTier).toBe('LARGE_AGENT');
      expect(first.job.escalations.some((entry) => entry.reason === 'ROLE_POLICY')).toBe(true);

      // The human approves; the job resumes and completes.
      reviewNodePlan(fixture.driverDeps, jobId, {
        nodeId: node?.nodeId as string,
        decision: 'approved',
      });
      const second = await driveJob(fixture.driverDeps, jobId, {});
      // Each subsequent node gates on review again under `always`;
      // approve them as they surface.
      let stop = second.stop;
      let guard = 0;
      while (stop.kind === 'needs-human' && guard < 10) {
        guard += 1;
        const current = requireGraphRevision(
          fixture.workspace,
          jobId,
          requireJobState(fixture.workspace, jobId).graphRevision,
        ).nodes.find((candidate) => candidate.humanReviewRequired);
        expect(current).toBeDefined();
        reviewNodePlan(fixture.driverDeps, jobId, {
          nodeId: current?.nodeId as string,
          decision: 'approved',
        });
        stop = (await driveJob(fixture.driverDeps, jobId, {})).stop;
      }
      expect(stop.kind).toBe('completed');
    } finally {
      delete process.env['FAKE_CLAUDE_SCENARIO'];
    }
  }, 240_000);

  it('scenario: interruption checkpoints and the SAME job resumes to completion', async () => {
    const fixture = driverFixture({});
    const jobId = startJob(fixture);

    // Abort as soon as the first executor dispatch starts.
    const controller = new AbortController();
    let executorSeen = false;
    const first = await driveJob(fixture.driverDeps, jobId, {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.kind === 'executor-finished' && !executorSeen) {
          executorSeen = true;
          controller.abort();
        }
      },
    });
    expect(first.stop.kind).toBe('interrupted');
    const interrupted = requireJobState(fixture.workspace, jobId);
    expect(interrupted.finalizedAt).toBeUndefined();

    const resumed = await driveJob(fixture.driverDeps, jobId, {});
    expect(resumed.stop.kind).toBe('completed');
    expect(resumed.job.jobId).toBe(jobId);
    // Honest continuation: one job, one event history, resumed marker inside.
    const trail = readJobEvents(fixture.workspace, jobId, { limit: 500 });
    expect(trail.events.some((event) => event.type === 'job_resumed')).toBe(true);
    expect(listJobs(fixture.workspace).jobs).toHaveLength(1);
  }, 240_000);

  it('scenario: a dying local model escalates reasoning without failing the source task', async () => {
    process.env['FAKE_CLAUDE_SCENARIO'] = 'success';
    try {
      const fixture = driverFixture({
        defaultRunner: 'claude-code',
        useFakeClaude: true,
        local: { scenario: 'die-on-infer' },
        // The fake large classifier answers HIGH; auto plan review keeps
        // this scenario focused on worker-failure isolation, not gating.
        jobs: { budgets: { maxAgentRuns: 80 }, planReview: 'auto' },
      });
      const jobId = startJob(fixture);
      const result = await driveJob(fixture.driverDeps, jobId, {});

      // The job still completes: reasoning escalated to the large agent.
      expect(result.stop.kind).toBe('completed');
      expect(
        result.job.escalations.some(
          (entry) =>
            entry.reason === 'REPEATED_LOCAL_FAILURE' ||
            entry.reason === 'LOCAL_WORKER_UNAVAILABLE' ||
            entry.reason === 'INVALID_LOCAL_OUTPUT',
        ),
      ).toBe(true);
      // No node ever FAILED because of the crashing local worker.
      const graph = requireGraphRevision(fixture.workspace, jobId, result.job.graphRevision);
      expect(graph.nodes.every((node) => node.status === 'COMPLETED')).toBe(true);
    } finally {
      delete process.env['FAKE_CLAUDE_SCENARIO'];
    }
  }, 240_000);

  it('scenario: a schema-valid plan with no steps escalates instead of killing the driver', async () => {
    process.env['FAKE_CLAUDE_SCENARIO'] = 'success';
    try {
      const fixture = driverFixture({
        defaultRunner: 'claude-code',
        useFakeClaude: true,
        // The local planner returns a PLAN decision with no goal and no
        // steps. It passes the contract schema and plans nothing.
        local: { scenario: 'empty-plan' },
        jobs: { budgets: { maxAgentRuns: 80 }, planReview: 'auto' },
      });
      const jobId = startJob(fixture);
      const result = await driveJob(fixture.driverDeps, jobId, {});

      // The vNext.10.1 StepRelay dogfood died here: SBO037 propagated out of
      // `plannerOutputToCandidate`, the supervisor logged DRIVER_DIED, and
      // the restart put the same local planner back in front of the same
      // empty plan. An unusable plan is an INTELLIGENCE failure of that
      // attempt, so it escalates to a worker that can plan.
      expect(result.stop.kind).toBe('completed');
      expect(
        result.job.escalations.some((entry) => entry.reason === 'INVALID_LOCAL_OUTPUT'),
      ).toBe(true);
      const graph = requireGraphRevision(fixture.workspace, jobId, result.job.graphRevision);
      expect(graph.nodes.every((node) => node.status === 'COMPLETED')).toBe(true);
      // No driver death, so no restart accounting was spent on it.
      expect(result.job.counters.jobReplans).toBe(0);
    } finally {
      delete process.env['FAKE_CLAUDE_SCENARIO'];
    }
  }, 240_000);

  it('scenario: manual escalation mode asks instead of spending paid reasoning', async () => {
    const fixture = driverFixture({
      local: false,
      jobs: { escalation: 'manual' },
    });
    const jobId = startJob(fixture);
    const result = await driveJob(fixture.driverDeps, jobId, {});
    // With no local worker, the first reasoning role would escalate; manual
    // mode records the question and stops.
    expect(result.stop.kind).toBe('needs-human');
    expect(result.job.status).toBe('NEEDS_CLARIFICATION');
    expect(result.job.openQuestions.length).toBeGreaterThan(0);
    expect(result.job.openQuestions[0]?.question).toContain('Escalate');
  }, 120_000);

  it('scenario: without git, the executor dispatch stops for the user instead of pretending', async () => {
    const fixture = driverFixture({ git: false });
    const jobId = startJob(fixture);
    const result = await driveJob(fixture.driverDeps, jobId, {});
    // A missing prerequisite (Git evidence) is a user decision, not a model
    // diagnosis: the job stops with a concrete recorded question.
    expect(result.stop.kind).toBe('needs-human');
    expect(result.job.status).toBe('NEEDS_CLARIFICATION');
    expect(result.job.openQuestions.some((question) => /git/i.test(question.question))).toBe(true);
  }, 120_000);

  it('scenario: the agent-run budget stops a job explicitly', async () => {
    const fixture = driverFixture({ jobs: { budgets: { maxAgentRuns: 2 } } });
    const jobId = startJob(fixture);
    const result = await driveJob(fixture.driverDeps, jobId, {});
    expect(result.stop.kind).toBe('blocked');
    expect(result.job.blocker?.category).toBe('BUDGET_EXHAUSTED');
    const trail = readJobEvents(fixture.workspace, jobId, { limit: 200 });
    expect(trail.events.some((event) => event.type === 'budget_exhausted')).toBe(true);
  }, 120_000);
});
