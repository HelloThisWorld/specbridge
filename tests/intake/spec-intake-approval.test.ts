import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSpecState } from '@specbridge/core';
import {
  answerIntakeQuestion,
  approveIntake,
  approvedElements,
  checkProjectionEquivalence,
  computeIntakeAuthorityDigest,
  computeIntakeTelemetry,
  describeStageAuthority,
  extractNormativeStatements,
  readApproval,
  readIntakeEvents,
  readProductBaseline,
  requireIntakeState,
  recordDerivedApprovals,
  runIntakeDiscovery,
  runSealAndBuild,
  startSpecIntake,
} from '@specbridge/intake';
import { readContractRegistry, readDecisions, requireMissionState } from '@specbridge/mission';
import { allAvailableProbeRunner } from '../helpers-autonomy.js';
import type { IntakeFixture } from '../helpers-intake.js';
import { goldenSpecText, setupIntakeFixture } from '../helpers-intake.js';

/**
 * §6 and §7 — the single human approval, and derived approval.
 *
 * The claim: one human decision, recorded once, immutably, and everything
 * downstream cites it. The three generated documents inherit that authority
 * WITH PROVENANCE rather than being approved again — and the inheritance is
 * refused outright the moment the projection carries anything the human did
 * not approve.
 *
 * The refusal is the interesting half. A mechanism that skips a human is only
 * sound if it can prove there was nothing new for the human to see, so the
 * divergence test matters more than the happy path.
 */

/** An intake driven to READY_FOR_APPROVAL from the Golden Spec. */
function readyGoldenIntake(fixture: IntakeFixture): string {
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
  expect(discovery.readiness.ready).toBe(true);
  return id;
}

describe('spec intake — the single human approval', () => {
  it('records ONE immutable authority record binding the canonical result', () => {
    const fixture = setupIntakeFixture();
    const id = readyGoldenIntake(fixture);

    const approved = approveIntake(fixture.intake, { intakeId: id, via: 'cli' });
    const approval = approved.approval;

    // Provenance over the whole discovered specification, by reference.
    expect(approval.approvedVia).toBe('cli');
    expect(approval.sourceContentHash).toHaveLength(64);
    expect(approval.newContractIds.length).toBeGreaterThan(0);
    expect(approval.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(approval.resolvedQuestions).toHaveLength(4);
    expect(approval.decisionIds.length).toBeGreaterThan(0);
    expect(approval.changedContractIds).toEqual([]);
    expect(approval.authorityDigest).toMatch(/^[0-9a-f]{32}$/);

    // Every recorded answer is the human's own text, cited by question.
    for (const resolved of approval.resolvedQuestions) {
      expect(resolved.answer.length).toBeGreaterThan(5);
      expect(resolved.decisionId).toBeDefined();
    }

    // Immutable: a second approval returns the same record rather than
    // writing another one.
    const again = approveIntake(fixture.intake, { intakeId: id, via: 'mcp' });
    expect(again.approval.approvalId).toBe(approval.approvalId);
    expect(again.approval.approvedVia).toBe('cli');

    const events = readIntakeEvents(fixture.workspace, id).events;
    expect(events.filter((event) => event['type'] === 'intake_approved')).toHaveLength(1);
    expect(approved.intake.counters.authorityApprovalCount).toBe(1);
  });

  it('refuses to approve an intake that has not converged', () => {
    const fixture = setupIntakeFixture();
    const started = startSpecIntake(fixture.intake, {
      name: 'workbench',
      kind: 'text',
      content: goldenSpecText(),
    });
    runIntakeDiscovery(fixture.intake, started.intake.intakeId);
    expect(() => approveIntake(fixture.intake, { intakeId: started.intake.intakeId })).toThrow(
      /not ready for approval/i,
    );
    expect(readApproval(fixture.workspace, started.intake.intakeId)).toBeUndefined();
  });

  it('the authority digest is a function of product truth, not of the file', () => {
    const truth = {
      goal: 'g',
      nonGoals: ['n'],
      decisionIds: ['DEC-002', 'DEC-001'],
      constitutionRuleIds: [],
      adrIds: [],
      contracts: [
        { contractId: 'CTR-001', revision: 1, requirementIds: ['R2', 'R1'], invariantIds: [] },
      ],
      acceptanceCriteria: ['a'],
      resolvedAnswers: [{ questionId: 'Q-001', answer: 'yes' }],
    };
    const reordered = {
      ...truth,
      decisionIds: ['DEC-001', 'DEC-002'],
      contracts: [
        { contractId: 'CTR-001', revision: 1, requirementIds: ['R1', 'R2'], invariantIds: [] },
      ],
    };
    // Ordering is not authority.
    expect(computeIntakeAuthorityDigest(truth)).toBe(computeIntakeAuthorityDigest(reordered));
    // A contract revision IS.
    expect(
      computeIntakeAuthorityDigest({
        ...truth,
        contracts: [
          { contractId: 'CTR-001', revision: 2, requirementIds: ['R1', 'R2'], invariantIds: [] },
        ],
      }),
    ).not.toBe(computeIntakeAuthorityDigest(truth));
  });

  it('records the feature in the product baseline lineage at approval time', () => {
    const fixture = setupIntakeFixture();
    const id = readyGoldenIntake(fixture);
    approveIntake(fixture.intake, { intakeId: id });

    const baseline = readProductBaseline(fixture.workspace);
    const entry = baseline.features.find((feature) => feature.intakeId === id);
    expect(entry).toBeDefined();
    expect(entry?.newContractIds.length).toBeGreaterThan(0);
    // Written at approval rather than at completion, so an interrupted run
    // still leaves a lineage entry naming what it started from.
    expect(entry?.predecessorSealIds).toEqual([]);
  });

  it('the approval summary is product language, not three documents', () => {
    const fixture = setupIntakeFixture();
    const id = readyGoldenIntake(fixture);
    const approved = approveIntake(fixture.intake, { intakeId: id });
    const summary = approved.summary;
    expect(summary).toBeDefined();
    expect(summary?.openBlockers).toBe(0);
    expect(summary?.changedContractIds).toEqual([]);
    expect(summary?.newContracts.length).toBeGreaterThan(0);
    expect(summary?.decisions).toHaveLength(4);
    expect(summary?.acceptanceCriteriaCount).toBeGreaterThan(0);
  });
});

describe('spec intake — derived approval', () => {
  it('stamps every projected stage with DERIVED_FROM_INTENT_APPROVAL provenance', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const id = readyGoldenIntake(fixture);
    const approved = approveIntake(fixture.intake, { intakeId: id });

    const build = await runSealAndBuild(fixture.intake, {
      intakeId: id,
      launch: false,
      probeRunner: allAvailableProbeRunner(),
    });
    expect(build.outcome).toBe('LAUNCHED');
    const specName = build.lifecycle.specName;
    expect(specName).toBeDefined();

    const state = readSpecState(fixture.workspace, specName as string).state;
    expect(state?.status).toBe('READY_FOR_IMPLEMENTATION');
    for (const stage of ['requirements', 'design', 'tasks'] as const) {
      const entry = (state?.stages as Record<string, Record<string, unknown>>)[stage];
      expect(entry?.['status']).toBe('approved');
      // NOT disguised as a manual approval: the mode says what it is, and
      // the record names the human decision behind it.
      expect(entry?.['approvalMode']).toBe('DERIVED_FROM_INTENT_APPROVAL');
      expect(entry?.['sourceApprovalId']).toBe(approved.approval.approvalId);
      expect(entry?.['authorityDigest']).toBe(approved.approval.authorityDigest);
      // The ordinary gates still ran: the byte hash is real.
      expect(String(entry?.['approvedHash'])).toMatch(/^[0-9a-f]{64}$/);

      expect(
        describeStageAuthority(entry as unknown as Parameters<typeof describeStageAuthority>[0]),
      ).toContain(approved.approval.approvalId);
    }

    const events = readIntakeEvents(fixture.workspace, id).events;
    expect(events.filter((event) => event['type'] === 'derived_approval_recorded')).toHaveLength(3);
  });

  it('a manual stage approval stays HUMAN and records no derived provenance', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const state = readSpecState(fixture.workspace, fixture.specName).state;
    // The autonomy fixture approves all three stages manually.
    expect(state?.status).toBe('READY_FOR_IMPLEMENTATION');
    for (const stage of ['requirements', 'design', 'tasks'] as const) {
      const entry = (state?.stages as Record<string, Record<string, unknown>>)[stage];
      expect(entry?.['approvalMode']).toBeUndefined();
      expect(entry?.['sourceApprovalId']).toBeUndefined();
      expect(
        describeStageAuthority(entry as unknown as Parameters<typeof describeStageAuthority>[0]),
      ).toContain('approved directly by a human');
    }
  });

  it('REFUSES derived approval when the projection carries unapproved authority', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const id = readyGoldenIntake(fixture);
    const approval = approveIntake(fixture.intake, { intakeId: id }).approval;

    // Run far enough to have a synthesized spec, then edit the compiled
    // requirements to smuggle in a promise nobody approved.
    const first = await runSealAndBuild(fixture.intake, {
      intakeId: id,
      launch: false,
      probeRunner: allAvailableProbeRunner(),
    });
    const specName = first.lifecycle.specName as string;
    const requirementsPath = path.join(
      fixture.workspace.rootDir,
      '.kiro',
      'specs',
      specName,
      'requirements.md',
    );
    const smuggled =
      '\n5. THE SYSTEM SHALL transmit every passenger biometric record to the ' +
      'partner airline reconciliation service within one hour.\n';
    appendFileSync(requirementsPath, smuggled, 'utf8');

    const contracts = readContractRegistry(fixture.workspace, approval.missionId);
    const decisions = readDecisions(fixture.workspace, approval.missionId).filter(
      (decision) => decision.status === 'active',
    );
    const equivalence = checkProjectionEquivalence({
      workspace: fixture.workspace,
      approval,
      specName,
      checkedAt: '2026-08-20T22:00:00.000Z',
      approvedElements: approvedElements(
        approval,
        contracts.map((contract) => ({
          contractId: contract.contractId,
          title: contract.title,
          summary: contract.summary,
          requirements: contract.requirements,
          invariants: contract.invariants,
        })),
        decisions,
      ),
      currentAuthorityDigest: approval.authorityDigest,
    });

    expect(equivalence.equivalent).toBe(false);
    expect(equivalence.divergences[0]?.kind).toBe('UNAPPROVED_AUTHORITY');
    expect(equivalence.divergences[0]?.statement).toContain('partner airline');

    // And the derived approval refuses — not warns.
    expect(() =>
      recordDerivedApprovals({
        workspace: fixture.workspace,
        approval,
        specName,
        equivalence,
        clock: fixture.clock,
      }),
    ).toThrow(/does not cover/i);
  });

  it('REFUSES derived approval when the approved truth moved afterwards', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const id = readyGoldenIntake(fixture);
    const approval = approveIntake(fixture.intake, { intakeId: id }).approval;
    const first = await runSealAndBuild(fixture.intake, {
      intakeId: id,
      launch: false,
      probeRunner: allAvailableProbeRunner(),
    });
    const specName = first.lifecycle.specName as string;

    const equivalence = checkProjectionEquivalence({
      workspace: fixture.workspace,
      approval,
      specName,
      checkedAt: '2026-08-20T22:00:00.000Z',
      approvedElements: [],
      // The canonical truth changed after the human approved it.
      currentAuthorityDigest: 'ffffffffffffffffffffffffffffffff',
    });
    expect(equivalence.equivalent).toBe(false);
    expect(equivalence.divergences).toHaveLength(1);
    expect(equivalence.divergences[0]?.kind).toBe('AUTHORITY_DIGEST_MISMATCH');
    // Reported FIRST and alone: nothing downstream is meaningful once the
    // truth moved, and a per-statement report would bury the one fact.
    expect(equivalence.checkedStatements).toBe(0);
  });

  it('treats the compiler’s own fixed statements as template, not as authority', () => {
    const statements = extractNormativeStatements(
      'requirements',
      [
        '# Requirements Document',
        '',
        '## Non-Functional Requirements',
        '',
        '- The system SHALL respect the Architecture Constitution recorded for this mission.',
        '- THE SYSTEM SHALL reject an invalid boarding pass before any side effect.',
        '',
      ].join('\n'),
    );
    // The template line is skipped; the real promise is not.
    expect(statements).toHaveLength(1);
    expect(statements[0]?.statement).toContain('boarding pass');
  });
});

describe('spec intake — the telemetry boundary', () => {
  it('separates discovery turns from interventions after the approval', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const id = readyGoldenIntake(fixture);

    const before = computeIntakeTelemetry(fixture.intake, id);
    expect(before.discoveryHumanTurns).toBe(4);
    expect(before.productQuestionsAsked).toBe(4);
    expect(before.authorityApprovalCount).toBe(0);
    // No build has run, so the metric is UNKNOWN rather than zero. An intake
    // with no job has not achieved zero interventions; it has not been
    // measured.
    expect(before.humanInterventionsAfterSeal).toBeNull();
    expect(before.boundaryStartedAt).toBeNull();

    const approval = approveIntake(fixture.intake, { intakeId: id }).approval;
    const afterApproval = computeIntakeTelemetry(fixture.intake, id);
    expect(afterApproval.authorityApprovalCount).toBe(1);
    expect(afterApproval.boundaryStartedAt).toBe(approval.approvedAt);
    // Discovery questions are NOT failures of unattended operation.
    expect(afterApproval.discoveryHumanTurns).toBe(4);

    await runSealAndBuild(fixture.intake, {
      intakeId: id,
      launch: false,
      probeRunner: allAvailableProbeRunner(),
    });
    const afterBuild = computeIntakeTelemetry(fixture.intake, id);
    expect(afterBuild.jobId).toBeDefined();
    expect(afterBuild.humanInterventionsAfterSeal).toBe(0);
    expect(afterBuild.questionsRefused).toBeGreaterThanOrEqual(1);
  });
});

describe('spec intake — what the builder is handed', () => {
  it('carries the human’s answer into the requirement, and keeps non-goals out of it', () => {
    const fixture = setupIntakeFixture();
    const id = readyGoldenIntake(fixture);
    const intake = requireIntakeState(fixture.workspace, id);
    const contracts = readContractRegistry(fixture.workspace, intake.missionId);
    const statements = contracts.flatMap((contract) =>
      contract.requirements.map((requirement) => requirement.statement),
    );

    // The dogfood produced an acceptance criterion still reading "Step
    // Functions-compatible or Step Functions-like" AFTER the human had
    // chosen — handing the builder back the exact ambiguity the
    // conversation existed to remove.
    const hedged = statements.find((statement) => statement.includes('Step Functions-compatible'));
    expect(hedged).toBeDefined();
    expect(hedged).toContain('Resolved by the recorded product decision:');
    expect(hedged).toContain('must run unchanged with identical semantics');

    // A non-goal is authority NOT to build something. It belongs on the
    // mission's non-goals, never as a requirement a builder implements.
    const mission = requireMissionState(fixture.workspace, intake.missionId);
    expect(mission.nonGoals.join(' ')).toContain('must not contain airport-specific');
    for (const statement of statements) {
      expect(statement, statement).not.toContain('must not contain airport-specific');
    }
  });
});
