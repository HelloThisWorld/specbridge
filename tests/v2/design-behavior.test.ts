import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESIGN_STAGES, workspaceRelative } from '@specbridge/core';
import { DesignService, SystemDesignPipeline } from '@specbridge/design';
import {
  completeScenario,
  createSyntheticRepository,
  GOLDEN_SCENARIOS,
  researchReport,
  stageOutput,
} from './fixtures.js';

describe('staged requirement discovery and authority', () => {
  it('runs the fourteen validated stages through the bounded pipeline', async () => {
    const root = createSyntheticRepository('pipeline');
    const scenario = GOLDEN_SCENARIOS[0]!;
    const service = new DesignService({ rootDir: root, idFactory: () => 'pipeline' });
    const session = service.start('Pipeline', scenario.idea);
    const bootstrap = service.bootstrap();
    const seen: string[] = [];
    const pipeline = new SystemDesignPipeline({
      store: service.store,
      snapshot: bootstrap.snapshot,
      index: bootstrap.index,
      provider: {
        generateStage: async (request) => {
          seen.push(request.stage);
          expect(request.repositoryContext.length).toBeLessThanOrEqual(12);
          return stageOutput(request.stage, scenario);
        },
      },
    });
    const completed = await pipeline.runUntilBlocked(session.id);
    expect(seen).toEqual(DESIGN_STAGES);
    expect(Object.keys(completed.stages)).toHaveLength(14);
    expect(service.read(session.id).nextAction).toBe('REVIEW');
  });

  it('requires goals/non-goals and labels scale assumptions', () => {
    const root = createSyntheticRepository('stage-validation');
    const service = new DesignService({ rootDir: root, idFactory: () => 'stage-validation' });
    const session = service.start('Stage validation', 'Design a tenant service.');
    expect(() =>
      service.recordStage(session.id, 'problem-framing', {
        problemStatement: 'Tenant service',
        businessContext: 'New product capability',
        actors: ['Tenant admin'],
        goals: ['Serve tenants'],
        nonGoals: [],
        successCriteria: ['A usable specification exists'],
        knownConstraints: [],
        assumptions: [],
        openQuestions: [],
      }),
    ).toThrow();

    const scenario = GOLDEN_SCENARIOS[1]!;
    service.recordStage(session.id, 'problem-framing', stageOutput('problem-framing', scenario));
    service.recordStage(
      session.id,
      'functional-requirements',
      stageOutput('functional-requirements', scenario),
    );
    service.recordStage(
      session.id,
      'non-functional-requirements',
      stageOutput('non-functional-requirements', scenario),
    );
    const invalidScale = stageOutput('scale-capacity', scenario) as {
      assumptions: Array<{ statement: string; source: string }>;
    };
    invalidScale.assumptions[0]!.source = 'USER';
    expect(() => service.recordStage(session.id, 'scale-capacity', invalidScale)).toThrow();
  });

  it('blocks only on material product decisions and unresolved research', () => {
    const root = createSyntheticRepository('authority-flow');
    const service = new DesignService({ rootDir: root, idFactory: () => 'authority-flow' });
    const session = service.start('Authority flow', 'Design a connected tenant product.');
    const problem = stageOutput('problem-framing', GOLDEN_SCENARIOS[1]!) as Record<string, unknown>;
    problem['openQuestions'] = [
      {
        id: 'DEC-HUMAN',
        question: 'Can platform admins read tenant conversations?',
        whyItMatters: 'This defines the privacy contract.',
        options: ['yes', 'no'],
        recommendation: 'no',
        blocking: true,
        repositoryCanAnswer: false,
        stableTechnicalFact: false,
        engineeringChoice: false,
        externalCurrentFact: false,
        definesProductBehavior: true,
      },
      {
        id: 'DEC-RESEARCH',
        question: 'What current external platform constraints affect this design?',
        whyItMatters: 'The external API changes over time.',
        options: [],
        recommendation: null,
        blocking: true,
        repositoryCanAnswer: false,
        stableTechnicalFact: false,
        engineeringChoice: false,
        externalCurrentFact: true,
        definesProductBehavior: false,
      },
      {
        id: 'DEC-ENGINEERING',
        question: 'Which internal index should support tenant lookup?',
        whyItMatters: 'It affects query performance.',
        options: [],
        recommendation: 'Use a tenant-scoped selective index.',
        blocking: false,
        repositoryCanAnswer: false,
        stableTechnicalFact: false,
        engineeringChoice: true,
        externalCurrentFact: false,
        definesProductBehavior: false,
      },
    ];
    const discovered = service.recordStage(session.id, 'problem-framing', problem);
    expect(discovered.status).toBe('NEEDS_INPUT');
    expect(discovered.decisions.find((item) => item.id === 'DEC-ENGINEERING')?.status).toBe(
      'DECIDED',
    );
    expect(service.answer(session.id, 'DEC-HUMAN', 'No, platform admins cannot read them.').status).toBe(
      'RESEARCHING',
    );
    expect(
      service.recordResearch(
        session.id,
        researchReport('What current external platform constraints affect this design?'),
      ).status,
    ).toBe('DESIGNING');
  });
});

describe('evaluation, approval, and versioning', () => {
  it('detects brownfield drift even when the Git commit is unchanged', () => {
    const root = createSyntheticRepository('brownfield-drift');
    const { service, subject } = completeScenario(root, GOLDEN_SCENARIOS[1]!);
    writeFileSync(path.join(root, 'src', 'new-uncommitted-boundary.ts'), 'export const drift = true;\n');
    const quality = service.evaluate(subject);
    expect(quality.ready).toBe(false);
    expect(
      quality.findings.some(
        (finding) => finding.dimension === 'GROUNDING' && /content changed/i.test(finding.message),
      ),
    ).toBe(true);
  });

  it('adds model-assisted semantic findings without weakening deterministic gates', () => {
    const root = createSyntheticRepository('model-evaluation');
    const { service, subject } = completeScenario(root, GOLDEN_SCENARIOS[0]!);
    const quality = service.evaluate(subject, [
      {
        dimension: 'ARCHITECTURE_COHERENCE',
        severity: 'FAIL',
        message: 'The semantic review found an unexplained consistency boundary.',
        references: ['architecture'],
      },
    ]);
    expect(quality.ready).toBe(false);
    expect(() => service.approve(subject, 'I approve this specification.')).toThrow(
      /failing quality/i,
    );
    expect(service.evaluate(subject).ready).toBe(true);
  });

  it('detects scope creep and product/research contradictions', () => {
    const root = createSyntheticRepository('contradiction-detection');
    const { service, subject } = completeScenario(root, GOLDEN_SCENARIOS[1]!);
    const session = service.store.read(subject);
    const problem = session.stages['problem-framing'] as Record<string, unknown>;
    (problem['nonGoals'] as string[]).push('Subscription billing is excluded from v1.');
    const requirements = session.stages['functional-requirements'] as {
      requirements: Array<Record<string, unknown>>;
    };
    requirements.requirements.push({
      id: 'FR-003',
      title: 'Subscription billing',
      description: 'Charge each tenant for a subscription.',
      actor: 'Tenant admin',
      preconditions: [],
      behavior: 'Collect a subscription payment.',
      failureBehavior: 'Reject unpaid access.',
      priority: 'MUST',
      source: 'DERIVED',
      sourceRefs: [],
    });
    service.store.save(session);

    const quality = service.evaluate(subject);
    expect(quality.ready).toBe(false);
    expect(
      quality.findings.some(
        (finding) =>
          finding.dimension === 'OPEN_RISKS' && /non-goal|scope creep/i.test(finding.message),
      ),
    ).toBe(true);
  });

  it('requires affirmative natural-language approval and archives revisions', () => {
    const root = createSyntheticRepository('spec-versioning');
    const scenario = { ...GOLDEN_SCENARIOS[0]!, title: 'versioned-design' };
    const first = completeScenario(root, scenario);
    first.service.evaluate(first.subject);
    expect(() => first.service.approve(first.subject, 'I do not approve this spec.')).toThrow(
      /explicitly/i,
    );
    const revisionOne = first.service.approve(first.subject, 'I approve this specification.');
    expect(revisionOne.manifest.revision).toBe(1);

    let nextId = 2;
    const service = new DesignService({ rootDir: root, idFactory: () => `revision-${nextId++}` });
    const second = service.start(scenario.title, scenario.idea);
    for (const stage of DESIGN_STAGES) {
      const output = stageOutput(stage, scenario);
      if (stage === 'functional-requirements') {
        const revised = output as { requirements: Array<{ description: string }> };
        revised.requirements[0]!.description += ' The refreshed design names the repository baseline.';
      }
      service.recordStage(second.id, stage, output);
    }
    expect(service.read(second.id).nextAction).toBe('REVIEW');
    service.evaluate(second.id);
    const revisionTwo = service.approve(second.id, '同意並核准這份規格。', 'fixture-owner');
    expect(revisionTwo.manifest.revision).toBe(2);
    expect(revisionTwo.manifest.changes.previousRevision).toBe(1);
    expect(revisionTwo.manifest.changes.changedRequirementIds).toContain('FR-001');
    expect(existsSync(path.join(revisionTwo.directory, 'revisions', '1', 'spec.yaml'))).toBe(
      true,
    );
  });

  it('normalizes Windows-style workspace-relative paths', () => {
    const root = createSyntheticRepository('windows-paths');
    const relative = workspaceRelative(root, path.join(root, 'src', 'index.ts'));
    expect(relative).toBe('src/index.ts');
    expect(relative).not.toContain('\\');
  });
});
