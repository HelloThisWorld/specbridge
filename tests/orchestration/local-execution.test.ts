import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LOCAL_EXECUTION_LIMITS,
  compressContextItemsLocally,
  dispatchLocalExecution,
  localProviderCapabilities,
  validateEditPaths,
} from '@specbridge/orchestration';
import type { JobNode, LocalExecutorInference } from '@specbridge/orchestration';
import { setupOrchestrationFixture } from '../helpers-orchestration.js';
import { failingCommand } from '../helpers-execution.js';

/**
 * vNext.2 local task execution: the LocalModelProvider's source-mutating
 * path. A deterministic fake stands in for the local model; everything else
 * is the REAL machinery — interactive lock, Git snapshots, trusted
 * verification, evidence evaluation — because that pipeline being in charge
 * is the whole point of LOCAL_TRY.
 */

function node(taskId: string, title: string): JobNode {
  return {
    nodeId: `node-${taskId}`,
    parentTaskId: taskId,
    title,
  } as unknown as JobNode;
}

function implementedInference(edits: { path: string; content: string }[]): LocalExecutorInference {
  return () =>
    Promise.resolve({
      ok: true,
      text: JSON.stringify({
        decision: 'IMPLEMENTED',
        summary: 'Implemented the settings store persistence module.',
        edits,
      }),
      usage: { inputTokens: 900, outputTokens: 400 },
    });
}

describe('dispatchLocalExecution', () => {
  it('Test B shape: applies validated edits and completes through trusted verification', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const result = await dispatchLocalExecution({
      workspace: fixture.workspace,
      config: fixture.config,
      node: node('1', 'Implement the settings store'),
      specName: fixture.specName,
      mode: 'implement',
      allowDirty: false,
      inference: implementedInference([
        { path: 'src/settings-store.txt', content: 'settings store implementation\n' },
      ]),
      clock: fixture.clock,
    });

    expect(result.escalated).toBe(false);
    expect(result.evidenceStatus).toBe('verified');
    expect(result.runId).toBeDefined();
    expect(result.usage?.inputTokens).toBe(900);
    expect(result.usage?.costUsd).toBeNull();
    const written = path.join(fixture.root, 'src', 'settings-store.txt');
    expect(readFileSync(written, 'utf8')).toContain('settings store implementation');
    // Verified completion updates the checkbox through the normal pipeline.
    const tasks = readFileSync(
      path.join(fixture.root, '.kiro', 'specs', fixture.specName, 'tasks.md'),
      'utf8',
    );
    expect(tasks).toMatch(/- \[x\] 1\./);
  });

  it('a failing trusted verifier yields VERIFICATION_FAILURE with the verifier output attached', async () => {
    const fixture = setupOrchestrationFixture({
      git: true,
      verificationCommands: [failingCommand()],
    });
    const result = await dispatchLocalExecution({
      workspace: fixture.workspace,
      config: fixture.config,
      node: node('1', 'Implement the settings store'),
      specName: fixture.specName,
      mode: 'implement',
      allowDirty: false,
      inference: implementedInference([
        { path: 'src/settings-store.txt', content: 'broken implementation\n' },
      ]),
      clock: fixture.clock,
    });

    expect(result.escalated).toBe(false);
    expect(result.failure?.category).toBe('VERIFICATION_FAILURE');
    expect(result.runId).toBeDefined();
    // The imperfect edit stays in the tree as evidence for the next attempt.
    expect(existsSync(path.join(fixture.root, 'src', 'settings-store.txt'))).toBe(true);
  });

  it('a declined task escalates cleanly: no edits, lock released, reason preserved', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const inference: LocalExecutorInference = () =>
      Promise.resolve({
        ok: true,
        text: JSON.stringify({
          decision: 'ESCALATE',
          summary: 'This needs repository knowledge I do not have.',
          edits: [],
          escalationReason: 'cross-module change beyond a small isolated edit',
        }),
      });
    const result = await dispatchLocalExecution({
      workspace: fixture.workspace,
      config: fixture.config,
      node: node('1', 'Implement the settings store'),
      specName: fixture.specName,
      mode: 'implement',
      allowDirty: false,
      inference,
      clock: fixture.clock,
    });

    expect(result.escalated).toBe(true);
    expect(result.escalationReason).toContain('cross-module');
    expect(result.failure?.category).toBe('CAPABILITY_UNAVAILABLE');
    expect(existsSync(path.join(fixture.root, 'src', 'settings-store.txt'))).toBe(false);

    // The interactive lock was released: a fresh attempt can begin.
    const second = await dispatchLocalExecution({
      workspace: fixture.workspace,
      config: fixture.config,
      node: node('1', 'Implement the settings store'),
      specName: fixture.specName,
      mode: 'implement',
      allowDirty: false,
      inference: implementedInference([
        { path: 'src/settings-store.txt', content: 'second attempt succeeds\n' },
      ]),
      clock: fixture.clock,
    });
    expect(second.evidenceStatus).toBe('verified');
  });

  it('refuses unsafe edit proposals BEFORE anything is written and escalates', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const result = await dispatchLocalExecution({
      workspace: fixture.workspace,
      config: fixture.config,
      node: node('1', 'Implement the settings store'),
      specName: fixture.specName,
      mode: 'implement',
      allowDirty: false,
      inference: implementedInference([
        { path: '.specbridge/config.json', content: '{"hacked":true}' },
        { path: '../outside.txt', content: 'escape' },
      ]),
      clock: fixture.clock,
    });

    expect(result.escalated).toBe(true);
    expect(result.failure?.category).toBe('CAPABILITY_UNAVAILABLE');
    expect(result.failure?.message).toContain('refused before application');
    expect(existsSync(path.join(fixture.root, '..', 'outside.txt'))).toBe(false);
    const config = readFileSync(path.join(fixture.root, '.specbridge', 'config.json'), 'utf8');
    expect(config).not.toContain('hacked');
  });

  it('grants one bounded correction for invalid structured output', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    let calls = 0;
    const inference: LocalExecutorInference = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({ ok: true, text: '{"decision":"IMPLEMENTED"}' }); // missing summary
      }
      return Promise.resolve({
        ok: true,
        text: JSON.stringify({
          decision: 'IMPLEMENTED',
          summary: 'Fixed on the corrected round.',
          edits: [{ path: 'src/settings-store.txt', content: 'corrected implementation\n' }],
        }),
      });
    };
    const result = await dispatchLocalExecution({
      workspace: fixture.workspace,
      config: fixture.config,
      node: node('1', 'Implement the settings store'),
      specName: fixture.specName,
      mode: 'implement',
      allowDirty: false,
      inference,
      maxCorrections: 1,
      clock: fixture.clock,
    });
    expect(calls).toBe(2);
    expect(result.evidenceStatus).toBe('verified');
  });

  it('counts inference calls for the local budget', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    let counted = 0;
    await dispatchLocalExecution({
      workspace: fixture.workspace,
      config: fixture.config,
      node: node('1', 'Implement the settings store'),
      specName: fixture.specName,
      mode: 'implement',
      allowDirty: false,
      inference: implementedInference([
        { path: 'src/settings-store.txt', content: 'counted\n' },
      ]),
      clock: fixture.clock,
      onInferenceCall: () => {
        counted += 1;
      },
    });
    expect(counted).toBe(1);
  });
});

describe('edit path validation', () => {
  it('rejects absolute, escaping, denied, and protected paths structurally', () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const failures = validateEditPaths(
      fixture.workspace,
      [
        { path: 'src/ok.txt', content: 'fine' },
        { path: '.git/hooks/pre-commit', content: 'nope' },
        { path: '.kiro/specs/x.md', content: 'nope' },
        { path: '.specbridge/state.json', content: 'nope' },
        { path: '../escape.txt', content: 'nope' },
        { path: 'protected/inner.txt', content: 'nope' },
      ],
      ['protected/'],
    );
    expect(failures.map((failure) => failure.path)).toEqual([
      '.git/hooks/pre-commit',
      '.kiro/specs/x.md',
      '.specbridge/state.json',
      '../escape.txt',
      'protected/inner.txt',
    ]);
  });

  it('bounds the total edit size', () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const big = 'x'.repeat(LOCAL_EXECUTION_LIMITS.maxFileBytes);
    const failures = validateEditPaths(
      fixture.workspace,
      [
        { path: 'a.txt', content: big },
        { path: 'b.txt', content: big },
        { path: 'c.txt', content: big },
        { path: 'd.txt', content: big },
        { path: 'e.txt', content: big },
      ],
      [],
    );
    expect(failures.some((failure) => failure.path === '(total)')).toBe(true);
  });
});

describe('local provider capabilities', () => {
  it('never claims capabilities the integration does not provide', () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const capabilities = localProviderCapabilities(fixture.config);
    // The fixture has no local inference configured: nothing is claimed.
    expect(capabilities.available).toBe(false);
    expect(capabilities.toolCalling).toBe(false);
    expect(capabilities.shellAccess).toBe(false);
    expect(capabilities.fileEditing).toBe('none');
    expect(capabilities.nativeCompaction).toBe('none');
    expect(capabilities.reasoningLevel).toBe('none');
    expect(capabilities.problems.length).toBeGreaterThan(0);
  });
});

describe('local context preprocessing', () => {
  it('compresses bulky regenerable items and leaves protected layers untouched', async () => {
    const inference: LocalExecutorInference = () =>
      Promise.resolve({
        ok: true,
        text: JSON.stringify({
          summary: '3 tests failed in settings-store.spec.',
          keyFindings: ['save path throws ENOENT', 'teardown leaks a handle'],
        }),
      });
    const bigLog = `FAIL settings-store.spec\n${'noise line\n'.repeat(2_000)}`;
    const result = await compressContextItemsLocally({
      items: [
        {
          itemId: 'pinned-contract',
          layer: 'PINNED',
          kind: 'task-contract',
          title: 'TaskContract',
          content: bigLog,
          createdAt: '2026-08-21T12:00:00.000Z',
          source: 'test',
          compacted: false,
        },
        {
          itemId: 'working-test-log',
          layer: 'WORKING_SET',
          kind: 'test-output',
          title: 'Latest test output',
          content: bigLog,
          createdAt: '2026-08-21T12:00:00.000Z',
          source: 'test',
          compacted: false,
        },
      ],
      inference,
      clock: () => new Date('2026-08-21T12:01:00.000Z'),
    });

    expect(result.compressedItemIds).toEqual(['working-test-log']);
    expect(result.savedChars).toBeGreaterThan(0);
    const pinned = result.items.find((item) => item.layer === 'PINNED');
    expect(pinned?.content).toBe(bigLog);
    const compressed = result.items.find((item) => item.layer === 'WORKING_SET');
    expect(compressed?.compacted).toBe(true);
    // vNext.7: structured test output is reduced by PARSING, not by a model.
    // The failing test name survives verbatim, which is what keeps the
    // vNext.6 failure fingerprint comparable across attempts.
    expect(result.deterministicCompressions).toBe(1);
    expect(result.localCompressions).toBe(0);
    expect(compressed?.content).toContain('settings-store.spec');
    expect(compressed?.compression?.method).toBe('test-log-v1');
    expect(compressed?.compression?.sourceHashes[0]).toBeTruthy();
  });

  it('falls back to the bounded local model only for unstructured bulk', async () => {
    let calls = 0;
    const inference: LocalExecutorInference = () => {
      calls += 1;
      return Promise.resolve({
        ok: true,
        text: JSON.stringify({
          summary: 'The deployment narrative describes an ENOENT during teardown.',
          keyFindings: ['save path throws ENOENT'],
        }),
      });
    };
    // Prose with no test/compiler/lint/diff structure AND no repetition the
    // collapser can exploit — every line has a distinct signature. This is
    // exactly the residue the bounded local lane exists for.
    const token = (value: number): string => (value * 2_654_435_761).toString(36).slice(-5).padStart(5, 'q');
    const prose = Array.from(
      { length: 400 },
      (_, index) =>
        `Observation ${token(index + 1)}: the ${token(index + 7)} handler drained ${token(index + 13)} ` +
        `before ${token(index + 29)} settled and released ${token(index + 41)}.`,
    ).join('\n');

    const result = await compressContextItemsLocally({
      items: [
        {
          itemId: 'working-narrative',
          layer: 'WORKING_SET',
          kind: 'tool-result',
          title: 'Deployment narrative',
          content: prose,
          createdAt: '2026-08-21T12:00:00.000Z',
          source: 'run-1',
          compacted: false,
        },
      ],
      inference,
      clock: () => new Date('2026-08-21T12:01:00.000Z'),
    });

    expect(calls).toBe(1);
    expect(result.localCompressions).toBe(1);
    const compressed = result.items.find((item) => item.layer === 'WORKING_SET');
    expect(compressed?.content).toContain('ENOENT');
    // Local compression is DERIVED data and names where the original lives.
    expect(compressed?.compression?.method).toBe('local-model-v1');
    expect(compressed?.compression?.sourceRefs).toContain('run-1');
  });

  it('falls back to the deterministic view when local compression fails', async () => {
    const inference: LocalExecutorInference = () =>
      Promise.resolve({ ok: false, kind: 'unavailable', problem: 'server down' });
    const bigLog = 'x'.repeat(10_000);
    const result = await compressContextItemsLocally({
      items: [
        {
          itemId: 'working-log',
          layer: 'WORKING_SET',
          kind: 'log',
          title: 'Log',
          content: bigLog,
          createdAt: '2026-08-21T12:00:00.000Z',
          source: 'test',
          compacted: false,
        },
      ],
      inference,
    });
    // vNext.7: an unavailable local lane no longer means shipping raw bulk.
    // The bounded deterministic view stands in — it is not a hole (it names
    // its source and preserves the leading identity lines), and the raw
    // artifact remains retrievable from where it already lives.
    expect(result.compressedItemIds).toEqual(['working-log']);
    expect(result.localCompressions).toBe(0);
    expect(result.deterministicCompressions).toBe(1);
    const item = result.items[0];
    expect(item?.content.length).toBeLessThan(bigLog.length);
    expect(item?.compression?.sourceRefs).toContain('test');
    expect(item?.compression?.sourceHashes[0]).toBeTruthy();
  });

  it('leaves an artifact untouched when nothing can be reduced', async () => {
    let calls = 0;
    const inference: LocalExecutorInference = () => {
      calls += 1;
      return Promise.resolve({ ok: false, kind: 'unavailable', problem: 'server down' });
    };
    const small = 'a single short error line';
    const result = await compressContextItemsLocally({
      items: [
        {
          itemId: 'working-small',
          layer: 'WORKING_SET',
          kind: 'log',
          title: 'Log',
          content: small,
          createdAt: '2026-08-21T12:00:00.000Z',
          source: 'test',
          compacted: false,
        },
      ],
      inference,
    });
    // Below the threshold: no parse, no model call, no fabricated saving.
    expect(calls).toBe(0);
    expect(result.compressedItemIds).toEqual([]);
    expect(result.items[0]?.content).toBe(small);
  });
});
