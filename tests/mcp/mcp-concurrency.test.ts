import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readInteractiveLock } from '@specbridge/execution';
import { resolveWorkspace } from '@specbridge/core';
import { EXECUTION_SPEC, setupExecutionFixture } from '../helpers-execution.js';
import { callTool, connectMcp } from '../helpers-mcp.js';

/**
 * Concurrency and cancellation: reads run in parallel, writes serialize
 * through the per-project mutex, complete/abort cannot race, cancelled
 * verifier processes terminate, and failures always release the lock.
 */

describe('concurrency', () => {
  it('read operations execute concurrently and consistently', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      const results = await Promise.all([
        callTool(session, 'workspace_detect'),
        callTool(session, 'spec_list'),
        callTool(session, 'spec_status', { specName: EXECUTION_SPEC }),
        callTool(session, 'task_list', { specName: EXECUTION_SPEC }),
        callTool(session, 'run_list'),
        callTool(session, 'spec_analyze', { specName: EXECUTION_SPEC }),
      ]);
      for (const result of results) expect(result.isError).toBe(false);
    } finally {
      await session.close();
    }
  });

  it('concurrent task_begin calls serialize: exactly one wins', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      const [first, second, third] = await Promise.all([
        callTool(session, 'task_begin', { specName: EXECUTION_SPEC }),
        callTool(session, 'task_begin', { specName: EXECUTION_SPEC, taskId: '2.1' }),
        callTool(session, 'task_begin', { specName: EXECUTION_SPEC, taskId: '2.2' }),
      ]);
      const outcomes = [first, second, third];
      const winners = outcomes.filter((outcome) => !outcome.isError);
      const losers = outcomes.filter((outcome) => outcome.isError);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(2);
      for (const loser of losers) expect(loser.errorCode).toBe('SBMCP010');
    } finally {
      await session.close();
    }
  });

  it('task_complete and task_abort on the same run serialize; the loser sees a finalized run', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      const begin = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      const runId = begin.structured['runId'] as string;
      writeFileSync(path.join(fixture.root, 'src', 'feature.txt'), 'work\n');

      const [complete, abort] = await Promise.all([
        callTool(session, 'task_complete', { runId, summary: 'done' }),
        callTool(session, 'task_abort', { runId, reason: 'racing abort' }),
      ]);

      // Whichever ran first finalized the run; the other observed the final
      // state without mutating it. In every ordering the run finalizes
      // exactly once and the lock is released.
      const workspace = resolveWorkspace(fixture.root);
      expect(workspace).toBeDefined();
      if (workspace !== undefined) {
        expect(readInteractiveLock(workspace).state).toBe('absent');
      }
      const completeFinalizedNow = !complete.isError && complete.structured['finalizedNow'] === true;
      const abortAborted = !abort.isError && abort.structured['status'] === 'aborted';
      // Exactly one of the two performed the finalization.
      expect(completeFinalizedNow !== abortAborted).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('concurrent spec_stage_apply calls cannot double-write (hash gate under the mutex)', async () => {
    const { copyFixtureToTemp } = await import('../helpers.js');
    const root = copyFixtureToTemp('v02-empty-workspace');
    const session = await connectMcp(root);
    try {
      const created = await callTool(session, 'spec_create', {
        name: 'settings-persistence',
        description: 'Persist settings.',
        apply: true,
      });
      expect(created.isError).toBe(false);
      const candidate = `# Requirements Document

## Introduction

Persist user settings across restarts.

## Requirements

### Requirement 1

**User Story:** As a user, I want settings saved, so that they survive restarts.

#### Acceptance Criteria

1. WHEN a setting changes THEN the system SHALL persist it within one second.
`;
      const validation = await callTool(session, 'spec_stage_validate', {
        specName: EXECUTION_SPEC,
        stage: 'requirements',
        candidateMarkdown: candidate,
      });
      expect(validation.isError).toBe(false);
      const args = {
        specName: EXECUTION_SPEC,
        stage: 'requirements',
        candidateMarkdown: candidate,
        expectedCurrentHash: validation.structured['currentHash'],
        expectedCandidateHash: validation.structured['candidateHash'],
        acknowledgement: 'apply-reviewed-candidate',
      };
      const [first, second] = await Promise.all([
        callTool(session, 'spec_stage_apply', args),
        callTool(session, 'spec_stage_apply', args),
      ]);
      const succeeded = [first, second].filter((result) => !result.isError);
      const failed = [first, second].filter((result) => result.isError);
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(failed[0]?.errorCode).toBe('SBMCP017');
    } finally {
      await session.close();
    }
  });
});

describe('cancellation and cleanup', () => {
  it('a long verification request can be cancelled and its process terminates', async () => {
    const fixture = setupExecutionFixture({
      verificationCommands: [
        {
          name: 'endless',
          argv: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 120000)'],
          timeoutMs: 300_000,
          required: true,
        },
      ],
    });
    const session = await connectMcp(fixture.root);
    try {
      const controller = new AbortController();
      const pending = session.client.callTool(
        { name: 'spec_run_verification', arguments: { scope: 'all' } },
        undefined,
        { signal: controller.signal },
      );
      // Give the request a moment to start the child process, then cancel.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const startedAt = Date.now();
      controller.abort();
      await expect(pending).rejects.toThrow();
      // Cancellation propagated: we did not wait for the 120s child.
      expect(Date.now() - startedAt).toBeLessThan(30_000);
    } finally {
      await session.close();
    }
  }, 60_000);

  it('the write mutex survives a failing writer (later writes still run)', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      const failing = await callTool(session, 'task_complete', { runId: 'missing', summary: 'x' });
      expect(failing.isError).toBe(true);
      const begin = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      expect(begin.isError).toBe(false);
      const abort = await callTool(session, 'task_abort', {
        runId: begin.structured['runId'] as string,
        reason: 'cleanup',
      });
      expect(abort.isError).toBe(false);
    } finally {
      await session.close();
    }
  });

  it('a failed begin never leaves a dangling lock', async () => {
    const fixture = setupExecutionFixture();
    // Dirty tree → begin fails AFTER lock acquisition would have happened.
    writeFileSync(path.join(fixture.root, 'src', 'dirty.txt'), 'dirty\n');
    const session = await connectMcp(fixture.root);
    try {
      const failed = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      expect(failed.isError).toBe(true);
      const workspace = resolveWorkspace(fixture.root);
      if (workspace !== undefined) {
        expect(readInteractiveLock(workspace).state).toBe('absent');
      }
      // And a subsequent allowDirty begin works.
      const retry = await callTool(session, 'task_begin', {
        specName: EXECUTION_SPEC,
        allowDirty: true,
      });
      expect(retry.isError).toBe(false);
    } finally {
      await session.close();
    }
  });
});
