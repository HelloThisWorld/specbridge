import { describe, expect, it } from 'vitest';
import {
  ContextLifecycleManager,
  contextBudgetConfigSchema,
  itemsInLayer,
} from '@specbridge/context';
import type { ContextItem, ContextLifecycleEvent } from '@specbridge/context';
import {
  beginTaskAttempt,
  buildJobGraph,
  completeTaskAttempt,
  createJob,
  createTaskCheckpoint,
  reconstructTaskContext,
  recordScenarioResult,
  requireGraphRevision,
  requireJobState,
  startQualificationRun,
} from '@specbridge/orchestration';
import type { JobDeps } from '@specbridge/orchestration';
import { setupOrchestrationFixture } from '../helpers-orchestration.js';
import { fixtureTarget, setupQualificationWorkspace } from '../helpers-qualification.js';

/**
 * vNext.9 — crossing several effective context windows.
 *
 * The claim, in the phase's own words: AutoCompact never terminates the Job,
 * and critical truth is never retrieved probabilistically. Both halves need
 * proving together, because a compaction strategy that kept the job alive by
 * dropping the task contract would satisfy the first and destroy the second.
 *
 * So this drives enough accumulated history to cross a small effective window
 * many times over, and checks at every compaction that:
 *
 *   the PINNED layer — task contract, acceptance criteria, invariants — is
 *   still present verbatim, because it is re-read from durable state rather
 *   than summarized;
 *
 *   compaction happened at more than one level;
 *
 *   the manager never refuses to continue.
 *
 * A deliberately small budget stands in for a long run: the ratio that
 * triggers compaction is what matters, not the absolute token count, and a
 * small window crossed twenty times exercises the same transitions as a
 * large one crossed twenty times.
 */

const START = '2026-08-01T09:00:00.000Z';

/** A small window, so a few dozen items cross it repeatedly. */
const SMALL_BUDGET = contextBudgetConfigSchema.parse({
  modelContextTokens: 8_000,
  reservedOutputTokens: 1_000,
  reservedReasoningTokens: 500,
  reservedGrowthTokens: 500,
  prepareThreshold: 0.4,
  proactiveCompactionThreshold: 0.5,
  emergencyCompactionThreshold: 0.65,
  hardStopThreshold: 0.8,
});

const PINNED_CONTRACT = 'The settings store MUST persist across process restarts.';
const PINNED_INVARIANT = 'Writes are atomic: write to a temporary file, fsync, then rename.';

function pinnedItem(): ContextItem {
  return {
    itemId: 'pinned-contract',
    layer: 'PINNED',
    kind: 'contract',
    title: 'Task contract',
    content: `${PINNED_CONTRACT}\n${PINNED_INVARIANT}`,
    createdAt: START,
    source: 'checkpoint',
    compacted: false,
  } as ContextItem;
}

function bulkyItem(index: number, layer: ContextItem['layer']): ContextItem {
  return {
    itemId: `bulk-${layer}-${index}`,
    layer,
    kind: 'note',
    title: `Working note ${index}`,
    // Roughly 400 tokens each, so a handful crosses the small window.
    content: `Observation ${index}. ${'verification output line. '.repeat(60)}`,
    createdAt: START,
    source: 'test',
    compacted: false,
  } as ContextItem;
}

describe('vNext.9 multi-window context compaction', () => {
  it('crosses many effective context windows, compacts at more than one level, and never loses pinned truth', () => {
    const events: ContextLifecycleEvent[] = [];
    let tick = Date.parse(START);
    const manager = new ContextLifecycleManager({
      budget: SMALL_BUDGET,
      clock: () => new Date((tick += 1_000)),
      onEvent: (event) => events.push(event),
    });

    manager.add(pinnedItem());

    let microCompactions = 0;
    let milestoneCompactions = 0;
    let windowsCrossed = 0;
    const usable = manager.usableBudgetTokens();

    // Twenty milestones, each adding enough bulk to cross the window.
    for (let milestone = 1; milestone <= 20; milestone += 1) {
      for (let index = 0; index < 6; index += 1) {
        manager.add(bulkyItem(milestone * 100 + index, 'WORKING_SET'));
        manager.add(bulkyItem(milestone * 1000 + index, 'RECENT_DELTA'));
      }
      if (manager.estimatedTokens() > usable * SMALL_BUDGET.proactiveCompactionThreshold) {
        windowsCrossed += 1;
        manager.microCompact();
        microCompactions += 1;
      }
      // Every few milestones a checkpoint folds the history away — the
      // milestone level, which is the one that keeps a long run affordable.
      if (milestone % 4 === 0) {
        manager.milestoneCompact(`cp-${milestone}`);
        milestoneCompactions += 1;
      }

      // The invariant, checked at EVERY milestone rather than at the end:
      // pinned truth is still present, verbatim, after every compaction.
      const pinned = itemsInLayer(manager.currentItems(), 'PINNED');
      expect(pinned.length, `milestone ${milestone} lost the pinned layer`).toBeGreaterThan(0);
      expect(pinned.map((item) => item.content).join('\n')).toContain(PINNED_CONTRACT);
      expect(pinned.map((item) => item.content).join('\n')).toContain(PINNED_INVARIANT);
      // And no pinned item was ever marked compacted — it is re-read, not
      // summarized.
      expect(pinned.every((item) => item.compacted !== true)).toBe(true);
    }

    // ---- Emergency pressure is a normal operation, not a failure --------
    for (let index = 0; index < 40; index += 1) {
      manager.add(bulkyItem(90_000 + index, 'WORKING_SET'));
    }
    const assembled = manager.assemble({ checkpointId: 'cp-final' });
    expect(assembled.package).toBeDefined();
    const levels = new Set(
      [...manager.compactionHistory(), ...assembled.package.compactions].map(
        (record) => record.level,
      ),
    );
    // More than one level fired across the run, which is what "multi-window"
    // means: the cheap pass could not hold it alone.
    expect(levels.size).toBeGreaterThan(1);
    expect(levels.has('micro')).toBe(true);

    // The job continues: assembly produced a usable package under budget.
    const finalPinned = itemsInLayer(assembled.package.items, 'PINNED');
    expect(finalPinned.map((item) => item.content).join('\n')).toContain(PINNED_CONTRACT);
    expect(windowsCrossed).toBeGreaterThan(3);
    expect(microCompactions).toBeGreaterThan(3);
    expect(milestoneCompactions).toBeGreaterThan(3);
    // Cumulative pressure far exceeded the window, which is the point.
    expect(manager.cumulativeTokens()).toBeGreaterThan(usable * 3);

    const qualification = setupQualificationWorkspace();
    const run = startQualificationRun(qualification.deps, {
      profile: 'offline',
      target: fixtureTarget(),
    });
    recordScenarioResult(qualification.deps, {
      runId: run.runId,
      scenarioId: 'context.multi-window-compaction',
      status: 'PASS',
      executor: 'regression-suite',
      observedTransitions: [
        {
          subject: 'cumulative context pressure vs usable window',
          from: `${usable} usable`,
          to: `${manager.cumulativeTokens()} cumulative`,
        },
        { subject: 'compaction levels observed', from: 'none', to: [...levels].join(', ') },
        { subject: 'pinned contract after every compaction', from: 'present', to: 'present' },
        { subject: 'job continuation', from: 'under pressure', to: 'assembly succeeded' },
      ],
      resourceAttribution: { CONTEXT_COMPACTION: 'SIMULATED' },
    });
    expect(run.runId).toBeTruthy();
  });

  it('reconstructs a task under a tiny budget without dropping the contract', async () => {
    // The same claim, but through the real reconstruction path over durable
    // records: a fresh worker asking for context on a task with a long
    // history, on a model whose window is far too small for that history.
    const fixture = setupOrchestrationFixture({ git: false });
    const deps: JobDeps = {
      workspace: fixture.workspace,
      config: fixture.config,
      clock: fixture.clock,
      idFactory: fixture.deps.idFactory,
      host: 'test',
    };
    const job = createJob(deps, { specName: fixture.specName, goal: 'Implement the plan.' });
    await buildJobGraph(deps, job.jobId);
    const state = requireJobState(fixture.workspace, job.jobId);
    const graph = requireGraphRevision(fixture.workspace, job.jobId, state.graphRevision);
    const nodeId = graph.nodes[0]?.nodeId as string;
    const taskId = graph.nodes[0]?.parentTaskId as string;

    for (let index = 1; index <= 20; index += 1) {
      const attempt = beginTaskAttempt(
        { workspace: fixture.workspace, clock: fixture.clock },
        {
          jobId: job.jobId,
          nodeId,
          taskId,
          role: 'EXECUTOR',
          workerId: `w-${index}`,
          provider: 'local-llamacpp',
          lane: 'LOCAL',
        },
      );
      createTaskCheckpoint(deps, {
        jobId: job.jobId,
        nodeId,
        taskId,
        attemptId: attempt.attemptId,
        reason: 'milestone',
        objective: 'Persist settings across restarts.',
        pinned: {
          taskContract: PINNED_CONTRACT,
          acceptanceCriteria: ['A restart preserves previously saved settings.'],
          constraints: [],
          invariants: [PINNED_INVARIANT],
        },
        completedWork: [`Attempt ${index}: ${'explored the flush path. '.repeat(20)}`],
        pendingWork: [],
        nextActions: [`Continue from attempt ${index}.`],
      });
      completeTaskAttempt(
        { workspace: fixture.workspace, clock: fixture.clock },
        {
          jobId: job.jobId,
          attemptId: attempt.attemptId,
          status: 'FAILED',
          failure: { category: 'VERIFICATION_FAILURE', message: `attempt ${index} failed` },
        },
      );
    }

    const reconstructed = reconstructTaskContext(deps, {
      jobId: job.jobId,
      nodeId,
      budget: SMALL_BUDGET,
      workingSet: Array.from({ length: 30 }, (_unused, index) =>
        bulkyItem(index, 'WORKING_SET'),
      ),
    });

    // The package fits the tiny window…
    const usable =
      SMALL_BUDGET.modelContextTokens -
      SMALL_BUDGET.reservedOutputTokens -
      SMALL_BUDGET.reservedReasoningTokens -
      SMALL_BUDGET.reservedGrowthTokens;
    expect(reconstructed.assembled.package.usage.estimatedTokens).toBeLessThanOrEqual(usable);
    // …compaction ran to make it fit…
    expect(reconstructed.assembled.compactions.length).toBeGreaterThan(0);
    // …and the contract survived it, because it is re-read from the
    // checkpoint rather than remembered.
    const rendered = reconstructed.assembled.package.items
      .map((item) => item.content)
      .join('\n');
    expect(rendered).toContain(PINNED_CONTRACT);
    expect(rendered).toContain(PINNED_INVARIANT);
  });
});
