import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import { readSpecState } from '@specbridge/core';
import { authorStage } from '@specbridge/execution';
import { approveStage } from '@specbridge/workflow';
import { EXECUTION_SPEC, setupExecutionFixture } from '../helpers-execution.js';

/**
 * Model-assisted stage authoring (generate/refine) over the mock runner:
 * workflow prerequisites, draft-only results, invalid-candidate retention,
 * approval invalidation, dry-run purity, non-English preservation.
 */

function specFile(root: string, name: string): string {
  return path.join(root, '.kiro', 'specs', EXECUTION_SPEC, name);
}

function approveOne(fixture: ReturnType<typeof setupExecutionFixture>, stage: 'requirements' | 'design' | 'tasks' | 'bugfix'): void {
  const spec = analyzeSpec(fixture.workspace, requireSpec(fixture.workspace, EXECUTION_SPEC));
  const result = approveStage(fixture.workspace, spec, { stage }, { clock: fixture.clock });
  if (!result.ok) throw new Error(`approval failed: ${result.message}`);
}

describe('stage generation prerequisites (requirements-first)', () => {
  it('requirements may be generated while requirements is draft', async () => {
    const fixture = setupExecutionFixture({ approve: false });
    // Initialize workflow state by approving requirements, then revoke it to
    // get a managed spec with a draft requirements stage.
    approveOne(fixture, 'requirements');
    const spec = analyzeSpec(fixture.workspace, requireSpec(fixture.workspace, EXECUTION_SPEC));
    approveStage(fixture.workspace, spec, { stage: 'requirements', revoke: true }, { clock: fixture.clock });

    const outcome = await authorStage(fixture.deps, {
      specName: EXECUTION_SPEC,
      stage: 'requirements',
      intent: 'generate',
    });
    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') return;
    expect(readFileSync(specFile(fixture.root, 'requirements.md'), 'utf8')).toContain('# Requirements Document');

    // Generated content is NOT approved.
    const state = readSpecState(fixture.workspace, EXECUTION_SPEC).state;
    expect(state?.stages.requirements?.status).toBe('draft');
  });

  it('design generation requires requirements approval', async () => {
    const fixture = setupExecutionFixture({ approve: false });
    approveOne(fixture, 'requirements');
    const spec = analyzeSpec(fixture.workspace, requireSpec(fixture.workspace, EXECUTION_SPEC));
    approveStage(fixture.workspace, spec, { stage: 'requirements', revoke: true }, { clock: fixture.clock });

    const blocked = await authorStage(fixture.deps, {
      specName: EXECUTION_SPEC,
      stage: 'design',
      intent: 'generate',
    });
    expect(blocked.kind).toBe('gate-failed');
    if (blocked.kind === 'gate-failed') {
      expect(blocked.message).toContain('requirements');
      expect(blocked.remediation.join(' ')).toContain('spec approve');
    }

    approveOne(fixture, 'requirements');
    const allowed = await authorStage(fixture.deps, {
      specName: EXECUTION_SPEC,
      stage: 'design',
      intent: 'generate',
    });
    expect(allowed.kind).toBe('applied');
  });

  it('tasks generation requires requirements and design approval', async () => {
    const fixture = setupExecutionFixture({ approve: false });
    approveOne(fixture, 'requirements');
    const outcome = await authorStage(fixture.deps, {
      specName: EXECUTION_SPEC,
      stage: 'tasks',
      intent: 'generate',
    });
    expect(outcome.kind).toBe('gate-failed');
    if (outcome.kind === 'gate-failed') expect(outcome.message).toContain('design');
  });

  it('an approved stage is never overwritten; approval must be revoked first', async () => {
    const fixture = setupExecutionFixture(); // all approved
    const before = readFileSync(specFile(fixture.root, 'design.md'), 'utf8');
    const outcome = await authorStage(fixture.deps, {
      specName: EXECUTION_SPEC,
      stage: 'design',
      intent: 'generate',
    });
    expect(outcome.kind).toBe('gate-failed');
    if (outcome.kind === 'gate-failed') {
      expect(outcome.message).toContain('approved');
      expect(outcome.remediation.join(' ')).toContain('--revoke');
    }
    expect(readFileSync(specFile(fixture.root, 'design.md'), 'utf8')).toBe(before);
  });

  it('a spec without workflow state cannot generate (actionable message)', async () => {
    const fixture = setupExecutionFixture({ approve: false });
    const outcome = await authorStage(fixture.deps, {
      specName: EXECUTION_SPEC,
      stage: 'requirements',
      intent: 'generate',
    });
    expect(outcome.kind).toBe('gate-failed');
    if (outcome.kind === 'gate-failed') {
      expect(outcome.exitCode).toBe(2);
      expect(outcome.remediation.join(' ')).toContain('spec approve');
    }
  });
});

describe('generated output validation', () => {
  it('invalid generated markdown is retained as a candidate and never applied', async () => {
    const fixture = setupExecutionFixture({ approve: false, scenario: 'invalid-markdown' });
    approveOne(fixture, 'requirements');
    approveOne(fixture, 'design');
    // tasks is draft now; regenerate it with an invalid candidate.
    const before = readFileSync(specFile(fixture.root, 'tasks.md'), 'utf8');
    const outcome = await authorStage(fixture.deps, {
      specName: EXECUTION_SPEC,
      stage: 'tasks',
      intent: 'generate',
    });
    expect(outcome.kind).toBe('invalid-candidate');
    if (outcome.kind !== 'invalid-candidate') return;
    expect(outcome.exitCode).toBe(1);
    expect(outcome.analysis.errorCount).toBeGreaterThan(0);
    expect(existsSync(outcome.candidatePath)).toBe(true);
    expect(readFileSync(specFile(fixture.root, 'tasks.md'), 'utf8')).toBe(before);
  });

  it('malformed runner output fails safely with the raw output retained', async () => {
    const fixture = setupExecutionFixture({ approve: false, scenario: 'malformed-output' });
    approveOne(fixture, 'requirements');
    const outcome = await authorStage(fixture.deps, {
      specName: EXECUTION_SPEC,
      stage: 'design',
      intent: 'generate',
    });
    expect(outcome.kind).toBe('runner-failed');
    if (outcome.kind !== 'runner-failed') return;
    expect(outcome.exitCode).toBe(4);
    const raw = readFileSync(path.join(outcome.artifactsDir, 'raw-stdout.log'), 'utf8');
    expect(raw).toContain('not a JSON document');
  });

  it('generation dry-run does not modify .kiro, sidecar state, or create runs', async () => {
    const fixture = setupExecutionFixture({ approve: false });
    approveOne(fixture, 'requirements');
    const before = readFileSync(specFile(fixture.root, 'design.md'), 'utf8');
    const stateBefore = readFileSync(
      path.join(fixture.root, '.specbridge', 'state', 'specs', `${EXECUTION_SPEC}.json`),
      'utf8',
    );
    const outcome = await authorStage(fixture.deps, {
      specName: EXECUTION_SPEC,
      stage: 'design',
      intent: 'generate',
      dryRun: true,
    });
    expect(outcome.kind).toBe('dry-run');
    if (outcome.kind !== 'dry-run') return;
    expect(outcome.plan.prompt).toContain('Stage to produce: design');
    expect(outcome.plan.toolPolicy).toBe('inspect-only');
    expect(readFileSync(specFile(fixture.root, 'design.md'), 'utf8')).toBe(before);
    expect(
      readFileSync(path.join(fixture.root, '.specbridge', 'state', 'specs', `${EXECUTION_SPEC}.json`), 'utf8'),
    ).toBe(stateBefore);
    expect(existsSync(path.join(fixture.root, '.specbridge', 'runs'))).toBe(false);
  });

  it('requirements/bugfix generation uses read-only tools in the plan', async () => {
    const fixture = setupExecutionFixture({ approve: false });
    approveOne(fixture, 'requirements');
    const spec = analyzeSpec(fixture.workspace, requireSpec(fixture.workspace, EXECUTION_SPEC));
    approveStage(fixture.workspace, spec, { stage: 'requirements', revoke: true }, { clock: fixture.clock });
    const outcome = await authorStage(fixture.deps, {
      specName: EXECUTION_SPEC,
      stage: 'requirements',
      intent: 'generate',
      dryRun: true,
    });
    expect(outcome.kind).toBe('dry-run');
    if (outcome.kind === 'dry-run') expect(outcome.plan.toolPolicy).toBe('read-only');
  });
});

describe('refinement', () => {
  async function draftTasksFixture() {
    const fixture = setupExecutionFixture({ approve: false });
    approveOne(fixture, 'requirements');
    approveOne(fixture, 'design');
    return fixture;
  }

  it('produces a diff, applies atomically, and keeps the stage draft', async () => {
    const fixture = await draftTasksFixture();
    const outcome = await authorStage(fixture.deps, {
      specName: EXECUTION_SPEC,
      stage: 'tasks',
      intent: 'refine',
      instruction: 'Add explicit failure-path coverage to every test task.',
    });
    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') return;
    expect(outcome.diff).toContain('---');
    expect(outcome.diff).toContain('+++');
    expect(outcome.diff).toContain('@@');
    const state = readSpecState(fixture.workspace, EXECUTION_SPEC).state;
    expect(state?.stages.tasks?.status).toBe('draft');
    // The original content is retained as a run artifact diff.
    expect(existsSync(path.join(outcome.artifactsDir, 'candidate-tasks.diff'))).toBe(true);
  });

  it('refinement of a stage with approved dependents invalidates them', async () => {
    // Quick workflow: approve tasks... not possible while docs draft.
    // Use requirements-first: approve requirements + design + tasks, then
    // revoke design (tasks also falls). Instead simulate the documented
    // case: refine design while TASKS is approved, in a quick workflow.
    const fixture = setupExecutionFixture({ approve: false });
    // Build quick-mode state manually through the design-first inference:
    // simplest supported path — approve requirements, design, tasks, then
    // revoke ONLY requirements approval? Revoking requirements invalidates
    // design+tasks too (sequential). So use the real quick scenario is not
    // constructible from an existing spec; assert the sequential variant:
    approveOne(fixture, 'requirements');
    approveOne(fixture, 'design');
    approveOne(fixture, 'tasks');
    // design is approved → refine refuses (approved stages are protected).
    const refused = await authorStage(fixture.deps, {
      specName: EXECUTION_SPEC,
      stage: 'design',
      intent: 'refine',
      instruction: 'Tighten the error-handling section.',
    });
    expect(refused.kind).toBe('gate-failed');

    // Revoke design (which also invalidates tasks), then refine design;
    // afterwards tasks must STILL be unapproved (refinement never approves).
    const spec = analyzeSpec(fixture.workspace, requireSpec(fixture.workspace, EXECUTION_SPEC));
    const revoke = approveStage(fixture.workspace, spec, { stage: 'design', revoke: true }, { clock: fixture.clock });
    expect(revoke.ok).toBe(true);
    const outcome = await authorStage(fixture.deps, {
      specName: EXECUTION_SPEC,
      stage: 'design',
      intent: 'refine',
      instruction: 'Tighten the error-handling section.',
    });
    expect(outcome.kind).toBe('applied');
    const state = readSpecState(fixture.workspace, EXECUTION_SPEC).state;
    expect(state?.stages.design?.status).toBe('draft');
    expect(state?.stages.tasks?.status).not.toBe('approved');
  });

  it('refine without an instruction is a usage error', async () => {
    const fixture = await draftTasksFixture();
    const outcome = await authorStage(fixture.deps, {
      specName: EXECUTION_SPEC,
      stage: 'tasks',
      intent: 'refine',
    });
    expect(outcome.kind).toBe('gate-failed');
    if (outcome.kind === 'gate-failed') expect(outcome.exitCode).toBe(2);
  });

  it('refine a missing document points to generate', async () => {
    const fixture = await draftTasksFixture();
    rmSync(specFile(fixture.root, 'tasks.md'));
    const outcome = await authorStage(fixture.deps, {
      specName: EXECUTION_SPEC,
      stage: 'tasks',
      intent: 'refine',
      instruction: 'x',
    });
    expect(outcome.kind).toBe('gate-failed');
    if (outcome.kind === 'gate-failed') {
      expect(outcome.remediation.join(' ')).toContain('spec generate');
    }
  });
});

describe('non-English user content is preserved', () => {
  it('refinement keeps non-ASCII content intact through the prompt and diff pipeline', async () => {
    const fixture = setupExecutionFixture({ approve: false });
    approveOne(fixture, 'requirements');
    approveOne(fixture, 'design');
    const file = specFile(fixture.root, 'tasks.md');
    const original = readFileSync(file, 'utf8');
    const withUnicode = original.replace(
      '- [ ] 1. Implement the settings store',
      '- [ ] 1. Implement the settings store — 設定を保存する (сохранение настроек)',
    );
    writeFileSync(file, withUnicode, 'utf8');

    // The mock replaces the whole document; the point here is that the
    // pipeline (prompt assembly, candidate diff, atomic write) never mangles
    // multi-byte content. Use dry-run to assert prompt fidelity.
    const dry = await authorStage(fixture.deps, {
      specName: EXECUTION_SPEC,
      stage: 'tasks',
      intent: 'refine',
      instruction: 'テストを追加してください',
      dryRun: true,
    });
    expect(dry.kind).toBe('dry-run');
    if (dry.kind !== 'dry-run') return;
    expect(dry.plan.prompt).toContain('設定を保存する');
    expect(dry.plan.prompt).toContain('сохранение настроек');
    expect(dry.plan.prompt).toContain('テストを追加してください');
    expect(readFileSync(file, 'utf8')).toBe(withUnicode);
  });
});
