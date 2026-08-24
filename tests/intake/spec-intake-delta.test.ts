import { describe, expect, it } from 'vitest';
import {
  DELTA_AUTHORITY_CLASSES,
  activeConstitutionRules,
  activeProductContracts,
  analyzeDeltaAuthority,
  groundInRepository,
  parseSpecificationDocument,
  raiseItemForQuestion,
  requiresProductAuthority,
  runIntakeDiscovery,
  startSpecIntake,
} from '@specbridge/intake';
import type { DeltaAuthorityAnalysis, RepositoryGrounding } from '@specbridge/intake';
import { readContractRegistry, recordAssessment, requireMissionState } from '@specbridge/mission';
import { sealableMission } from '../helpers-autonomy.js';
import type { IntakeFixture } from '../helpers-intake.js';
import { goldenSpecText, setupIntakeFixture } from '../helpers-intake.js';

/**
 * §3 and §11 — Delta Authority Analysis, and protection of prior seals.
 *
 * The classification these tests pin down is the one that decides whether an
 * ordinary feature can ship without a second conversation:
 *
 *   a new public surface is authorized BY THIS SPECIFICATION;
 *   an existing sealed promise is NOT, ever.
 *
 * Both directions are asserted, because both failures are expensive. Over-
 * classifying puts a human gate in front of every new endpoint; under-
 * classifying rewrites a promise the product already made.
 */

/** Grounding + analysis for one submitted document against the workspace. */
function analyze(
  fixture: IntakeFixture,
  content: string,
  ownMissionId: string,
  intakeId = 'intake-test',
): { analysis: DeltaAuthorityAnalysis; grounding: RepositoryGrounding } {
  const chunks = parseSpecificationDocument(content).chunks;
  const grounding = groundInRepository(fixture.intake, {
    intakeId,
    excludeMissionIds: [ownMissionId],
  });
  const analysis = analyzeDeltaAuthority({
    intakeId,
    analyzedAt: '2026-08-20T21:00:00.000Z',
    chunks,
    grounding,
    existingContracts: activeProductContracts(fixture.workspace, {
      excludeMissionIds: [ownMissionId],
    }),
    constitutionRules: activeConstitutionRules(fixture.workspace, {
      excludeMissionIds: [ownMissionId],
    }),
  });
  return { analysis, grounding };
}

describe('delta authority analysis — classification', () => {
  it('classifies a new public surface as authorized by THIS specification', () => {
    const fixture = setupIntakeFixture();
    const { analysis } = analyze(
      fixture,
      [
        '# Console',
        '',
        '- The console must expose a REST endpoint that lists workflow executions.',
        '- The console must render the workflow state graph on a page.',
        '',
      ].join('\n'),
      'none',
    );

    // Public, brand new, engages nothing existing: NEW_DELEGATED_SURFACE.
    // Being public is not by itself a change to an older promise, and
    // treating it as one is the failure this classification prevents.
    expect(analysis.items).toHaveLength(2);
    for (const item of analysis.items) {
      expect(item.classification).toBe('NEW_DELEGATED_SURFACE');
      expect(item.publicSurface).toBe(true);
      expect(requiresProductAuthority(item.classification)).toBe(false);
      expect(item.rationale).toContain('being public does not');
    }
    expect(analysis.modifiedContractIds).toEqual([]);
    expect(analysis.complete).toBe(true);
  });

  it('classifies engineering latitude as an implementation detail', () => {
    const fixture = setupIntakeFixture();
    const { analysis } = analyze(
      fixture,
      ['# Work', '', '- Use a background thread pool to poll for due timers.', ''].join('\n'),
      'none',
    );
    expect(analysis.items[0]?.classification).toBe('IMPLEMENTATION_DETAIL');
    expect(analysis.items[0]?.publicSurface).toBe(false);
    expect(requiresProductAuthority('IMPLEMENTATION_DETAIL')).toBe(false);
  });

  it('recognises a statement an existing contract already promises', () => {
    const fixture = setupIntakeFixture({ spec: true });
    const prior = sealableMission(fixture);
    const contracts = readContractRegistry(fixture.workspace, prior.missionId);
    const requirement = contracts[0]?.requirements[0]?.statement ?? '';
    expect(requirement.length).toBeGreaterThan(10);

    const { analysis } = analyze(
      fixture,
      ['# Restated', '', `- ${requirement}`, ''].join('\n'),
      'none',
    );
    const item = analysis.items[0];
    expect(item?.classification).toBe('EXISTING_CONTRACT_COMPATIBLE');
    expect(item?.existingContractId).toBe(contracts[0]?.contractId);
    expect(item?.rationale).toContain('already promises this');
  });

  it('classifies an addition to an additive-only contract as an extension', () => {
    const fixture = setupIntakeFixture({ spec: true });
    const prior = sealableMission(fixture);
    const contracts = readContractRegistry(fixture.workspace, prior.missionId);
    const contract = contracts[0];
    expect(contract?.compatibilityPolicy).toBe('additive-only');

    // Content-overlapping with the contract's own subject, without the
    // change vocabulary and without restating the exact requirement.
    const { analysis } = analyze(
      fixture,
      [
        '# Addition',
        '',
        '- Sequential execution of one workflow definition must additionally emit a ' +
          'deterministic execution trace for each transition.',
        '',
      ].join('\n'),
      'none',
    );
    const item = analysis.items[0];
    expect(item?.classification).toBe('EXISTING_CONTRACT_EXTENSION');
    expect(item?.existingContractId).toBe(contract?.contractId);
    expect(requiresProductAuthority('EXISTING_CONTRACT_EXTENSION')).toBe(false);
  });

  it('classifies change-shaped language against an existing contract as a sealed change', () => {
    const fixture = setupIntakeFixture({ spec: true });
    const prior = sealableMission(fixture);
    const contracts = readContractRegistry(fixture.workspace, prior.missionId);
    const requirement = contracts[0]?.requirements[0]?.statement ?? '';

    const { analysis } = analyze(
      fixture,
      ['# Change', '', `- Replace the rule that ${requirement.replace(/\.$/, '')}.`, ''].join('\n'),
      'none',
    );
    const item = analysis.items[0];
    expect(item?.classification).toBe('EXISTING_SEALED_CONTRACT_CHANGE');
    expect(requiresProductAuthority(item?.classification ?? 'IMPLEMENTATION_DETAIL')).toBe(true);
    expect(analysis.modifiedContractIds).toContain(contracts[0]?.contractId);
    expect(analysis.complete).toBe(false);
  });

  it('refuses to extend a FROZEN contract: adding to it is changing it', () => {
    const fixture = setupIntakeFixture({ spec: true });
    const prior = sealableMission(fixture);
    const priorDecisions = readContractRegistry(fixture.workspace, prior.missionId)[0]
      ?.decisionIds ?? [];
    expect(priorDecisions.length).toBeGreaterThan(0);
    const frozen = recordAssessment(fixture.mission.deps, prior.missionId, {
      contracts: [
        {
          title: 'Frozen Wire Format',
          summary:
            'The published telemetry envelope is frozen for the lifetime of major version 1.',
          classification: 'public',
          compatibilityPolicy: 'frozen',
          requirements: [
            {
              statement:
                'The published telemetry envelope carries exactly the fields defined in v1.',
            },
          ],
          decisionIds: [...priorDecisions],
        },
      ],
    });
    const frozenId = frozen.contractIds[0];
    expect(frozenId).toBeDefined();

    // An ADDITION, with no change vocabulary at all. Under an additive-only
    // policy this would be EXISTING_CONTRACT_EXTENSION; under a frozen one
    // there is no additive form, so it is a change.
    const { analysis } = analyze(
      fixture,
      [
        '# Addition',
        '',
        '- The published telemetry envelope additionally carries a correlation identifier ' +
          'field alongside the fields defined in v1.',
        '',
      ].join('\n'),
      'none',
    );
    const item = analysis.items[0];
    expect(item?.existingContractId).toBe(frozenId);
    expect(item?.classification).toBe('EXISTING_SEALED_CONTRACT_CHANGE');
    expect(item?.rationale).toContain('FROZEN');
    expect(requiresProductAuthority(item?.classification ?? 'IMPLEMENTATION_DETAIL')).toBe(true);
  });

  it('detects a contradiction against an active constitution guard pattern', () => {
    const fixture = setupIntakeFixture({ spec: true });
    const prior = sealableMission(fixture);
    const covered = readContractRegistry(fixture.workspace, prior.missionId);
    const decisionIds = covered[0]?.decisionIds ?? [];
    expect(decisionIds.length).toBeGreaterThan(0);
    recordAssessment(fixture.mission.deps, prior.missionId, {
      constitutionRules: [
        {
          statement: 'Actions never determine workflow transitions.',
          decisionIds: [...decisionIds],
          guardPatterns: ['action\\s+chooses\\s+the\\s+next\\s+state'],
        },
      ],
    });

    const { analysis } = analyze(
      fixture,
      ['# Change', '', '- The action chooses the next state after it completes.', ''].join('\n'),
      'none',
    );
    const item = analysis.items[0];
    expect(item?.classification).toBe('CONTRADICTION');
    expect(item?.rationale).toContain('constitution rule');
    expect(analysis.complete).toBe(false);
  });

  it('never leaves an item unclassified', () => {
    const fixture = setupIntakeFixture();
    const { analysis } = analyze(fixture, goldenSpecText(), 'none');
    expect(analysis.items.length).toBeGreaterThan(20);
    for (const item of analysis.items) {
      expect(DELTA_AUTHORITY_CLASSES).toContain(item.classification);
      expect(item.rationale.length).toBeGreaterThan(20);
    }
  });

  it('is a pure function of durable inputs: the same document twice is the same analysis', () => {
    const fixture = setupIntakeFixture();
    const first = analyze(fixture, goldenSpecText(), 'none').analysis;
    const second = analyze(fixture, goldenSpecText(), 'none').analysis;
    expect(second.items).toEqual(first.items);
    expect(second.basisDigest).toBe(first.basisDigest);
  });

  it('raising an item for a question raises only: a contradiction stays a contradiction', () => {
    const contradiction = {
      itemId: 'D-001',
      statement: 'x',
      sourceChunkIds: [],
      classification: 'CONTRADICTION' as const,
      rationale: 'because',
      topics: [],
      affectedSurfaces: [],
      existingElementIds: [],
      publicSurface: true,
    };
    const raised = raiseItemForQuestion(contradiction, 'Q-001', 'a question is open');
    expect(raised.classification).toBe('CONTRADICTION');
    expect(raised.questionId).toBe('Q-001');

    const compatible = { ...contradiction, classification: 'EXISTING_CONTRACT_COMPATIBLE' as const };
    const raisedCompatible = raiseItemForQuestion(compatible, 'Q-002', 'a question is open');
    expect(raisedCompatible.classification).toBe('UNKNOWN_PRODUCT_AUTHORITY');
    // The original rationale survives, so the pre-raise reading is still
    // readable after the answer settles it.
    expect(raisedCompatible.rationale).toContain('because');
  });
});

describe('delta authority analysis — prior seals are never silently mutated', () => {
  it('a new feature intake leaves every prior contract byte-identical', () => {
    const fixture = setupIntakeFixture({ spec: true });
    const prior = sealableMission(fixture);
    const before = JSON.stringify(readContractRegistry(fixture.workspace, prior.missionId));
    const beforeMission = JSON.stringify(requireMissionState(fixture.workspace, prior.missionId));

    const started = startSpecIntake(fixture.intake, {
      name: 'workbench',
      kind: 'text',
      content: goldenSpecText(),
    });
    runIntakeDiscovery(fixture.intake, started.intake.intakeId);

    // The prior mission's registry and state are untouched. The feature's own
    // contracts live on the feature's own mission.
    expect(JSON.stringify(readContractRegistry(fixture.workspace, prior.missionId))).toBe(before);
    expect(JSON.stringify(requireMissionState(fixture.workspace, prior.missionId))).toBe(
      beforeMission,
    );
    expect(started.mission.missionId).not.toBe(prior.missionId);
  });

  it('surfaces a would-be sealed-contract change as a blocking product question', () => {
    const fixture = setupIntakeFixture({ spec: true });
    const prior = sealableMission(fixture);
    const contracts = readContractRegistry(fixture.workspace, prior.missionId);
    const requirement = contracts[0]?.requirements[0]?.statement ?? '';

    const started = startSpecIntake(fixture.intake, {
      name: 'breaking-change',
      kind: 'text',
      content: [
        '# Breaking change',
        '',
        '## Goal',
        '',
        `Replace the rule that ${requirement.replace(/\.$/, '')}.`,
        '',
        '## Requirements',
        '',
        `- Replace the rule that ${requirement.replace(/\.$/, '')}.`,
        '',
      ].join('\n'),
    });
    const result = runIntakeDiscovery(fixture.intake, started.intake.intakeId);

    const change = result.questions.find((question) => question.kind === 'SEALED_CONTRACT_CHANGE');
    expect(change).toBeDefined();
    expect(change?.status).toBe('open');
    expect(change?.question).toContain(contracts[0]?.contractId ?? '');
    // The gate is closed until a person decides.
    expect(result.readiness.ready).toBe(false);
    expect(result.analysis.modifiedContractIds).toContain(contracts[0]?.contractId);
  });

  it('records extended and changed contracts on the intake for the approval summary', () => {
    const fixture = setupIntakeFixture({ spec: true });
    const prior = sealableMission(fixture);
    const contracts = readContractRegistry(fixture.workspace, prior.missionId);
    const { analysis } = analyze(
      fixture,
      [
        '# Mixed',
        '',
        '- Sequential execution of one workflow definition must additionally emit a ' +
          'deterministic execution trace for each transition.',
        '- The console must expose a REST endpoint that lists workflow executions.',
        '',
      ].join('\n'),
      'none',
    );
    expect(analysis.extendedContractIds).toContain(contracts[0]?.contractId);
    expect(analysis.modifiedContractIds).toEqual([]);
    expect(analysis.newSurfaces).toContain('public-api');

    // Qualified by the owning mission. The dogfood produced an approval
    // summary reading "CTR-001 would be extended" directly above the
    // feature's own "CTR-001 Observable Behaviour" — two different contracts
    // wearing one label, because contract ids are unique only within a
    // mission.
    expect(analysis.affectedContracts).toHaveLength(1);
    const affected = analysis.affectedContracts[0];
    expect(affected?.contractId).toBe(contracts[0]?.contractId);
    expect(affected?.missionId).toBe(prior.missionId);
    expect(affected?.title).toBe(contracts[0]?.title);
    expect(affected?.revision).toBe(contracts[0]?.revision);
    expect(affected?.relation).toBe('EXTENDED');
  });
});
