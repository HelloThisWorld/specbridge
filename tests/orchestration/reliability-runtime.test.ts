import { describe, expect, it } from 'vitest';
import {
  CLAUDE_WORKER_ID,
  LOCAL_WORKER_ID,
  applyDiagnosis,
  beginExecutorDispatch,
  beginPlanning,
  buildJobGraph,
  completeExecutorDispatch,
  createJob,
  listEvaluationResults,
  listFailureAssessments,
  listRecoveryDecisions,
  readExecutionLedger,
  readJobEvents,
  readLatestTaskCheckpoint,
  readTaskReliabilityState,
  recordClassification,
  recordCriticVerdict,
  recordPlan,
  requireGraphRevision,
  requireJobState,
  summarizeExecutionLedger,
} from '@specbridge/orchestration';
import type {
  AttemptContext,
  ExecutorReliabilityInput,
  RecoveryResource,
} from '@specbridge/orchestration';
import { setupOrchestrationFixture } from '../helpers-orchestration.js';
import type { OrchestrationFixture } from '../helpers-orchestration.js';

/**
 * vNext.6 reliability runtime, at the job-service level.
 *
 * Fully offline and deterministic: no model, no network, no Git. The
 * dispatcher is simulated as the structured OBSERVATIONS a real one would
 * report, which is the point — the verdict and the recovery action are
 * computed inside the service from those observations, so a test can pin
 * exactly what SpecBridge decides without any runtime being involved.
 *
 * What every scenario here is really testing: that the evaluation, the
 * failure assessment, and the recovery decision are DURABLE and BINDING —
 * they survive a crash, they constrain what a diagnoser may do, and they are
 * what a later restart continues from rather than re-deriving.
 */

interface JobFixture extends OrchestrationFixture {
  jobId: string;
}

function jobFixture(policy: Record<string, unknown> = {}): JobFixture {
  const fixture = setupOrchestrationFixture({ policy: { jobs: policy } });
  const job = createJob(fixture.deps, {
    specName: fixture.specName,
    goal: 'Implement the approved settings-persistence plan.',
  });
  return { ...fixture, jobId: job.jobId };
}

function attemptContext(
  fixture: JobFixture,
  overrides: Partial<AttemptContext> & { nodeId: string; role: AttemptContext['role'] },
): AttemptContext {
  return { workerId: LOCAL_WORKER_ID, startedAt: fixture.clock().toISOString(), ...overrides };
}

async function planFirstNode(fixture: JobFixture): Promise<{ nodeId: string }> {
  await buildJobGraph(fixture.deps, fixture.jobId);
  const graph = requireGraphRevision(fixture.workspace, fixture.jobId, 1);
  const nodeId = graph.nodes[0]?.nodeId as string;
  recordClassification(fixture.deps, fixture.jobId, {
    context: attemptContext(fixture, { nodeId, role: 'CLASSIFIER' }),
    proposedClass: 'LOW',
  });
  beginPlanning(fixture.deps, fixture.jobId, nodeId);
  await recordPlan(fixture.deps, fixture.jobId, {
    context: attemptContext(fixture, { nodeId, role: 'PLANNER' }),
    candidate: {
      goal: 'Implement the settings store.',
      steps: [{ description: 'Create the persistence module.' }, { description: 'Wire the service.' }],
      testStrategy: 'Unit tests for save and failure paths.',
      verificationStrategy: 'Run the trusted verification commands.',
    },
    producedByTier: 'LOCAL_SMALL',
  });
  recordCriticVerdict(fixture.deps, fixture.jobId, {
    context: attemptContext(fixture, { nodeId, role: 'CRITIC' }),
    verdict: 'ACCEPT',
    reasons: ['Steps are ordered and verifiable.'],
  });
  return { nodeId };
}

const MAX_AVAILABLE: RecoveryResource = {
  subscriptionAvailable: true,
  subscriptionReturnsInMs: null,
  subscriptionWorkerConfigured: true,
  apiAuthorized: false,
  apiBudgetAvailable: false,
  localAvailable: true,
  localHarnessAvailable: false,
};

/** One simulated dispatch reporting the observations a real one would. */
function dispatch(
  fixture: JobFixture,
  nodeId: string,
  input: {
    runId: string;
    mode?: 'implement' | 'repair';
    /** Which trusted verifier results this attempt produced. */
    verifierPassed: boolean;
    changedFiles?: { path: string; contentHash: string }[];
    reliability?: Partial<ExecutorReliabilityInput>;
    /** Force the evidence pipeline's own verdict (defaults from the verifier). */
    evidenceStatus?: string;
  },
) {
  const mode = input.mode ?? 'implement';
  beginExecutorDispatch(fixture.deps, fixture.jobId, {
    nodeId,
    mode,
    workerId: CLAUDE_WORKER_ID,
    lane: 'SUBSCRIPTION',
  });
  return completeExecutorDispatch(fixture.deps, fixture.jobId, {
    context: attemptContext(fixture, {
      nodeId,
      role: 'EXECUTOR',
      workerId: CLAUDE_WORKER_ID,
      runId: input.runId,
    }),
    mode,
    evidenceStatus:
      input.evidenceStatus ?? (input.verifierPassed ? 'verified' : 'implemented-unverified'),
    changedFiles: input.changedFiles ?? [{ path: 'src/settings.ts', contentHash: `h-${input.runId}` }],
    reliability: {
      resource: MAX_AVAILABLE,
      verification: {
        configured: true,
        skipped: false,
        ran: true,
        commands: [
          {
            name: 'unit-tests',
            required: true,
            passed: input.verifierPassed,
            timedOut: false,
            ...(input.verifierPassed ? {} : { detail: 'settings.spec.ts > saves settings — failed' }),
          },
        ],
      },
      ...(input.reliability ?? {}),
    },
  });
}

// ---------------------------------------------------------------------------

describe('every attempt gets a durable verdict', () => {
  it('records a PASS evaluation for a verified attempt and clears health', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    const result = dispatch(fixture, nodeId, { runId: 'run-1', verifierPassed: true });

    expect(result.nextAction).toBe('node-complete');
    expect(result.evaluation?.status).toBe('PASS');

    const evaluations = listEvaluationResults(fixture.workspace, fixture.jobId, { nodeId });
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.status).toBe('PASS');
    expect(readTaskReliabilityState(fixture.workspace, fixture.jobId, nodeId)?.health).toBe('HEALTHY');
  });

  it('records a FAIL evaluation, an assessment, and a decision for a failed attempt', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    const result = dispatch(fixture, nodeId, { runId: 'run-1', verifierPassed: false });

    expect(result.evaluation?.status).toBe('FAIL');
    expect(result.recovery?.action).toBe('REPAIR');
    expect(result.nextAction).toBe('diagnose');

    expect(listFailureAssessments(fixture.workspace, fixture.jobId, { nodeId })).toHaveLength(1);
    expect(listRecoveryDecisions(fixture.workspace, fixture.jobId, { nodeId })).toHaveLength(1);
  });
});

describe('Test C (service level) — a contract failure keeps the task open', () => {
  it('refuses completion when tests pass but a deterministic criterion fails', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);

    const result = dispatch(fixture, nodeId, {
      runId: 'run-1',
      verifierPassed: true,
      // Evidence says verified; the approved contract says otherwise.
      reliability: {
        acceptanceCriteria: [
          {
            id: 'AC-1',
            text: 'settings must be persisted through the store module',
            check: { kind: 'pattern-present', value: 'settingsStore' },
          },
        ],
        criteriaEvidence: {
          existingPaths: new Set(['src/settings.ts']),
          changedPaths: ['src/settings.ts'],
          addedLines: ['export function save() { localStorage.setItem("x", "1"); }'],
          verifierResults: new Map([['unit-tests', true]]),
        },
      },
    });

    expect(result.evaluation?.status).toBe('FAIL');
    expect(result.evaluation?.failedCriteria).toEqual(['AC-1']);
    expect(result.nextAction).not.toBe('node-complete');

    const graph = requireGraphRevision(
      fixture.workspace,
      fixture.jobId,
      requireJobState(fixture.workspace, fixture.jobId).graphRevision,
    );
    expect(graph.nodes.find((node) => node.nodeId === nodeId)?.status).not.toBe('COMPLETED');
    expect(readJobEvents(fixture.workspace, fixture.jobId, { limit: 500 }).events.map((e) => e.type)).toContain(
      'evaluation_failed',
    );
  });
});

describe('Test F/G (service level) — repeated failure changes strategy', () => {
  it('detects the same failure with the same diff and stops repairing', async () => {
    const fixture = jobFixture({ budgets: { maxRepairCyclesPerTask: 3, maxNoProgressCycles: 2 } });
    const { nodeId } = await planFirstNode(fixture);

    const first = dispatch(fixture, nodeId, { runId: 'run-1', verifierPassed: false });
    expect(first.recovery?.action).toBe('REPAIR');

    // Diagnose, then repair — and produce a byte-identical result.
    applyDiagnosis(fixture.deps, fixture.jobId, {
      context: attemptContext(fixture, { nodeId, role: 'DIAGNOSER' }),
      category: 'VERIFICATION_FAILURE',
      planValidity: 'VALID',
      recommendedAction: 'REPAIR',
      rootCause: 'The save path does not write through the store.',
    });

    const second = dispatch(fixture, nodeId, {
      runId: 'run-2',
      mode: 'repair',
      verifierPassed: false,
      // Same tree, same failure: the same experiment run twice.
      changedFiles: [{ path: 'src/settings.ts', contentHash: 'h-run-1' }],
    });

    const state = readTaskReliabilityState(fixture.workspace, fixture.jobId, nodeId);
    expect(state?.health).toBe('STALLED');
    expect(second.recovery?.action).not.toBe('REPAIR');
    expect(second.recovery?.reasonCode).toBe('NO_PROGRESS_REPLAN');
    expect(second.recovery?.strategyChange).toBe('PLAN');

    const events = readJobEvents(fixture.workspace, fixture.jobId, { limit: 500 }).events.map(
      (event) => event.type,
    );
    expect(events).toContain('execution_stalled');
    expect(events).toContain('recovery_decided');
  });
});

describe('Test U/Z — recovery decisions are durable across a crash', () => {
  it('persists the decision before the next attempt and survives a restart', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    const result = dispatch(fixture, nodeId, { runId: 'run-1', verifierPassed: false });
    const decisionId = result.recovery?.decisionId as string;

    // Simulate a process crash: nothing in memory survives, only the disk.
    const restarted = setupRestart(fixture);

    const decisions = listRecoveryDecisions(restarted.workspace, fixture.jobId, { nodeId });
    expect(decisions.map((entry) => entry.decisionId)).toContain(decisionId);
    const persisted = decisions.find((entry) => entry.decisionId === decisionId);
    expect(persisted?.action).toBe('REPAIR');
    expect(persisted?.applied).toBe(false);
    // The decision carries everything needed to answer "why did we retry?"
    // without any of the process that made it still being alive.
    expect(persisted?.reasonCode).toBe('VERIFICATION_FAILED_REPAIRABLE');
    expect(persisted?.failureFingerprint).toBeTruthy();
    expect(persisted?.budgetSnapshot.repairsMax).toBeGreaterThan(0);
    expect(persisted?.health).toBe('DEGRADED');

    // The evaluation and the assessment survive with it.
    expect(listEvaluationResults(restarted.workspace, fixture.jobId, { nodeId })).toHaveLength(1);
    expect(listFailureAssessments(restarted.workspace, fixture.jobId, { nodeId })).toHaveLength(1);
    expect(
      readTaskReliabilityState(restarted.workspace, fixture.jobId, nodeId)?.pendingDecisionId,
    ).toBe(decisionId);
  });

  it('continues the recorded decision rather than inventing a different one', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    dispatch(fixture, nodeId, { runId: 'run-1', verifierPassed: false });

    // A diagnoser that would prefer something else does not get to have it:
    // the persisted decision was REPAIR and it binds.
    const applied = applyDiagnosis(fixture.deps, fixture.jobId, {
      context: attemptContext(fixture, { nodeId, role: 'DIAGNOSER' }),
      category: 'VERIFICATION_FAILURE',
      planValidity: 'VALID',
      recommendedAction: 'RETRY',
      rootCause: 'Probably just flaky; try again.',
    });
    expect(applied.applied).toBe('repair');

    const decisions = listRecoveryDecisions(fixture.workspace, fixture.jobId, { nodeId });
    expect(decisions.at(-1)?.applied).toBe(true);
  });
});

describe('a diagnosis may narrow toward caution but never widen', () => {
  it('lets an INVALID plan finding turn a repair into a replan', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    const failed = dispatch(fixture, nodeId, { runId: 'run-1', verifierPassed: false });
    expect(failed.recovery?.action).toBe('REPAIR');

    const applied = applyDiagnosis(fixture.deps, fixture.jobId, {
      context: attemptContext(fixture, { nodeId, role: 'DIAGNOSER' }),
      category: 'VERIFICATION_FAILURE',
      planValidity: 'INVALID',
      recommendedAction: 'REPLAN',
      rootCause: 'The repository has no service interface to wire the store behind.',
    });
    expect(applied.applied).toBe('replan');
    expect(applied.job.status).toBe('REPLANNING');
  });

  it('refuses to let a diagnoser turn a stalled task back into a repair', async () => {
    const fixture = jobFixture({ budgets: { maxNoProgressCycles: 2 } });
    const { nodeId } = await planFirstNode(fixture);
    dispatch(fixture, nodeId, { runId: 'run-1', verifierPassed: false });
    applyDiagnosis(fixture.deps, fixture.jobId, {
      context: attemptContext(fixture, { nodeId, role: 'DIAGNOSER' }),
      category: 'VERIFICATION_FAILURE',
      planValidity: 'VALID',
      recommendedAction: 'REPAIR',
      rootCause: 'One more go.',
    });
    const second = dispatch(fixture, nodeId, {
      runId: 'run-2',
      mode: 'repair',
      verifierPassed: false,
      changedFiles: [{ path: 'src/settings.ts', contentHash: 'h-run-1' }],
    });
    expect(second.recovery?.action).toBe('REPLAN');

    const applied = applyDiagnosis(fixture.deps, fixture.jobId, {
      context: attemptContext(fixture, { nodeId, role: 'DIAGNOSER' }),
      category: 'VERIFICATION_FAILURE',
      planValidity: 'VALID',
      // The diagnoser asks for another identical attempt. It does not get one.
      recommendedAction: 'REPAIR',
      rootCause: 'I think one more repair would do it.',
    });
    expect(applied.applied).toBe('replan');
  });
});

describe('Test D (service level) — broken verification is INCONCLUSIVE', () => {
  it('retries the attempt instead of blaming the implementation', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);

    const result = dispatch(fixture, nodeId, {
      runId: 'run-1',
      verifierPassed: false,
      reliability: {
        verification: {
          configured: true,
          skipped: false,
          ran: true,
          commands: [
            {
              name: 'integration-tests',
              required: true,
              passed: false,
              timedOut: false,
              unavailable: true,
              detail: 'the integration environment is unavailable',
            },
          ],
        },
      },
    });

    expect(result.evaluation?.status).toBe('INCONCLUSIVE');
    expect(result.recovery?.action).toBe('RETRY_TRANSIENT');
    expect(result.recovery?.reasonCode).toBe('INFRASTRUCTURE_RETRY');
    const assessment = listFailureAssessments(fixture.workspace, fixture.jobId, { nodeId }).at(-1);
    expect(assessment?.source).toBe('VERIFICATION_INFRASTRUCTURE');
    expect(readJobEvents(fixture.workspace, fixture.jobId, { limit: 500 }).events.map((e) => e.type)).toContain(
      'evaluation_inconclusive',
    );
  });
});

describe('Test I (service level) — a runaway attempt is stopped and recovered', () => {
  it('reports RUNAWAY and rebuilds context rather than repeating', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);

    const result = dispatch(fixture, nodeId, {
      runId: 'run-1',
      verifierPassed: false,
      reliability: {
        // The runtime looped: hundreds of tool calls, same test over and over.
        activity: { toolCalls: 5_000, commandRuns: 900, testLoops: 400, emptyDiff: false },
      },
    });

    const assessment = listFailureAssessments(fixture.workspace, fixture.jobId, { nodeId }).at(-1);
    expect(assessment?.health).toBe('RUNAWAY');
    expect(assessment?.runawaySignals).toContain('TOOL_CALL_BUDGET');
    expect(result.recovery?.action).toBe('RESTART_FRESH_CONTEXT');
    expect(result.recovery?.nextStrategy?.freshContext).toBe(true);

    const events = readJobEvents(fixture.workspace, fixture.jobId, { limit: 500 }).events.map(
      (event) => event.type,
    );
    expect(events).toContain('execution_runaway');
    expect(events).toContain('fresh_context_selected');
  });
});

describe('Test X — dependents wait for a verified predecessor', () => {
  it('leaves a dependent node PENDING while its predecessor fails evaluation', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    const graphBefore = requireGraphRevision(fixture.workspace, fixture.jobId, 1);
    const dependents = graphBefore.nodes.filter((node) => node.dependsOn.includes(nodeId));

    dispatch(fixture, nodeId, { runId: 'run-1', verifierPassed: false });

    const job = requireJobState(fixture.workspace, fixture.jobId);
    const graph = requireGraphRevision(fixture.workspace, fixture.jobId, job.graphRevision);
    for (const dependent of dependents) {
      const current = graph.nodes.find((node) => node.nodeId === dependent.nodeId);
      expect(current?.status).toBe('PENDING');
    }
    expect(graph.nodes.find((node) => node.nodeId === nodeId)?.status).not.toBe('COMPLETED');
  });

  it('promotes dependents only once the predecessor passes evaluation', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    const graphBefore = requireGraphRevision(fixture.workspace, fixture.jobId, 1);
    const dependents = graphBefore.nodes.filter((node) => node.dependsOn.includes(nodeId));

    dispatch(fixture, nodeId, { runId: 'run-1', verifierPassed: true });

    const job = requireJobState(fixture.workspace, fixture.jobId);
    const graph = requireGraphRevision(fixture.workspace, fixture.jobId, job.graphRevision);
    expect(graph.nodes.find((node) => node.nodeId === nodeId)?.status).toBe('COMPLETED');
    for (const dependent of dependents) {
      expect(graph.nodes.find((node) => node.nodeId === dependent.nodeId)?.status).toBe('READY');
    }
  });
});

describe('Test Y — a semantic reviewer has no authority over evidence', () => {
  it('cannot rescue an attempt whose trusted verifier failed', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    const result = dispatch(fixture, nodeId, {
      runId: 'run-1',
      verifierPassed: false,
      reliability: {
        semantic: {
          ran: true,
          verdict: 'PASS',
          findings: [{ severity: 'note', observation: 'the design reads well' }],
        },
      },
    });

    expect(result.evaluation?.status).toBe('FAIL');
    expect(result.evaluation?.semanticReviewRan).toBe(false);
    // The opinion is RECORDED and visibly inert, which is what makes the
    // invariant auditable rather than merely true.
    expect(result.evaluation?.semanticChecks[0]?.outcome).toBe('NOT_RUN');
    expect(result.evaluation?.semanticChecks[0]?.detail).toContain('cannot override');
  });

  it('never writes to the repository: its output is findings only', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    const result = dispatch(fixture, nodeId, {
      runId: 'run-1',
      verifierPassed: true,
      reliability: {
        semantic: {
          ran: true,
          verdict: 'FAIL',
          findings: [
            {
              severity: 'blocking',
              observation: 'introduces a second source of truth for job state',
              path: 'src/settings.ts',
            },
          ],
        },
      },
    });

    // A blocking finding can FAIL a passing attempt — the conservative
    // direction — and the record holds structured findings, never a patch.
    expect(result.evaluation?.status).toBe('FAIL');
    const finding = result.evaluation?.semanticFindings[0];
    expect(finding?.severity).toBe('blocking');
    expect(Object.keys(finding ?? {})).not.toContain('patch');
    expect(Object.keys(finding ?? {})).not.toContain('edits');
  });
});

describe('Test O — failed approaches reach the next attempt', () => {
  it('carries the failure into the durable checkpoint the next worker reads', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    dispatch(fixture, nodeId, { runId: 'run-1', verifierPassed: false });
    // The state machine requires a diagnosis between a failure and the next
    // mutation attempt; that rule is the reason a failed approach is durable
    // before anything else runs.
    applyDiagnosis(fixture.deps, fixture.jobId, {
      context: attemptContext(fixture, { nodeId, role: 'DIAGNOSER' }),
      category: 'VERIFICATION_FAILURE',
      planValidity: 'VALID',
      recommendedAction: 'REPAIR',
      rootCause: 'The save path does not write through the store.',
    });
    dispatch(fixture, nodeId, { runId: 'run-2', mode: 'repair', verifierPassed: true });

    const checkpoint = readLatestTaskCheckpoint(fixture.workspace, fixture.jobId, nodeId);
    expect(checkpoint).toBeDefined();
    // The pinned contract is immune to compaction by construction: it is
    // re-read from here rather than remembered from any conversation.
    expect(checkpoint?.pinned.taskContract).toBeTruthy();

    const assessments = listFailureAssessments(fixture.workspace, fixture.jobId, { nodeId });
    expect(assessments).toHaveLength(1);
    expect(assessments[0]?.likelyCause).toContain('VERIFICATION_FAILURE');
    expect(assessments[0]?.fingerprint).toBeTruthy();
  });
});

describe('the ledger records what failure cost', () => {
  it('attributes evaluation, source, health, and recovery onto each attempt', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    dispatch(fixture, nodeId, { runId: 'run-1', verifierPassed: false });

    const ledger = readExecutionLedger(fixture.workspace, fixture.jobId, { nodeId });
    const executor = ledger.filter((entry) => entry.role === 'EXECUTOR');
    expect(executor).toHaveLength(1);
    expect(executor[0]?.evaluationStatus).toBe('FAIL');
    expect(executor[0]?.failureSource).toBe('IMPLEMENTATION');
    expect(executor[0]?.executionHealth).toBe('DEGRADED');
    expect(executor[0]?.recoveryAction).toBe('REPAIR');
    expect(executor[0]?.failureFingerprint).toBeTruthy();

    const summary = summarizeExecutionLedger(ledger);
    expect(summary.reliability.evaluationsFailed).toBe(1);
    expect(summary.reliability.failedAttempts).toBe(1);
    expect(summary.reliability.recoveryActions['REPAIR']).toBe(1);
    expect(summary.reliability.failureSources['IMPLEMENTATION']).toBe(1);
  });

  it('leaves pre-vNext.6 attribution null rather than fabricating it', async () => {
    // Governance off: the records are not written, and the ledger says so
    // honestly instead of inventing a verdict for an ungoverned attempt.
    const fixture = jobFixture({ reliability: { enabled: false } });
    const { nodeId } = await planFirstNode(fixture);
    dispatch(fixture, nodeId, { runId: 'run-1', verifierPassed: false });

    const executor = readExecutionLedger(fixture.workspace, fixture.jobId, { nodeId }).filter(
      (entry) => entry.role === 'EXECUTOR',
    );
    expect(executor[0]?.recoveryAction).toBeNull();
    expect(executor[0]?.failureSource).toBeNull();
    expect(listRecoveryDecisions(fixture.workspace, fixture.jobId, { nodeId })).toHaveLength(0);
  });
});

describe('backward compatibility', () => {
  it('keeps the pre-vNext.6 cascade when reliability governance is disabled', async () => {
    const fixture = jobFixture({ reliability: { enabled: false } });
    const { nodeId } = await planFirstNode(fixture);
    const result = dispatch(fixture, nodeId, { runId: 'run-1', verifierPassed: false });

    // The legacy path routes a repairable failure to DIAGNOSING, unchanged.
    expect(result.nextAction).toBe('diagnose');
    expect(result.recovery).toBeUndefined();
    // Evaluations are still WRITTEN — governance is off, observability is not.
    expect(listEvaluationResults(fixture.workspace, fixture.jobId, { nodeId })).toHaveLength(1);
  });

  it('completes a verified task even with no acceptance criteria configured', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    const result = dispatch(fixture, nodeId, { runId: 'run-1', verifierPassed: true });
    expect(result.nextAction).toBe('node-complete');
  });
});

/**
 * Re-resolve every durable reader from disk, as a restarted process would.
 *
 * The fixture's own workspace object is reused deliberately: it is a path
 * descriptor, not a cache, so reading through it after "the crash" reads the
 * files exactly as a new process would. Anything that had been held only in
 * memory is gone from this point on.
 */
function setupRestart(fixture: JobFixture): { workspace: JobFixture['workspace'] } {
  return { workspace: fixture.workspace };
}
