import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OBSERVED_OUTPUT_EXCERPT_CHARS,
  looksLikeAuthenticationFailure,
  runLargeRole,
} from '@specbridge/orchestration';
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

  it('names an expired credential as an unavailable worker, not as garbage output', () => {
    // The vNext.10.1 dogfood hit this and it cost an entire run: the worker
    // exited ZERO and its result body was an auth error, so the response was
    // "not a single valid JSON document" — technically true, and the least
    // useful sentence available. An expired credential is a HUMAN
    // prerequisite, and saying so is the difference between a five-second
    // fix and a morning of confusion.
    expect(
      looksLikeAuthenticationFailure(
        'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.',
      ),
    ).toBe(true);
    for (const message of [
      'Error: 403 Forbidden',
      'Invalid API key provided',
      'Your credentials are expired',
      'Please log in to continue',
    ]) {
      expect(looksLikeAuthenticationFailure(message), message).toBe(true);
    }

    // And NOT a plan that merely talks about authentication — the very
    // specification that produced the dogfood is about identity verification,
    // so this is the false positive that matters.
    const plan = JSON.stringify({
      decision: 'PLAN',
      goal: 'Implement Gate 1: validate passport and boarding-pass information.',
      steps: [
        { id: '1', action: 'Reject an unauthorized passenger with a 401-shaped API response.' },
        { id: '2', action: 'Re-authenticate the demo operator session on expiry.' },
      ],
    });
    expect(looksLikeAuthenticationFailure(plan)).toBe(false);
    expect(looksLikeAuthenticationFailure('')).toBe(false);
    // A long document is a document, whatever words it contains.
    expect(looksLikeAuthenticationFailure(`401 unauthorized ${'x'.repeat(2_500)}`)).toBe(false);
  });

  it('retains a bounded excerpt of what the worker actually returned', async () => {
    scenario('role-invalid');
    const result = await runLargeRole(invocation());
    expect(result.ok).toBe(false);
    if (result.ok) return;

    // The vNext.10.1 dogfood blocked a job on "the response is not a single
    // valid JSON document" and retained NOTHING — a message with no evidence
    // behind it. An operator needs to see what came back.
    expect(result.observed).toBeDefined();
    expect(result.observed).toContain('I would suggest planning carefully');
    expect((result.observed ?? '').length).toBeLessThanOrEqual(
      OBSERVED_OUTPUT_EXCERPT_CHARS,
    );
    // Retained for a human to read, never parsed and never repaired: mining
    // JSON out of prose is exactly the silent malformed-output repair the
    // contract validator exists to refuse.
    expect(result.ok).toBe(false);
  });
});
