import { describe, expect, it } from 'vitest';
import type { UnattendedResult } from '@specbridge/autonomy';
import {
  latestExecutableSeal,
  readClosureLedger,
  readSealBinding,
  requireSeal,
} from '@specbridge/autonomy';
import { readJobState, requireJobState } from '@specbridge/orchestration';
import { requireMissionState } from '@specbridge/mission';
import { readSpecState } from '@specbridge/core';
import {
  BUILD_LIFECYCLE_STEPS,
  answerIntakeQuestion,
  approveIntake,
  computeIntakeTelemetry,
  isStepSettled,
  readIntakeEvents,
  readLifecycle,
  requireIntakeState,
  runIntakeDiscovery,
  runSealAndBuild,
  startSpecIntake,
  writeLifecycle,
} from '@specbridge/intake';
import { allAvailableProbeRunner, fakeProbeRunner } from '../helpers-autonomy.js';
import type { IntakeFixture } from '../helpers-intake.js';
import { goldenSpecText, setupIntakeFixture } from '../helpers-intake.js';

/**
 * §8, §9 and §10 — the atomic seal-and-build transition.
 *
 * One product operation, nine durable transactions. The tests that matter
 * are the ones about the gap between those two facts:
 *
 *   a crash halfway through is RESUMABLE and IDEMPOTENT, and
 *   a prerequisite only a person can satisfy stops BEFORE a job exists.
 *
 * Everything is offline. Every preflight probe is injected, so the tests
 * assert the classification logic rather than whatever happens to be
 * installed on the machine running them.
 */

function approvedGoldenIntake(fixture: IntakeFixture): string {
  const started = startSpecIntake(fixture.intake, {
    name: 'steprelay-workbench',
    kind: 'text',
    content: goldenSpecText(),
  });
  const id = started.intake.intakeId;
  let discovery = runIntakeDiscovery(fixture.intake, id);
  for (const question of discovery.questions.filter((q) => q.status === 'open')) {
    discovery = answerIntakeQuestion(fixture.intake, id, {
      questionId: question.questionId,
      answer: question.options[0] ?? 'The strict reading holds.',
    }).discovery;
  }
  approveIntake(fixture.intake, { intakeId: id, via: 'test' });
  return id;
}

describe('seal-and-build — the full transition', () => {
  it('runs every step from the approval to a launchable job', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const id = approvedGoldenIntake(fixture);

    const result = await runSealAndBuild(fixture.intake, {
      intakeId: id,
      launch: false,
      probeRunner: allAvailableProbeRunner(),
    });

    expect(result.outcome).toBe('LAUNCHED');
    // Every step settled, in order, with nothing skipped that mattered.
    const byStep = new Map(result.lifecycle.steps.map((step) => [step.step, step.status]));
    for (const step of BUILD_LIFECYCLE_STEPS) {
      if (step === 'LAUNCH') continue;
      expect(isStepSettled(byStep.get(step) ?? 'PENDING'), step).toBe(true);
    }
    expect(byStep.get('LAUNCH')).toBe('SKIPPED');

    // The mission advanced, the spec exists and is approved, the seal is
    // authorized, and the job is bound to it.
    const mission = requireMissionState(fixture.workspace, result.lifecycle.missionId);
    expect(mission.status).toBe('SPEC_REVIEW');
    expect(mission.specName).toBe(result.lifecycle.specName);

    const seal = requireSeal(fixture.workspace, result.lifecycle.sealId as string);
    expect(seal.status).toBe('SEALED');
    // The channel is the intake approval, not a person typing a seal
    // command — nobody did that, and the record says so.
    expect(seal.sealedVia).toContain('intake-approval:');
    expect(seal.contracts.length).toBeGreaterThan(0);
    expect(seal.acceptanceCriteria.length).toBeGreaterThan(0);

    const jobId = result.lifecycle.jobId as string;
    expect(readJobState(fixture.workspace, jobId).kind).toBe('ok');
    const intake = requireIntakeState(fixture.workspace, id);
    expect(intake.jobId).toBe(jobId);
    expect(intake.sealId).toBe(seal.sealId);
  });

  it('runs preflight automatically and records the report', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const id = approvedGoldenIntake(fixture);
    const result = await runSealAndBuild(fixture.intake, {
      intakeId: id,
      launch: false,
      probeRunner: allAvailableProbeRunner(),
    });
    expect(result.preflight?.verdict).toBe('OVERNIGHT_READY');
    expect(result.lifecycle.preflightReportId).toBe(result.preflight?.reportId);
    const events = readIntakeEvents(fixture.workspace, id).events;
    const preflight = events.find((event) => event['type'] === 'preflight_completed');
    expect(preflight?.['verdict']).toBe('OVERNIGHT_READY');
  });

  it('resolves prerequisites the runtime is authorized to provide', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const id = approvedGoldenIntake(fixture);
    // Docker present but the browser binary absent: the Toolsmith grants
    // BROWSER_RUNTIME, so preflight classifies it SATISFIABLE_AUTONOMOUSLY
    // rather than blocking on it.
    const result = await runSealAndBuild(fixture.intake, {
      intakeId: id,
      launch: false,
      probeRunner: fakeProbeRunner({
        docker: { ok: true, output: 'Docker version 29.1.3' },
        'docker info --format {{.ServerVersion}}': { ok: true, output: '29.1.3' },
        'docker compose version': { ok: true, output: 'Docker Compose version v2' },
        node: { ok: true, output: 'v20.17.0' },
        pnpm: { ok: true, output: '9.15.9' },
        git: { ok: true, output: 'git version 2.45.0' },
      }),
    });

    expect(result.outcome).toBe('LAUNCHED');
    expect(result.humanPrerequisites).toEqual([]);
    expect(result.lifecycle.resolvedPrerequisites.length).toBeGreaterThan(0);
    // Pre-authorized through the broker while somebody is still awake,
    // rather than discovered at 03:00.
    expect(result.lifecycle.resolvedPrerequisites.join(' ')).toMatch(/pre-authorized|runtime provides/);
    const events = readIntakeEvents(fixture.workspace, id).events;
    expect(events.some((event) => event['type'] === 'prerequisite_resolved')).toBe(true);
  });

  it('STOPS BEFORE CREATING A JOB when a human-only prerequisite remains', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const id = approvedGoldenIntake(fixture);
    // Nothing is available: installing a container runtime is a machine-level
    // act no policy can delegate.
    const result = await runSealAndBuild(fixture.intake, {
      intakeId: id,
      launch: false,
      probeRunner: fakeProbeRunner({}),
    });

    expect(result.outcome).toBe('HUMAN_PREREQUISITE_REQUIRED');
    expect(result.humanPrerequisites.length).toBeGreaterThan(0);
    // The refusal names what a person must do.
    expect(result.humanPrerequisites.join(' ')).toMatch(/could not be established|install|start/i);

    // No half-started unattended job exists.
    expect(result.lifecycle.jobId).toBeUndefined();
    const byStep = new Map(result.lifecycle.steps.map((step) => [step.step, step.status]));
    expect(byStep.get('SEAL')).toBe('COMPLETED');
    expect(byStep.get('RESOLVE_PREREQUISITES')).toBe('FAILED');
    expect(byStep.get('CREATE_JOB')).toBe('PENDING');
    expect(byStep.get('LAUNCH')).toBe('PENDING');
    expect(requireIntakeState(fixture.workspace, id).status).toBe('BLOCKED');
  });

  it('resumes idempotently after a crash halfway through', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const id = approvedGoldenIntake(fixture);

    // A first pass that gets as far as the seal, then "crashes": the ledger
    // is rewound to a RUNNING record for a step whose effect already exists
    // on disk, which is exactly the state a process killed mid-step leaves.
    await runSealAndBuild(fixture.intake, {
      intakeId: id,
      launch: false,
      probeRunner: allAvailableProbeRunner(),
    });
    const complete = readLifecycle(fixture.workspace, id);
    expect(complete?.outcome).toBe('LAUNCHED');
    const specName = complete?.specName as string;
    const sealId = complete?.sealId as string;
    const jobId = complete?.jobId as string;

    // Rewind: the ledger claims SYNTHESIZE was mid-flight and everything
    // after it never happened. Durable reality says otherwise.
    writeLifecycle(fixture.workspace, {
      ...(complete as NonNullable<typeof complete>),
      outcome: undefined,
      finishedAt: undefined,
      steps: (complete as NonNullable<typeof complete>).steps.map((step) => {
        if (step.step === 'CONTRACT_READY') return step;
        if (step.step === 'SYNTHESIZE') return { ...step, status: 'RUNNING' as const };
        return { step: step.step, status: 'PENDING' as const, attempts: 0 };
      }),
      specName: undefined,
      sealId: undefined,
      jobId: undefined,
    } as never);

    const resumed = await runSealAndBuild(fixture.intake, {
      intakeId: id,
      launch: false,
      probeRunner: allAvailableProbeRunner(),
    });

    expect(resumed.outcome).toBe('LAUNCHED');
    // Reconciled, not re-run: the spec was not synthesized twice and the
    // seal was not re-authorized.
    const byStep = new Map(resumed.lifecycle.steps.map((step) => [step.step, step.status]));
    expect(byStep.get('SYNTHESIZE')).toBe('RECONCILED');
    expect(byStep.get('DERIVE_APPROVALS')).toBe('RECONCILED');
    expect(resumed.lifecycle.specName).toBe(specName);
    // A brand-new seal WOULD be a second authorization for one human
    // decision; the approval binds exactly one, and rebinding is refused.
    expect(resumed.lifecycle.sealId).toBe(sealId);
    expect(latestExecutableSeal(fixture.workspace, resumed.lifecycle.missionId)?.sealId).toBe(sealId);
    // The job is recreated only because the rewind deliberately dropped its
    // id; the ORIGINAL job still exists and was not corrupted.
    expect(readJobState(fixture.workspace, jobId).kind).toBe('ok');
  });

  it('RESUMES after the human satisfies the prerequisite it stopped on', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const id = approvedGoldenIntake(fixture);

    // Nothing available: the run stops, correctly, before a job exists.
    const stopped = await runSealAndBuild(fixture.intake, {
      intakeId: id,
      launch: false,
      probeRunner: fakeProbeRunner({}),
    });
    expect(stopped.outcome).toBe('HUMAN_PREREQUISITE_REQUIRED');
    expect(stopped.lifecycle.jobId).toBeUndefined();

    // The person starts the container runtime and resumes. The dogfood found
    // an earlier version short-circuiting on the recorded outcome and
    // repeating the same refusal verbatim — a resume that cannot resume.
    const resumed = await runSealAndBuild(fixture.intake, {
      intakeId: id,
      launch: false,
      probeRunner: allAvailableProbeRunner(),
    });
    expect(resumed.outcome).toBe('LAUNCHED');
    expect(resumed.humanPrerequisites).toEqual([]);
    expect(resumed.lifecycle.jobId).toBeDefined();
    // The work already done was reconciled, not repeated.
    const byStep = new Map(resumed.lifecycle.steps.map((step) => [step.step, step.status]));
    expect(byStep.get('SYNTHESIZE')).toBe('COMPLETED');
    expect(byStep.get('SEAL')).toBe('COMPLETED');
    expect(byStep.get('RESOLVE_PREREQUISITES')).toBe('COMPLETED');
    expect(requireIntakeState(fixture.workspace, id).status).toBe('BUILDING');

    // The PREFLIGHT step now reports the verdict the LAUNCH acted on, not the
    // stale one that stopped the first attempt. The dogfood's ledger showed
    // "PREFLIGHT: COMPLETED — HUMAN_ACTION_REQUIRED" beside a build that had
    // proceeded, which invites exactly the wrong conclusion.
    const preflightStep = resumed.lifecycle.steps.find((step) => step.step === 'PREFLIGHT');
    expect(preflightStep?.detail).toBe('OVERNIGHT_READY');
    expect(resumed.lifecycle.preflightReportId).toBe(preflightStep?.result);
  });

  it('calling it again on a COMPLETED lifecycle performs no work', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const id = approvedGoldenIntake(fixture);
    const first = await runSealAndBuild(fixture.intake, {
      intakeId: id,
      launch: true,
      probeRunner: allAvailableProbeRunner(),
      runUnattended: async (_deps, input) =>
        ({
          stop: { kind: 'completed', rationale: 'closed on evidence' },
          job: requireJobState(fixture.workspace, input.jobId),
          seal: requireSeal(
            fixture.workspace,
            latestExecutableSeal(fixture.workspace, input.missionId)?.sealId as string,
          ),
          telemetry: {} as never,
          audits: [],
          recoveries: [],
          cycles: 1,
        }) as unknown as UnattendedResult,
    });
    expect(first.outcome).toBe('COMPLETED');
    const attemptsBefore = first.lifecycle.steps.map((step) => step.attempts).join(',');

    // COMPLETED is the ONE genuinely terminal outcome: re-entering is a read.
    const second = await runSealAndBuild(fixture.intake, {
      intakeId: id,
      launch: true,
      probeRunner: allAvailableProbeRunner(),
      runUnattended: async () => {
        throw new Error('a COMPLETED lifecycle must not run the unattended runtime again');
      },
    });
    expect(second.outcome).toBe('COMPLETED');
    expect(second.lifecycle.steps.map((step) => step.attempts).join(',')).toBe(attemptsBefore);
  });

  it('refuses to run without an approval — no seal without human authority', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const started = startSpecIntake(fixture.intake, {
      name: 'workbench',
      kind: 'text',
      content: goldenSpecText(),
    });
    runIntakeDiscovery(fixture.intake, started.intake.intakeId);
    await expect(
      runSealAndBuild(fixture.intake, {
        intakeId: started.intake.intakeId,
        launch: false,
        probeRunner: allAvailableProbeRunner(),
      }),
    ).rejects.toThrow(/has not been approved/i);
    expect(latestExecutableSeal(fixture.workspace, started.mission.missionId)).toBeUndefined();
  });
});

describe('seal-and-build — the unattended launch', () => {
  it('hands the job to the unattended runtime and records the outcome', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const id = approvedGoldenIntake(fixture);

    // The unattended runtime itself is vNext.10 and has its own suite; here
    // it is injected so this test asserts the HANDOFF rather than re-testing
    // the supervisor.
    let launchedWith: { missionId: string; jobId: string } | undefined;
    const result = await runSealAndBuild(fixture.intake, {
      intakeId: id,
      launch: true,
      probeRunner: allAvailableProbeRunner(),
      runUnattended: async (_deps, input) => {
        launchedWith = input;
        return {
          stop: { kind: 'completed', rationale: 'every sealed item closed on trusted evidence' },
          job: requireJobState(fixture.workspace, input.jobId),
          seal: requireSeal(
            fixture.workspace,
            readSealBinding(fixture.workspace, input.jobId)?.sealId ??
              (latestExecutableSeal(fixture.workspace, input.missionId)?.sealId as string),
          ),
          telemetry: {} as never,
          audits: [],
          recoveries: [],
          cycles: 1,
        } as unknown as UnattendedResult;
      },
    });

    expect(launchedWith?.jobId).toBe(result.lifecycle.jobId);
    expect(launchedWith?.missionId).toBe(result.lifecycle.missionId);
    expect(result.outcome).toBe('COMPLETED');
    expect(requireIntakeState(fixture.workspace, id).status).toBe('BUILT');

    const events = readIntakeEvents(fixture.workspace, id).events;
    expect(events.some((event) => event['type'] === 'unattended_launched')).toBe(true);
    const finished = events.find((event) => event['type'] === 'build_finished');
    expect(finished?.['outcome']).toBe('COMPLETED');
  });

  it('reports a genuine authority stop as NEEDS_AUTHORITY rather than as failure', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const id = approvedGoldenIntake(fixture);
    const result = await runSealAndBuild(fixture.intake, {
      intakeId: id,
      launch: true,
      probeRunner: allAvailableProbeRunner(),
      runUnattended: async (_deps, input) =>
        ({
          stop: {
            kind: 'needs-authority',
            question: 'Completing this work requires changing sealed contract CTR-002.',
          },
          job: requireJobState(fixture.workspace, input.jobId),
          seal: requireSeal(
            fixture.workspace,
            latestExecutableSeal(fixture.workspace, input.missionId)?.sealId as string,
          ),
          telemetry: {} as never,
          audits: [],
          recoveries: [],
          cycles: 3,
        }) as unknown as UnattendedResult,
    });
    expect(result.outcome).toBe('NEEDS_AUTHORITY');
    // Governance working is not a build failure, and the intake stays in a
    // resumable state rather than BLOCKED.
    expect(requireIntakeState(fixture.workspace, id).status).toBe('BUILDING');
  });

  it('builds the closure ledger from the sealed acceptance criteria', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const id = approvedGoldenIntake(fixture);
    const result = await runSealAndBuild(fixture.intake, {
      intakeId: id,
      launch: false,
      probeRunner: allAvailableProbeRunner(),
    });
    const seal = requireSeal(fixture.workspace, result.lifecycle.sealId as string);
    // The Golden Spec's criteria imply both a real environment and a
    // browser, computed by the deterministic screen rather than declared.
    expect(seal.acceptanceCriteria.some((criterion) => criterion.impliesSystemScenario)).toBe(true);
    expect(seal.acceptanceCriteria.some((criterion) => criterion.impliesBrowserScenario)).toBe(true);
    // No ledger yet — the unattended runtime builds it at launch.
    expect(readClosureLedger(fixture.workspace, result.lifecycle.jobId as string)).toBeUndefined();
  });

  it('the telemetry boundary starts at the human approval', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const id = approvedGoldenIntake(fixture);
    const result = await runSealAndBuild(fixture.intake, {
      intakeId: id,
      launch: false,
      probeRunner: allAvailableProbeRunner(),
    });
    const telemetry = computeIntakeTelemetry(fixture.intake, id);
    const seal = requireSeal(fixture.workspace, result.lifecycle.sealId as string);

    expect(telemetry.humanInterventionsAfterSeal).toBe(0);
    expect(telemetry.discoveryHumanTurns).toBe(4);
    expect(telemetry.authorityApprovalCount).toBe(1);
    // The seal was created by the machine from the approval, so the two
    // instants are the intake's own and are both recorded.
    expect(seal.sealedAt).toBeDefined();
    expect(telemetry.boundaryStartedAt).toBeDefined();
  });

  it('leaves the synthesized spec approved so the ordinary orchestrator could run it', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const id = approvedGoldenIntake(fixture);
    const result = await runSealAndBuild(fixture.intake, {
      intakeId: id,
      launch: false,
      probeRunner: allAvailableProbeRunner(),
    });
    const state = readSpecState(fixture.workspace, result.lifecycle.specName as string).state;
    expect(state?.status).toBe('READY_FOR_IMPLEMENTATION');
    expect(state?.origin).toBe('created-by-specbridge');
  });
});
