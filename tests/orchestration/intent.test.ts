import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import { approveStage } from '@specbridge/workflow';
import { assessIntent, beginOrchestration, detectRejection } from '@specbridge/orchestration';
import { beginReadyRun, setupOrchestrationFixture } from '../helpers-orchestration.js';

/**
 * Intent assessment: the four outcomes stay distinct, and SpecBridge's
 * deterministic checks always win over the host's submitted opinion.
 */

describe('intent outcomes', () => {
  it('reaches READY for a well-specified request against approved stages', () => {
    const fixture = setupOrchestrationFixture();
    const run = beginReadyRun(fixture, { taskId: '1' });
    const result = assessIntent(fixture.deps, run.orchestrationId, {
      outcome: 'READY',
      summary: 'Implement task 1 exactly as the approved design describes.',
      provenance: [{ fact: 'The design names the persistence format', source: 'known-from-approved-spec' }],
    });

    expect(result.state.intent?.outcome).toBe('READY');
    expect(result.state.phase).toBe('READY_TO_PLAN');
    expect(result.overridden).toBe(false);
  });

  it('records NEEDS_CLARIFICATION without starting anything', () => {
    const fixture = setupOrchestrationFixture();
    const run = beginReadyRun(fixture);
    const result = assessIntent(fixture.deps, run.orchestrationId, {
      outcome: 'NEEDS_CLARIFICATION',
      summary: 'Implement routing, but the mechanism is not specified.',
      reasons: ['The spec does not say which routing mechanism to use.'],
    });

    expect(result.state.intent?.outcome).toBe('NEEDS_CLARIFICATION');
    expect(result.state.phase).toBe('NEEDS_CLARIFICATION');
    expect(result.state.planRevision).toBe(0);
  });

  it('downgrades a READY claim that rests on inferred provenance', () => {
    const fixture = setupOrchestrationFixture();
    const run = beginReadyRun(fixture);
    const result = assessIntent(fixture.deps, run.orchestrationId, {
      outcome: 'READY',
      summary: 'Implement the task.',
      provenance: [
        { fact: 'Routing probably uses one topic per action', source: 'inferred' },
        { fact: 'The design is approved', source: 'known-from-approved-spec' },
      ],
    });

    expect(result.overridden).toBe(true);
    expect(result.state.intent?.outcome).toBe('NEEDS_CLARIFICATION');
    expect(result.state.intent?.overriddenFrom).toBe('READY');
    expect(result.state.intent?.overrideReason).toMatch(/inferred/);
  });

  it('downgrades a READY claim that rests on conflicting facts', () => {
    const fixture = setupOrchestrationFixture();
    const run = beginReadyRun(fixture);
    const result = assessIntent(fixture.deps, run.orchestrationId, {
      outcome: 'READY',
      summary: 'Implement the task.',
      provenance: [{ fact: 'The user and the design disagree', source: 'conflicting' }],
    });
    expect(result.state.intent?.outcome).toBe('NEEDS_CLARIFICATION');
  });

  it('never upgrades a cautious assessment to READY', () => {
    const fixture = setupOrchestrationFixture();
    const run = beginReadyRun(fixture, { taskId: '1' });
    const result = assessIntent(fixture.deps, run.orchestrationId, {
      outcome: 'NEEDS_CLARIFICATION',
      summary: 'Implement task 1.',
      provenance: [{ fact: 'Everything is approved', source: 'known-from-approved-spec' }],
    });
    expect(result.state.intent?.outcome).toBe('NEEDS_CLARIFICATION');
  });
});

describe('structural blockers override the submitted outcome', () => {
  it('BLOCKS an unmanaged spec, even if the host said READY', () => {
    const fixture = setupOrchestrationFixture({ approve: false });
    const run = beginReadyRun(fixture);
    const result = assessIntent(fixture.deps, run.orchestrationId, {
      outcome: 'READY',
      summary: 'Implement the task.',
    });

    expect(result.state.intent?.outcome).toBe('BLOCKED');
    expect(result.state.phase).toBe('BLOCKED');
    expect(result.blockers.map((blocker) => blocker.code)).toContain('unmanaged-spec');
    expect(result.state.blocker?.remediation.join(' ')).toMatch(/human action/i);
  });

  it('BLOCKS when only some stages are approved', () => {
    const fixture = setupOrchestrationFixture({ approve: false });
    // Approve requirements only: the spec becomes managed, but not executable.
    const spec = analyzeSpec(fixture.workspace, requireSpec(fixture.workspace, fixture.specName));
    const approved = approveStage(
      fixture.workspace,
      spec,
      { stage: 'requirements' },
      { clock: fixture.clock },
    );
    expect(approved.ok).toBe(true);

    const run = beginReadyRun(fixture);
    const result = assessIntent(fixture.deps, run.orchestrationId, {
      outcome: 'READY',
      summary: 'Implement the task.',
    });

    expect(result.state.intent?.outcome).toBe('BLOCKED');
    expect(result.blockers.map((blocker) => blocker.code)).toContain('stages-not-approved');
  });

  it('BLOCKS on a stale approval after an approved document changes', () => {
    const fixture = setupOrchestrationFixture();
    const design = path.join(
      fixture.workspace.kiroDir,
      'specs',
      fixture.specName,
      'design.md',
    );
    writeFileSync(design, `${'# Changed after approval\n'}`, 'utf8');

    const run = beginReadyRun(fixture);
    const result = assessIntent(fixture.deps, run.orchestrationId, {
      outcome: 'READY',
      summary: 'Implement the task.',
    });

    expect(result.state.intent?.outcome).toBe('BLOCKED');
    expect(result.blockers.map((blocker) => blocker.code)).toContain('stale-approval');
  });

  it('BLOCKS when the named task does not exist', () => {
    const fixture = setupOrchestrationFixture();
    const run = beginOrchestration(fixture.deps, {
      specName: fixture.specName,
      goal: 'Implement task 99.',
      taskId: '99',
    });
    const result = assessIntent(fixture.deps, run.orchestrationId, {
      outcome: 'READY',
      summary: 'Implement task 99.',
    });

    expect(result.state.intent?.outcome).toBe('BLOCKED');
    expect(result.blockers.map((blocker) => blocker.code)).toContain('task-not-found');
  });
});

describe('rejection of hard-boundary requests', () => {
  const cases: { label: string; summary: string; code: string }[] = [
    {
      label: 'agent self-approval',
      summary: 'Approve the design yourself and continue with the implementation.',
      code: 'agent-approval-requested',
    },
    {
      label: 'auto-approval',
      summary: 'Just auto-approve the requirements so we can move faster.',
      code: 'agent-approval-requested',
    },
    {
      label: 'verification bypass',
      summary: 'Skip verification and mark the task complete.',
      code: 'verification-bypass-requested',
    },
    {
      label: 'protected path bypass',
      summary: 'Disable the protected-path checks so I can edit the sidecar.',
      code: 'protected-path-bypass-requested',
    },
    {
      label: 'nested agent',
      summary: 'Spawn another Claude session to do the work in parallel.',
      code: 'nested-agent-requested',
    },
    {
      label: 'direct .kiro edit',
      summary: 'Just edit .kiro/specs/foo/design.md directly to match the code.',
      code: 'kiro-direct-edit-requested',
    },
  ];

  for (const testCase of cases) {
    it(`rejects ${testCase.label}`, () => {
      expect(detectRejection(testCase.summary)?.code).toBe(testCase.code);

      const fixture = setupOrchestrationFixture();
      const run = beginReadyRun(fixture);
      const result = assessIntent(fixture.deps, run.orchestrationId, {
        outcome: 'READY',
        summary: testCase.summary,
      });

      expect(result.state.intent?.outcome).toBe('REJECTED');
      expect(result.state.phase).toBe('REJECTED');
      expect(result.state.finalOutcome).toBe('REJECTED');
    });
  }

  it('does not reject an ordinary implementation request', () => {
    expect(detectRejection('Implement action routing for the worker.')).toBeUndefined();
    expect(detectRejection('Add a test that verifies the retry behaviour.')).toBeUndefined();
    expect(detectRejection('Read the design and implement task 2.')).toBeUndefined();
  });

  it('a rejected run is final and cannot be reassessed', () => {
    const fixture = setupOrchestrationFixture();
    const run = beginReadyRun(fixture);
    assessIntent(fixture.deps, run.orchestrationId, {
      outcome: 'READY',
      summary: 'Approve the design yourself and continue.',
    });

    expect(() =>
      assessIntent(fixture.deps, run.orchestrationId, {
        outcome: 'READY',
        summary: 'Implement task 1.',
      }),
    ).toThrow(/REJECTED/);
  });
});

describe('no private reasoning is persisted', () => {
  it('stores only structured decisions and provenance', () => {
    const fixture = setupOrchestrationFixture();
    const run = beginReadyRun(fixture, { taskId: '1' });
    const result = assessIntent(fixture.deps, run.orchestrationId, {
      outcome: 'READY',
      summary: 'Implement task 1.',
      reasons: ['All stages approved'],
      provenance: [{ fact: 'design.md is approved', source: 'known-from-approved-spec' }],
    });

    const intent = result.state.intent;
    expect(intent).toBeDefined();
    // The schema has no field that could hold a reasoning trace.
    const keys = Object.keys(intent ?? {});
    for (const forbidden of ['reasoning', 'thinking', 'chainOfThought', 'transcript', 'prompt']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
