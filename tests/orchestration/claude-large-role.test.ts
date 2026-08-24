import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runLargeRole } from '@specbridge/orchestration';
import { FAKE_CLAUDE_PATH, setupExecutionFixtureV2 } from '../helpers-execution.js';

/**
 * The large-tier reasoning path against the fake Claude CLI.
 *
 * This is the path that produced the LARGE_WORKER_FAILED blocker in the
 * field: the PLANNER escalated to Claude Code, the CLI rejected the
 * `--json-schema` value, and the only surviving signal was "the runner
 * produced no output". These tests pin the contract end to end.
 */

const savedScenario = process.env['FAKE_CLAUDE_SCENARIO'];
afterEach(() => {
  if (savedScenario === undefined) delete process.env['FAKE_CLAUDE_SCENARIO'];
  else process.env['FAKE_CLAUDE_SCENARIO'] = savedScenario;
});

function scenario(name: string): void {
  process.env['FAKE_CLAUDE_SCENARIO'] = name;
}

function invocation() {
  const fixture = setupExecutionFixtureV2({ useFakeClaude: true });
  return {
    workspace: fixture.workspace,
    config: fixture.config,
    runnerProfile: 'claude-code',
    role: 'PLANNER' as const,
    packet: 'Task 1: implement the workflow definition schema.',
    scratchDir: mkdtempSync(path.join(os.tmpdir(), 'specbridge-large-role-')),
    timeoutMs: 60_000,
  };
}

describe('runLargeRole against the fake Claude CLI', () => {
  it('validates a PLANNER structured_output result', async () => {
    scenario('structured-output');
    const result = await runLargeRole(invocation());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.decision).toBe('PLAN');
    expect(FAKE_CLAUDE_PATH.length).toBeGreaterThan(0);
  });

  it('still validates a PLANNER result delivered as envelope text', async () => {
    scenario('success');
    const result = await runLargeRole(invocation());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.decision).toBe('PLAN');
  });

  it('surfaces the CLI stderr diagnostic instead of a bare no-output error', async () => {
    scenario('nonzero-exit');
    const result = await runLargeRole(invocation());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Provider/CLI failure stays a WORKER failure, never a task failure.
    expect(result.kind).toBe('invalid-output');
    expect(result.problem).toContain('the runner produced no output');
    expect(result.problem).toContain('simulated internal failure');
  });

  it('reports invalid role output without inventing a diagnostic', async () => {
    scenario('role-invalid');
    const result = await runLargeRole(invocation());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('invalid-output');
    expect(result.problem).not.toContain('claude stderr');
  });
});
