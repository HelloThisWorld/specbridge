import { describe, expect, it } from 'vitest';
import { runCli } from '../../packages/cli/src/cli';
import {
  assessIntent,
  beginOrchestration,
  recordAction,
  requestClarification,
  reviewPlan,
  submitPlan,
} from '@specbridge/orchestration';
import type { OrchestrationFixture } from '../helpers-orchestration.js';
import { setupOrchestrationFixture, testPlanCandidate } from '../helpers-orchestration.js';

/**
 * `specbridge orchestrate …` — deterministic, read-only, stdout/stderr
 * disciplined, with stable JSON and exit codes. These commands must never
 * start or advance a run, and must never invoke a model.
 */

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(cwd: string, ...argv: string[]): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    cwd,
    out: (line) => stdout.push(`${line}\n`),
    outRaw: (text) => stdout.push(text),
    err: (line) => stderr.push(`${line}\n`),
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

function parseJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function runWithPlan(fixture: OrchestrationFixture): Promise<string> {
  const run = beginOrchestration(fixture.deps, {
    specName: fixture.specName,
    goal: 'Implement task 1 as the approved design describes.',
    taskId: '1',
  });
  assessIntent(fixture.deps, run.orchestrationId, {
    outcome: 'READY',
    summary: 'Implement task 1 as approved.',
    provenance: [{ fact: 'design approved', source: 'known-from-approved-spec' }],
  });
  const submitted = await submitPlan(fixture.deps, run.orchestrationId, testPlanCandidate('1'));
  reviewPlan(fixture.deps, run.orchestrationId, {
    planHash: submitted.planHash,
    decision: 'approved',
  });
  return run.orchestrationId;
}

describe('orchestrate help', () => {
  it('documents every subcommand', async () => {
    const fixture = setupOrchestrationFixture();
    const result = await cli(fixture.root, 'orchestrate', '--help');
    expect(result.code).toBe(0);
    for (const subcommand of ['status', 'show', 'explain', 'policy', 'events', 'phases']) {
      expect(result.stdout).toContain(subcommand);
    }
  });
});

describe('orchestrate status', () => {
  it('reports an empty workspace without creating anything', async () => {
    const fixture = setupOrchestrationFixture();
    const result = await cli(fixture.root, 'orchestrate', 'status');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/No orchestration runs recorded/);

    const json = await cli(fixture.root, 'orchestrate', 'status', '--json');
    expect(json.code).toBe(0);
    expect((parseJson(json.stdout)['data'] as { runs: unknown[] }).runs).toEqual([]);
  });

  it('lists a run with its phase and next action', async () => {
    const fixture = setupOrchestrationFixture();
    const id = await runWithPlan(fixture);

    const result = await cli(fixture.root, 'orchestrate', 'status');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(id);
    expect(result.stdout).toContain('READY_TO_EXECUTE');

    const json = await cli(fixture.root, 'orchestrate', 'status', '--json');
    const runs = (parseJson(json.stdout)['data'] as { runs: Record<string, unknown>[] }).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.['orchestrationId']).toBe(id);
    expect(runs[0]?.['phase']).toBe('READY_TO_EXECUTE');
    expect(runs[0]?.['planRevision']).toBe(1);
    expect(runs[0]?.['planReviewed']).toBe(true);
  });

  it('filters by spec and by active state', async () => {
    const fixture = setupOrchestrationFixture();
    await runWithPlan(fixture);

    const matching = await cli(fixture.root, 'orchestrate', 'status', '--spec', fixture.specName, '--json');
    expect((parseJson(matching.stdout)['data'] as { runs: unknown[] }).runs).toHaveLength(1);

    const other = await cli(fixture.root, 'orchestrate', 'status', '--spec', 'nonexistent', '--json');
    expect((parseJson(other.stdout)['data'] as { runs: unknown[] }).runs).toHaveLength(0);
  });
});

describe('orchestrate show', () => {
  it('renders the plan, budgets, and recent events', async () => {
    const fixture = setupOrchestrationFixture();
    const id = await runWithPlan(fixture);

    const result = await cli(fixture.root, 'orchestrate', 'show', id);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Execution plan (revision 1)');
    expect(result.stdout).toContain('Budgets');
    expect(result.stdout).toContain('Recent events');
    expect(result.stdout).toMatch(/Plan review: approved/);
  });

  it('emits stable JSON with the plan binding', async () => {
    const fixture = setupOrchestrationFixture();
    const id = await runWithPlan(fixture);

    const json = await cli(fixture.root, 'orchestrate', 'show', id, '--json');
    const data = parseJson(json.stdout)['data'] as Record<string, unknown>;
    expect(data['orchestrationId']).toBe(id);
    expect(data['phase']).toBe('READY_TO_EXECUTE');
    const plan = data['plan'] as Record<string, unknown>;
    expect(plan['revision']).toBe(1);
    expect((plan['binding'] as Record<string, unknown>)['taskId']).toBe('1');
    expect(typeof data['storageBytes']).toBe('number');
  });

  it('exits 2 with a stable SBO code and remediation, never a stack trace', async () => {
    const fixture = setupOrchestrationFixture();
    const result = await cli(fixture.root, 'orchestrate', 'show', 'no-such-run');
    expect(result.code).toBe(2);
    expect(result.stdout).toMatch(/SBO002 \(orchestration run not found\)/);
    expect(result.stdout).toMatch(/was not found/);
    expect(result.stdout).toMatch(/orchestrate status/);
    // An expected refusal is not an internal fault.
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/Unexpected error|at Command|\.js:\d+/);
  });

  it('reports an invalid orchestration id without leaking internals', async () => {
    const fixture = setupOrchestrationFixture();
    for (const id of ['../escape', 'a/b']) {
      const result = await cli(fixture.root, 'orchestrate', 'show', id);
      expect(result.code).toBe(2);
      expect(`${result.stdout}${result.stderr}`).not.toMatch(/Unexpected error|at Command/);
    }
  });
});

describe('orchestrate explain', () => {
  it('says exactly why execution has not started', async () => {
    const fixture = setupOrchestrationFixture();
    const run = beginOrchestration(fixture.deps, {
      specName: fixture.specName,
      goal: 'Implement routing.',
      taskId: '1',
    });
    assessIntent(fixture.deps, run.orchestrationId, {
      outcome: 'NEEDS_CLARIFICATION',
      summary: 'Implement routing; the mechanism is unspecified.',
    });
    requestClarification(fixture.deps, run.orchestrationId, [
      { question: 'Which routing mechanism?', whyItMatters: 'Changes the worker code.' },
    ]);

    const result = await cli(fixture.root, 'orchestrate', 'explain', run.orchestrationId);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Execution has not started/);
    expect(result.stdout).toMatch(/clarification question/i);
    expect(result.stdout).toContain('Next action');
  });

  it('reports the exhausted budget in JSON', async () => {
    const fixture = setupOrchestrationFixture({
      policy: { planning: { mode: 'auto' }, execution: { maxIterations: 1 } },
    });
    const run = beginOrchestration(fixture.deps, {
      specName: fixture.specName,
      goal: 'Implement task 1.',
      taskId: '1',
    });
    assessIntent(fixture.deps, run.orchestrationId, {
      outcome: 'READY',
      summary: 'Implement task 1.',
      provenance: [{ fact: 'approved', source: 'known-from-approved-spec' }],
    });
    await submitPlan(fixture.deps, run.orchestrationId, testPlanCandidate('1'));
    recordAction(fixture.deps, run.orchestrationId, {
      action: 'INSPECT',
      target: 'a.ts',
      result: 'progressed',
    });
    recordAction(fixture.deps, run.orchestrationId, {
      action: 'INSPECT',
      target: 'b.ts',
      result: 'progressed',
    });

    const json = await cli(fixture.root, 'orchestrate', 'explain', run.orchestrationId, '--json');
    const data = parseJson(json.stdout)['data'] as Record<string, unknown>;
    expect(data['phase']).toBe('BLOCKED');
    expect(data['exhaustedBudgets']).toContain('iterations');
    expect((data['blocker'] as Record<string, unknown>)['category']).toBe('BUDGET_EXHAUSTED');
  });
});

describe('orchestrate policy', () => {
  it('shows the resolved defaults for a workspace with no orchestration block', async () => {
    const fixture = setupOrchestrationFixture();
    const result = await cli(fixture.root, 'orchestrate', 'policy', 'show');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/mode: review/);
    expect(result.stdout).toMatch(/maxIterations: 12/);

    const json = await cli(fixture.root, 'orchestrate', 'policy', 'show', '--json');
    const data = parseJson(json.stdout)['data'] as Record<string, unknown>;
    const orchestration = data['orchestration'] as Record<string, unknown>;
    expect((orchestration['planning'] as Record<string, unknown>)['mode']).toBe('review');
  });

  it('validates a good policy with exit 0', async () => {
    const fixture = setupOrchestrationFixture();
    const result = await cli(fixture.root, 'orchestrate', 'policy', 'validate', '--json');
    expect(result.code).toBe(0);
    const data = parseJson(result.stdout)['data'] as Record<string, unknown>;
    expect(data['valid']).toBe(true);
    expect(data['problems']).toEqual([]);
  });

  it('warns — without failing — when planning review is weakened', async () => {
    const fixture = setupOrchestrationFixture({ policy: { planning: { mode: 'auto' } } });
    const result = await cli(fixture.root, 'orchestrate', 'policy', 'validate', '--json');
    expect(result.code).toBe(0);
    const data = parseJson(result.stdout)['data'] as { warnings: string[] };
    expect(data.warnings.join(' ')).toMatch(/not reviewed before the first edit/);
  });

  it('explains that disabled planning does not disable other gates', async () => {
    const fixture = setupOrchestrationFixture({ policy: { planning: { mode: 'disabled' } } });
    const result = await cli(fixture.root, 'orchestrate', 'policy', 'validate', '--json');
    const data = parseJson(result.stdout)['data'] as { warnings: string[] };
    expect(data.warnings.join(' ')).toMatch(/approvals, evidence, verification/);
  });
});

describe('orchestrate events', () => {
  it('returns a bounded page of the append-only history', async () => {
    const fixture = setupOrchestrationFixture();
    const id = await runWithPlan(fixture);

    const result = await cli(fixture.root, 'orchestrate', 'events', id, '--limit', '3', '--json');
    expect(result.code).toBe(0);
    const data = parseJson(result.stdout)['data'] as { events: unknown[]; total: number };
    expect(data.events.length).toBeLessThanOrEqual(3);
    expect(data.total).toBeGreaterThanOrEqual(data.events.length);
  });
});

describe('orchestrate phases', () => {
  it('lists the phase vocabulary', async () => {
    const fixture = setupOrchestrationFixture();
    const json = await cli(fixture.root, 'orchestrate', 'phases', '--json');
    const phases = (parseJson(json.stdout)['data'] as { phases: string[] }).phases;
    expect(phases).toContain('AWAITING_PLAN_REVIEW');
    expect(phases).toContain('REPAIRING');
    expect(phases).toContain('COMPLETED');
  });
});

describe('the CLI never advances a run', () => {
  it('leaves the phase and counters untouched after every read command', async () => {
    const fixture = setupOrchestrationFixture();
    const id = await runWithPlan(fixture);

    const before = parseJson(
      (await cli(fixture.root, 'orchestrate', 'show', id, '--json')).stdout,
    )['data'] as Record<string, unknown>;

    await cli(fixture.root, 'orchestrate', 'status');
    await cli(fixture.root, 'orchestrate', 'explain', id);
    await cli(fixture.root, 'orchestrate', 'events', id);
    await cli(fixture.root, 'orchestrate', 'policy', 'show');

    const after = parseJson(
      (await cli(fixture.root, 'orchestrate', 'show', id, '--json')).stdout,
    )['data'] as Record<string, unknown>;

    expect(after['phase']).toBe(before['phase']);
    expect(after['planRevision']).toBe(before['planRevision']);
    expect(after['totalEvents']).toBe(before['totalEvents']);
  });
});
