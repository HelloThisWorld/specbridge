import { describe, expect, it } from 'vitest';
import {
  NON_AUTHORITY_SIGNALS,
  evaluateAuthority,
  latestExecutableSeal,
  requireSeal,
} from '@specbridge/autonomy';
import {
  createContractChangeRequest,
  decideContractChangeRequest,
  readCcrs,
  readContractRegistry,
} from '@specbridge/mission';
import {
  answerIntakeQuestion,
  approveIntake,
  runIntakeDiscovery,
  runSealAndBuild,
  startSpecIntake,
} from '@specbridge/intake';
import { allAvailableProbeRunner, policyOf } from '../helpers-autonomy.js';
import type { IntakeFixture } from '../helpers-intake.js';
import { goldenSpecText, setupIntakeFixture } from '../helpers-intake.js';

/**
 * §11 and §20 — authority after the intake path.
 *
 * A seal the machine created from an approval must behave exactly like a
 * seal a person created by hand. That is the whole safety argument for
 * automating the seal: the AUTHORITY did not move, only the typing did.
 *
 * So the vNext.10 mechanics are re-asserted against an intake-built seal:
 * the firewall still refuses a sealed-contract change, difficulty still
 * cannot become a human gate, and a conflict discovered during
 * implementation still goes through the human-only CCR path.
 */

async function builtIntake(fixture: IntakeFixture): Promise<{ missionId: string; sealId: string }> {
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
  const build = await runSealAndBuild(fixture.intake, {
    intakeId: id,
    launch: false,
    probeRunner: allAvailableProbeRunner(),
  });
  return { missionId: started.mission.missionId, sealId: build.lifecycle.sealId as string };
}

describe('authority under an intake-created seal', () => {
  it('refuses a sealed-contract change exactly as a hand-made seal would', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const { sealId } = await builtIntake(fixture);
    const seal = requireSeal(fixture.workspace, sealId);
    const policy = policyOf(fixture);

    const decision = evaluateAuthority({
      surface: 'sealed-contract-change',
      seal,
      policy,
      contractId: seal.contracts[0]?.contractId ?? 'CTR-001',
      detail: 'The console cannot render the graph without changing the definition format.',
    });
    expect(decision.verdict).toBe('NEEDS_AUTHORITY');
    expect(decision.reason).toBe('MODIFIES_SEALED_CONTRACT');
    expect(decision.question).toContain(seal.contracts[0]?.contractId ?? '');
  });

  it('still delegates ordinary engineering under an intake-created seal', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const { sealId } = await builtIntake(fixture);
    const seal = requireSeal(fixture.workspace, sealId);
    const policy = policyOf(fixture);

    for (const surface of [
      'ui-framework',
      'new-feature-rest-shape',
      'container-topology',
      'broker-topology',
      'test-harness',
      'database-physical-layout',
    ] as const) {
      const decision = evaluateAuthority({ surface, seal, policy });
      expect(decision.verdict, surface).toBe('AUTONOMOUS');
    }
  });

  it('difficulty still cannot become a human gate', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const { sealId } = await builtIntake(fixture);
    const seal = requireSeal(fixture.workspace, sealId);
    const policy = policyOf(fixture);

    // Every non-authority signal at once, on an intake-created seal.
    const decision = evaluateAuthority({
      surface: 'internal-architecture',
      seal,
      policy,
      signals: [...NON_AUTHORITY_SIGNALS],
    });
    expect(decision.verdict).toBe('AUTONOMOUS');
    expect(decision.observedSignals).toHaveLength(NON_AUTHORITY_SIGNALS.length);
  });

  it('a conflict found during implementation goes through the human-only CCR path', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const { missionId } = await builtIntake(fixture);
    const contracts = readContractRegistry(fixture.workspace, missionId);
    const target = contracts[0];
    expect(target).toBeDefined();

    // A worker raises a change request. Anyone may CREATE one.
    const created = createContractChangeRequest(fixture.mission.deps, missionId, {
      contractId: target?.contractId as string,
      problem:
        'The console cannot render a generic state graph while the definition format pins the ' +
        'airport topology.',
      proposal: 'Add a topology-neutral state list to the definition format.',
      raisedBy: 'worker-1',
      affected: ['console', 'definition format'],
    });
    // Materiality decides where it lands, and a public contract lands with
    // the human.
    expect(['PROPOSED', 'NEEDS_HUMAN']).toContain(created.ccr.status);
    expect(readCcrs(fixture.workspace, missionId)).toHaveLength(1);

    // Only an explicit human decision moves it, and it produces a NEW
    // revision rather than editing the sealed one.
    const decided = decideContractChangeRequest(fixture.mission.deps, missionId, {
      ccrId: created.ccr.ccrId,
      decision: 'approved',
      note: 'Approved: the generic console is the point of the feature.',
    });
    expect(decided.ccr.status).toBe('APPROVED');
    expect(decided.contract?.revision).toBe((target?.revision ?? 1) + 1);

    // The seal still cites the revision it was authorized against. That
    // difference is visible rather than absorbed, which is what lets a
    // long-running job notice the ground moved.
    const seal = latestExecutableSeal(fixture.workspace, missionId);
    const sealed = seal?.contracts.find(
      (contract) => contract.contractId === target?.contractId,
    );
    expect(sealed?.revision).toBe(target?.revision);
    expect(sealed?.revision).not.toBe(decided.contract?.revision);
  });
});
