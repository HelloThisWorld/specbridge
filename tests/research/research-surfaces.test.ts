import { createServer } from 'node:http';
import type { RequestListener, Server } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../packages/cli/src/cli';
import { listResearchRecords } from '@specbridge/orchestration';
import { resolveWorkspace } from '@specbridge/core';
import { callTool, connectMcp } from '../helpers-mcp.js';

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
    now: () => new Date('2026-08-29T10:00:00.000Z'),
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

function workspaceRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'specbridge-research-surface-'));
  mkdirSync(path.join(root, '.kiro'), { recursive: true });
  return root;
}

const servers: Server[] = [];

async function fakeDeerFlow(): Promise<{ baseUrl: string; calls: () => number }> {
  let runCalls = 0;
  const payload = {
    status: 'COMPLETED',
    findings: [
      {
        findingId: 'finding-1',
        statement: 'Behavior Y is required by current platform X.',
        kind: 'COMPATIBILITY_FACT',
        sourceRefs: ['source-1'],
      },
    ],
    sourceRefs: [{ refId: 'source-1', url: 'https://example.test/x', title: 'Platform X docs' }],
    recommendations: ['Use the normal product decision path.'],
    unresolved: [],
    conflicts: [],
  };
  const handler: RequestListener = (request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"healthy"}');
      return;
    }
    if (request.url === '/api/langgraph/runs/stream') {
      runCalls += 1;
      request.resume();
      request.on('end', () => {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'content-location': `/api/threads/thread-${runCalls}/runs/run-${runCalls}`,
        });
        response.end(
          `event: values\ndata: ${JSON.stringify({ messages: [{ type: 'ai', content: JSON.stringify(payload) }] })}\n\nevent: end\ndata: {}\n\n`,
        );
      });
      return;
    }
    response.writeHead(404).end();
  };
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake DeerFlow did not bind');
  return { baseUrl: `http://127.0.0.1:${address.port}`, calls: () => runCalls };
}

function enableResearch(root: string, baseUrl: string): void {
  mkdirSync(path.join(root, '.specbridge'), { recursive: true });
  writeFileSync(
    path.join(root, '.specbridge', 'config.json'),
    `${JSON.stringify(
      {
        schemaVersion: '2.0.0',
        research: {
          enabled: true,
          provider: 'deerflow',
          strategy: 'ON_DEMAND',
          providers: { deerflow: { enabled: true, baseUrl, timeoutMs: 5_000 } },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server === undefined) continue;
    server.close();
    await once(server, 'close');
  }
});
describe('research CLI surface', () => {
  it('keeps absent configuration offline and reports disabled status', async () => {
    const root = workspaceRoot();
    const status = await cli(root, 'research', 'status', '--json');
    expect(status.code).toBe(0);
    const envelope = JSON.parse(status.stdout) as { schema: string; data: { policy: { enabled: boolean }; health: { status: string } } };
    expect(envelope.schema).toBe('specbridge.research.v1');
    expect(envelope.data.policy.enabled).toBe(false);
    expect(envelope.data.health.status).toBe('UNKNOWN');
  });

  it('supports status, investigate, show, list, persistence, and exact reuse', async () => {
    const root = workspaceRoot();
    const fake = await fakeDeerFlow();
    enableResearch(root, fake.baseUrl);

    const status = await cli(root, 'research', 'status');
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('HEALTHY');

    const first = await cli(
      root,
      'research',
      'investigate',
      'Does platform X require behavior Y?',
      '--id',
      'cli-research-1',
      '--answer',
      'Is Y required?',
      '--topic',
      'platform-x',
    );
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('COMPATIBILITY_FACT');
    expect(first.stdout).toContain('not product, Mission, task, or completion authority');

    const reused = await cli(
      root,
      'research',
      'investigate',
      'Does platform X require behavior Y?',
      '--id',
      'cli-research-2',
      '--answer',
      'Is Y required?',
      '--topic',
      'platform-x',
    );
    expect(reused.code).toBe(0);
    expect(reused.stdout).toContain('provider was not called');
    expect(fake.calls()).toBe(1);

    const shown = await cli(root, 'research', 'show', 'cli-research-1', '--json');
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('cli-research-1');
    const listed = await cli(root, 'research', 'list', '--topic', 'platform-x');
    expect(listed.stdout).toContain('cli-research-1');
    const workspace = resolveWorkspace(root);
    if (workspace === undefined) throw new Error('workspace missing');
    expect(listResearchRecords(workspace).records).toHaveLength(1);
  });
});

describe('research MCP surface', () => {
  it('exposes gate/start/get/list/status with no authority-shaped research tool', async () => {
    const root = workspaceRoot();
    const fake = await fakeDeerFlow();
    enableResearch(root, fake.baseUrl);
    const session = await connectMcp(root, {
      clock: () => new Date('2026-08-29T10:00:00.000Z'),
      idFactory: () => 'generated-id',
    });
    try {
      const tools = await session.client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      for (const name of [
        'research_gate',
        'research_start',
        'research_get',
        'research_list',
        'research_provider_status',
        'research_consider',
        'prepare_intake_decision',
      ]) {
        expect(names).toContain(name);
      }
      expect(names).not.toContain('research_approve');
      expect(names).not.toContain('research_apply_contract');
      expect(names).not.toContain('research_complete_task');

      const gate = await callTool(session, 'research_gate', {
        knowledgeGapDeclared: true,
        dependsOnExternalFacts: true,
        dependsOnCurrentFacts: true,
        materialToProductOrArchitecture: true,
        repositoryAnswerAvailable: false,
        priorResearchAvailable: false,
        engineeringDecisionOnly: false,
        requiresHumanAuthority: false,
      });
      expect(gate.isError).toBe(false);
      expect(gate.structured['decision']).toBe('RESEARCH_QUICK');

      const started = await callTool(session, 'research_start', {
        researchId: 'mcp-research-1',
        depth: 'QUICK',
        question: 'Does platform X require behavior Y?',
        questionsToAnswer: ['Is Y required?'],
        topicTags: ['platform-x'],
      });
      expect(started.isError).toBe(false);
      expect(started.structured['ok']).toBe(true);
      expect((started.structured['record'] as { status: string }).status).toBe('COMPLETED');

      const considered = await callTool(session, 'research_consider', {
        phase: 'SPEC_DRAFT',
        classification: 'EXTERNAL_KNOWLEDGE_GAP',
        reason: 'Current compatibility behavior is material.',
        gate: {
          knowledgeGapDeclared: true,
          dependsOnExternalFacts: true,
          dependsOnCurrentFacts: true,
          materialToProductOrArchitecture: true,
          repositoryAnswerAvailable: false,
          priorResearchAvailable: false,
          engineeringDecisionOnly: false,
          requiresHumanAuthority: false,
        },
        request: {
          researchId: 'mcp-lifecycle-reuse',
          depth: 'QUICK',
          question: 'Does platform X require behavior Y?',
          questionsToAnswer: ['Is Y required?'],
          topicTags: ['platform-x'],
        },
      });
      expect((considered.structured['execution'] as { reused: boolean }).reused).toBe(true);

      const prepared = await callTool(session, 'prepare_intake_decision', {
        questionId: 'q-compatibility',
        question: 'Which compatibility promise should the product make?',
        options: [{
          id: 'A',
          label: 'Partial compatibility',
          description: 'Promise selected behavior only.',
          consequences: ['Requires conformance tests.'],
        }],
        research: {
          classification: 'PRODUCT_AUTHORITY',
          reason: 'External facts would help prepare this human choice.',
          gate: {
            knowledgeGapDeclared: true,
            dependsOnExternalFacts: true,
            dependsOnCurrentFacts: true,
            materialToProductOrArchitecture: true,
            repositoryAnswerAvailable: false,
            priorResearchAvailable: false,
            engineeringDecisionOnly: false,
            requiresHumanAuthority: true,
          },
          request: {
            researchId: 'mcp-decision-reuse',
            depth: 'QUICK',
            question: 'Does platform X require behavior Y?',
            questionsToAnswer: ['Is Y required?'],
            topicTags: ['platform-x'],
          },
        },
      });
      const brief = prepared.structured['brief'] as { requiresHumanDecision: boolean; researchOutcome: string; answer?: string };
      expect(brief.requiresHumanDecision).toBe(true);
      expect(brief.researchOutcome).toBe('REUSED');
      expect(brief.answer).toBeUndefined();

      const reused = await callTool(session, 'research_start', {
        researchId: 'mcp-research-2',
        depth: 'QUICK',
        question: 'Does platform X require behavior Y?',
        questionsToAnswer: ['Is Y required?'],
        topicTags: ['platform-x'],
      });
      expect(reused.structured['reused']).toBe(true);
      expect(fake.calls()).toBe(1);

      const got = await callTool(session, 'research_get', { researchId: 'mcp-research-1' });
      expect(got.structured['found']).toBe(true);
      const listed = await callTool(session, 'research_list', { topicTag: 'platform-x' });
      expect(listed.structured['records']).toHaveLength(1);
      const status = await callTool(session, 'research_provider_status');
      expect((status.structured['health'] as { status: string }).status).toBe('HEALTHY');
    } finally {
      await session.close();
    }
  });
});
