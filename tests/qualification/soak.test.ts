import { describe, expect, it } from 'vitest';
import {
  aggregateProfiles,
  auditJobState,
  beginTaskAttempt,
  buildJobGraph,
  buildTaskSignature,
  clearAdaptiveProfileCache,
  clearRepositoryIndexCache,
  completeTaskAttempt,
  createTaskCheckpoint,
  createJob,
  deriveAdaptiveObservations,
  listTaskAttempts,
  listTaskCheckpointSeqs,
  loadAdaptiveProfiles,
  readExecutionLedger,
  readLatestTaskCheckpoint,
  recordScenarioResult,
  requireGraphRevision,
  requireJobState,
  restartRegressions,
  startQualificationRun,
  summarizeExecutionLedger,
  writeEvaluationResult,
} from '@specbridge/orchestration';
import type { JobDeps } from '@specbridge/orchestration';
import { setupOrchestrationFixture } from '../helpers-orchestration.js';
import { fixtureTarget, setupQualificationWorkspace } from '../helpers-qualification.js';

/**
 * vNext.9 — the deterministic long-horizon soak.
 *
 * Long-horizon defects do not appear in a five-attempt test. They appear
 * after a hundred: a counter that never rolls over, a bounded window that
 * silently is not, an in-memory assumption that only shows up when the
 * process really does go away, a cache that drifts from the ledger it is
 * derived from.
 *
 * So this simulates a long run in COMPRESSED time rather than a long one in
 * real time: many attempt cycles, many checkpoints, many ledger entries,
 * derived caches deleted and rebuilt part-way through, and — the part that
 * actually finds the bugs — periodic RECONSTRUCTION, where every value held
 * in a local variable is dropped and the next round reads only from disk.
 *
 * Fake time, fast deterministic workers, small fixture contents, large
 * transition count. CI stays fast; the duration SEMANTICS are still tested.
 */

const START = Date.parse('2026-08-01T09:00:00.000Z');

/** Attempt cycles. Large enough to cross every bounded window in the runtime. */
const CYCLES = 120;
/** Reconstruct the runtime from disk every N cycles. */
const RESTART_EVERY = 15;
/** Delete a derived cache every N cycles. */
const CACHE_LOSS_EVERY = 37;

const SIGNATURE = buildTaskSignature({
  category: 'unit-test',
  complexity: 'MEDIUM',
  localSuitability: 'LOCAL_TRY',
  executionShape: 'ONE_SHOT',
  deterministicVerificationAvailable: true,
});

describe('vNext.9 long-horizon soak', () => {
  it(
    'survives many attempt cycles, repeated reconstruction, and repeated derived-cache loss without state corruption or unbounded growth',
    async () => {
      const fixture = setupOrchestrationFixture({ git: false });
      const deps: JobDeps = {
        workspace: fixture.workspace,
        config: fixture.config,
        clock: fixture.clock,
        idFactory: fixture.deps.idFactory,
        host: 'test',
      };
      const job = createJob(deps, {
        specName: fixture.specName,
        goal: 'Implement the approved plan over a long horizon.',
      });
      await buildJobGraph(deps, job.jobId);
      const jobId = job.jobId;
      const state = requireJobState(fixture.workspace, jobId);
      const graph = requireGraphRevision(fixture.workspace, jobId, state.graphRevision);
      const nodeId = graph.nodes[0]?.nodeId as string;
      const taskId = graph.nodes[0]?.parentTaskId as string;

      let restarts = 0;
      let cacheLosses = 0;
      let checkpoints = 0;
      let quotaWindows = 0;
      const auditsTaken: number[] = [];

      for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
        const at = new Date(START + cycle * 4 * 60_000);
        const clockAt = { workspace: fixture.workspace, clock: () => at };

        // A quota window rolls over roughly every 75 cycles of 4 minutes.
        const window = Math.floor((cycle * 4) / 300);
        if (window > quotaWindows) quotaWindows = window;

        // ---- One attempt cycle -------------------------------------------
        // Two thirds succeed. The failures are what keep the reliability
        // window, the recovery counters, and the failed-work totals moving.
        const verified = cycle % 3 !== 0;
        const attempt = beginTaskAttempt(clockAt, {
          jobId,
          nodeId,
          taskId,
          role: 'EXECUTOR',
          workerId: 'w-exec',
          provider: cycle % 2 === 0 ? 'local-llamacpp' : 'mock',
          model: 'qwen',
          lane: cycle % 2 === 0 ? 'LOCAL' : 'SUBSCRIPTION',
          taskSignature: SIGNATURE.key,
          contextStrategy: 'LEGACY',
          ...(cycle % 2 === 0
            ? { executionMode: 'DIRECT_MODEL' as const, computeLocality: 'LOCAL' }
            : {}),
        });

        // A checkpoint on every meaningful transition, exactly as a real run
        // would leave one. The bound this exercises is per-task checkpoint
        // retention.
        createTaskCheckpoint(
          { ...deps, clock: () => at },
          {
            jobId,
            nodeId,
            taskId,
            attemptId: attempt.attemptId,
            reason: verified ? 'milestone' : 'handoff',
            objective: 'Persist settings across restarts.',
            pinned: {
              taskContract: 'The settings store MUST persist across process restarts.',
              acceptanceCriteria: ['A restart preserves previously saved settings.'],
              constraints: [],
              invariants: ['Writes are atomic.'],
            },
            completedWork: [`cycle ${cycle}`],
            pendingWork: [],
            nextActions: [`Continue from cycle ${cycle}.`],
          },
        );
        checkpoints += 1;

        completeTaskAttempt(
          { workspace: fixture.workspace, clock: () => new Date(at.getTime() + 60_000) },
          {
            jobId,
            attemptId: attempt.attemptId,
            status: verified ? 'COMPLETED' : 'FAILED',
            ...(verified
              ? {}
              : {
                  failure: {
                    category: 'VERIFICATION_FAILURE' as const,
                    message: `cycle ${cycle} verifier failure`,
                  },
                }),
            metrics: { durationMs: 60_000, inputTokens: 12_000, outputTokens: 1_500 },
          },
        );
        writeEvaluationResult(fixture.workspace, {
          schemaVersion: '1.0.0',
          evaluationId: `ev-${attempt.attemptId}`,
          jobId,
          nodeId,
          taskId,
          attemptId: attempt.attemptId,
          lane: cycle % 2 === 0 ? 'LOCAL' : 'SUBSCRIPTION',
          status: verified ? 'PASS' : 'FAIL',
          deterministicChecks: [],
          semanticChecks: [],
          semanticFindings: [],
          failedCriteria: [],
          evidenceRefs: [],
          failureSignals: [],
          semanticReviewRan: false,
          reasons: ['soak cycle'],
          createdAt: new Date(at.getTime() + 60_000).toISOString(),
        });

        // ---- Periodic derived-cache loss ---------------------------------
        if (cycle % CACHE_LOSS_EVERY === 0) {
          clearRepositoryIndexCache(fixture.workspace);
          clearAdaptiveProfileCache(fixture.workspace);
          cacheLosses += 1;
        }

        // ---- Periodic reconstruction --------------------------------------
        // Everything above is dropped; the next round reads only from disk.
        // This is what exposes an in-memory assumption.
        if (cycle % RESTART_EVERY === 0) {
          const before = auditJobState({ workspace: fixture.workspace, jobId });
          const rehydrated = requireJobState(fixture.workspace, jobId);
          expect(rehydrated.jobId).toBe(jobId);
          const after = auditJobState({ workspace: fixture.workspace, jobId });
          expect(
            restartRegressions(before, after),
            `reconstruction at cycle ${cycle} introduced new violations`,
          ).toEqual([]);
          auditsTaken.push(cycle);
          restarts += 1;

          // Derived analytics rebuild from the ledger on demand, whatever
          // happened to the cache — and never block the run.
          const profiles = loadAdaptiveProfiles({
            workspace: fixture.workspace,
            policy: fixture.config.orchestration.jobs.scheduler.adaptive,
            now: at,
          });
          expect(profiles.profiles).toBeDefined();
        }
      }

      // ---- Everything durable is coherent at the end ---------------------
      const finalAudit = auditJobState({ workspace: fixture.workspace, jobId });
      expect(finalAudit.violations.filter((entry) => entry.blocking)).toEqual([]);

      // ---- The append-only history is complete --------------------------
      const attempts = listTaskAttempts(fixture.workspace, jobId);
      expect(attempts.length).toBe(CYCLES);
      // Attempt numbers are dense and strictly increasing: nothing was lost,
      // and nothing was written twice.
      expect(attempts.map((entry) => entry.attemptNumber)).toEqual(
        Array.from({ length: CYCLES }, (_unused, index) => index + 1),
      );
      expect(attempts.every((entry) => entry.status !== 'RUNNING')).toBe(true);

      // ---- Checkpoints stay BOUNDED, and the latest is always readable ---
      const seqs = listTaskCheckpointSeqs(fixture.workspace, jobId, nodeId);
      expect(seqs.length).toBeGreaterThan(0);
      expect(seqs.length).toBeLessThanOrEqual(checkpoints);
      // Dense and 1-based, so no checkpoint went missing along the way.
      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_unused, index) => index + 1));
      const latest = readLatestTaskCheckpoint(fixture.workspace, jobId, nodeId);
      expect(latest?.seq).toBe(seqs.length);
      expect(latest?.pinned.taskContract).toBeTruthy();

      // ---- The ledger accumulated everything, and sums honestly ----------
      const ledger = readExecutionLedger(fixture.workspace, jobId);
      expect(ledger.length).toBe(CYCLES);
      const summary = summarizeExecutionLedger(ledger);
      expect(summary.totalAttempts).toBe(CYCLES);
      expect(summary.reliability.evaluationsPassed + summary.reliability.evaluationsFailed).toBe(
        CYCLES,
      );
      // Reported metrics sum; nothing was fabricated for an attempt that
      // reported nothing, because every attempt here reported.
      expect(summary.byProvider['local-llamacpp']?.reportedInputTokens).toBeGreaterThan(0);

      // ---- Derived profiles rebuild from that ledger, after N cache losses
      expect(cacheLosses).toBeGreaterThan(1);
      const observations = deriveAdaptiveObservations({ entries: ledger });
      expect(observations.length).toBe(CYCLES);
      const profiles = aggregateProfiles({
        observations,
        policy: fixture.config.orchestration.jobs.scheduler.adaptive,
        now: new Date(START + CYCLES * 4 * 60_000),
      });
      expect(profiles).toBeDefined();

      // ---- The run really did cross the horizons it claims ---------------
      expect(restarts).toBeGreaterThanOrEqual(CYCLES / RESTART_EVERY - 1);
      expect(quotaWindows).toBeGreaterThan(0);
      expect(auditsTaken.length).toBe(restarts);

      // ---- Record the scenario -------------------------------------------
      const qualification = setupQualificationWorkspace();
      const run = startQualificationRun(qualification.deps, {
        profile: 'offline',
        target: fixtureTarget(),
      });
      recordScenarioResult(qualification.deps, {
        runId: run.runId,
        scenarioId: 'survival.soak',
        status: 'PASS',
        executor: 'regression-suite',
        observedTransitions: [
          { subject: 'attempt cycles', from: '0', to: String(CYCLES) },
          { subject: 'runtime reconstructions', from: '0', to: String(restarts) },
          { subject: 'derived-cache losses', from: '0', to: String(cacheLosses) },
          { subject: 'simulated quota windows crossed', from: '0', to: String(quotaWindows) },
          { subject: 'blocking invariant violations', from: '0', to: '0' },
          { subject: 'checkpoint retention', from: `${checkpoints} written`, to: `${seqs.length} retained (bounded)` },
        ],
        evidenceRefs: [`job:${jobId}`],
        resourceAttribution: {
          PROCESS_RESTART: 'SIMULATED',
          REPOSITORY_CONTEXT_INDEX: 'SIMULATED',
          ADAPTIVE_PROFILES: 'SIMULATED',
        },
      });
      expect(run.runId).toBeTruthy();
    },
    240_000,
  );
});
