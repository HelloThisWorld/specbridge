import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import { approveStage } from '@specbridge/workflow';
import { stateStage } from '@specbridge/core';
import { authorStage, listAttempts, runApprovedTask } from '@specbridge/execution';
import type { ExecutionFixture } from '../helpers-execution.js';
import { EXECUTION_SPEC, setupExecutionFixtureV2 } from '../helpers-execution.js';
import type { FakeOpenAiServer } from '../helpers-fake-openai.js';
import { startFakeOpenAi } from '../helpers-fake-openai.js';

/**
 * v0.6.1 OpenAI-compatible authoring through the SAME shared orchestration
 * gates as Ollama: draft candidates, explicit approval, attempt records,
 * data-boundary reporting, and hard task-execution rejection before any
 * HTTP request. Fully offline (fake loopback endpoint).
 */

const servers: FakeOpenAiServer[] = [];

async function fakeServer(options: Parameters<typeof startFakeOpenAi>[0] = {}): Promise<FakeOpenAiServer> {
  const server = await startFakeOpenAi(options);
  servers.push(server);
  return server;
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

function approveOne(fixture: ExecutionFixture, stage: 'requirements' | 'design' | 'tasks'): void {
  const spec = analyzeSpec(fixture.workspace, requireSpec(fixture.workspace, EXECUTION_SPEC));
  const result = approveStage(fixture.workspace, spec, { stage }, { clock: fixture.clock });
  if (!result.ok) throw new Error(result.message);
}

describe('openai-compatible authoring through shared orchestration', () => {
  it('generates a design stage that stays draft; SpecBridge writes the file', async () => {
    const server = await fakeServer({ behaviors: ['valid-design'] });
    const fixture = setupExecutionFixtureV2({
      openAiBaseUrl: `${server.baseUrl}/v1`,
      defaultRunner: 'mock',
      approve: false,
    });
    approveOne(fixture, 'requirements');
    const outcome = await authorStage(fixture.deps, {
      specName: EXECUTION_SPEC,
      stage: 'design',
      intent: 'generate',
      runnerName: 'openai-compatible-local',
    });
    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') return;
    expect(outcome.profile).toBe('openai-compatible-local');
    expect(readFileSync(outcome.filePath, 'utf8')).toContain('# Design Document');
    // The design stage remains unapproved after generation.
    const spec = analyzeSpec(fixture.workspace, requireSpec(fixture.workspace, EXECUTION_SPEC));
    const designStage = spec.state !== undefined ? stateStage(spec.state, 'design') : undefined;
    expect(designStage?.status).not.toBe('approved');
    // Exactly one loopback request; SpecBridge wrote the document itself.
    expect(server.inferenceCalls()).toHaveLength(1);
    const attempts = listAttempts(fixture.workspace, outcome.runId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.boundary).toBe('loopback-endpoint');
    expect(attempts[0]?.model).toBe('fake-oai-model');
  });

  it('stage refinement works with an explicit instruction', async () => {
    const server = await fakeServer({ behaviors: ['valid-design'] });
    const fixture = setupExecutionFixtureV2({
      openAiBaseUrl: `${server.baseUrl}/v1`,
      defaultRunner: 'mock',
      approve: false,
    });
    approveOne(fixture, 'requirements');
    const generated = await authorStage(fixture.deps, {
      specName: EXECUTION_SPEC,
      stage: 'design',
      intent: 'generate',
      runnerName: 'openai-compatible-local',
    });
    expect(generated.kind).toBe('applied');
    const refined = await authorStage(fixture.deps, {
      specName: EXECUTION_SPEC,
      stage: 'design',
      intent: 'refine',
      instruction: 'Add explicit recovery behavior.',
      runnerName: 'openai-compatible-local',
    });
    expect(refined.kind).toBe('applied');
    expect(server.inferenceCalls()).toHaveLength(2);
  });

  it('dry-run reports the endpoint and data boundary and sends NO request', async () => {
    const server = await fakeServer();
    const fixture = setupExecutionFixtureV2({
      openAiBaseUrl: `${server.baseUrl}/v1`,
      defaultRunner: 'mock',
      approve: false,
    });
    approveOne(fixture, 'requirements');
    const outcome = await authorStage(fixture.deps, {
      specName: EXECUTION_SPEC,
      stage: 'design',
      intent: 'generate',
      runnerName: 'openai-compatible-local',
      dryRun: true,
    });
    expect(outcome.kind).toBe('dry-run');
    if (outcome.kind !== 'dry-run') return;
    const boundary = outcome.plan.dataBoundary;
    expect(boundary?.endpoint).toBe(`${server.baseUrl}/v1`);
    expect(boundary?.networkRequestWillOccur).toBe(true);
    expect(boundary?.model).toBe('fake-oai-model');
    expect(boundary?.inputCharacters).toBeGreaterThan(0);
    expect(boundary?.documents.length).toBeGreaterThan(0);
    // Nothing left this process: no HTTP request of any kind.
    expect(server.requests).toHaveLength(0);
  });

  it('task execution is rejected before any HTTP request or file change', async () => {
    const server = await fakeServer();
    const fixture = setupExecutionFixtureV2({
      openAiBaseUrl: `${server.baseUrl}/v1`,
      defaultRunner: 'mock',
    });
    const outcome = await runApprovedTask(fixture.deps, {
      specName: EXECUTION_SPEC,
      next: true,
      runnerName: 'openai-compatible-local',
    });
    expect(outcome.kind).toBe('preflight-failed');
    if (outcome.kind !== 'preflight-failed') return;
    expect(outcome.preflight.failure?.code).toBe('runner-not-selectable');
    expect(outcome.preflight.failure?.selection?.missingCapabilities).toContain('taskExecution');
    // NOTHING happened: no HTTP request, no run record.
    expect(server.requests).toHaveLength(0);
    expect(existsSync(path.join(fixture.root, '.specbridge', 'runs'))).toBe(false);
  });
});
