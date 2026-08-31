import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runLargeRole } from '@specbridge/orchestration';
import { setupExecutionFixtureV2 } from '../helpers-execution.js';

afterEach(() => {
  delete process.env['FAKE_CODEX_SCENARIO'];
});

describe('runLargeRole against the fake Codex CLI', () => {
  it('routes a PLANNER through the selected Codex profile and validates its schema', async () => {
    process.env['FAKE_CODEX_SCENARIO'] = 'success';
    const fixture = setupExecutionFixtureV2({ useFakeCodex: true });
    const result = await runLargeRole({
      workspace: fixture.workspace,
      config: fixture.config,
      registry: fixture.registry,
      runnerProfile: 'codex-default',
      role: 'PLANNER',
      packet: 'Task 1: implement the workflow definition schema.',
      scratchDir: mkdtempSync(path.join(os.tmpdir(), 'specbridge-codex-large-role-')),
      timeoutMs: 60_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.decision).toBe('PLAN');
    expect(result.output.steps).toHaveLength(3);
  });
});
