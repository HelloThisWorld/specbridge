import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDefaultRunnerRegistry,
  renderRunnerMatrixMarkdown,
  runnerMatrixRows,
} from '@specbridge/runners';
import { readAgentConfig } from '@specbridge/core';
import { TOOL_CATALOG } from '@specbridge/mcp-server';
import type { McpTestSession } from '../helpers-mcp.js';
import { callTool, connectMcp, parsedLogs } from '../helpers-mcp.js';
import { setupExecutionFixtureV2 } from '../helpers-execution.js';
import type { FakeOpenAiServer } from '../helpers-fake-openai.js';
import { startFakeOpenAi } from '../helpers-fake-openai.js';

/**
 * v0.6.1 read-only MCP runner diagnostic tools: runner_list, runner_show,
 * runner_doctor, runner_matrix. In-memory MCP session against the real
 * server implementation; providers are the fake Gemini child process and a
 * fake loopback OpenAI-compatible endpoint. No model, no network, no
 * credentials.
 */

const FAKE_KEY = 'sk-FAKE-MCP-KEY-0987654321';
const KEY_VARIABLE = 'SPECBRIDGE_TEST_MCP_OPENAI_KEY';

let activeSession: McpTestSession | undefined;
let activeServer: FakeOpenAiServer | undefined;

afterEach(async () => {
  delete process.env[KEY_VARIABLE];
  delete process.env['FAKE_GEMINI_SCENARIO'];
  delete process.env['FAKE_GEMINI_LOG'];
  await activeSession?.close();
  activeSession = undefined;
  await activeServer?.close();
  activeServer = undefined;
});

async function runnerToolsSession(): Promise<{
  session: McpTestSession;
  server: FakeOpenAiServer;
  root: string;
}> {
  process.env['FAKE_GEMINI_SCENARIO'] = 'success';
  const server = await startFakeOpenAi();
  activeServer = server;
  const fixture = setupExecutionFixtureV2({
    useFakeGemini: true,
    openAiBaseUrl: `${server.baseUrl}/v1`,
    openAiProfileOverrides: { apiKeyEnvironmentVariable: KEY_VARIABLE },
    defaultRunner: 'mock',
  });
  const session = await connectMcp(fixture.root);
  activeSession = session;
  return { session, server, root: fixture.root };
}

describe('runner diagnostic tools (read-only)', () => {
  it('all four tools are registered in the deterministic catalog as read-only', () => {
    for (const name of ['runner_list', 'runner_show', 'runner_doctor', 'runner_matrix']) {
      const entry = TOOL_CATALOG.find((tool) => tool.name === name);
      expect(entry, name).toBeDefined();
      expect(entry?.readOnly, name).toBe(true);
    }
  });

  it('runner_list returns validated profile summaries with pagination', async () => {
    const { session } = await runnerToolsSession();
    const result = await callTool(session, 'runner_list', { limit: 3 });
    expect(result.isError).toBe(false);
    const profiles = result.structured['profiles'] as {
      profile: string;
      implementation: string;
      category: string;
      supportLevel: string;
      enabled: boolean;
      model: string | null;
      networkBacked: boolean;
      supportedOperations: string[];
    }[];
    expect(profiles).toHaveLength(3);
    for (const profile of profiles) {
      expect(typeof profile.profile).toBe('string');
      expect(typeof profile.enabled).toBe('boolean');
      expect(Array.isArray(profile.supportedOperations)).toBe(true);
    }
    const pagination = result.structured['pagination'] as { totalCount: number; truncated: boolean; nextCursor?: string };
    expect(pagination.truncated).toBe(true);
    expect(pagination.nextCursor).toBeDefined();
    // The second page continues without overlap.
    const second = await callTool(session, 'runner_list', { limit: 200, cursor: pagination.nextCursor });
    const secondNames = (second.structured['profiles'] as { profile: string }[]).map((entry) => entry.profile);
    expect(secondNames).not.toContain(profiles[0]?.profile);
    expect(pagination.totalCount).toBe(profiles.length + secondNames.length);
  });

  it('runner_show returns redacted configuration, capabilities, operations, and conformance summary', async () => {
    const { session } = await runnerToolsSession();
    const result = await callTool(session, 'runner_show', { profile: 'gemini-default' });
    expect(result.isError).toBe(false);
    const summary = result.structured['summary'] as { implementation: string; category: string };
    expect(summary.implementation).toBe('gemini-cli');
    expect(summary.category).toBe('agent-cli');
    const detection = result.structured['detection'] as {
      status: string;
      detectedCapabilities: Record<string, boolean>;
      diagnostics: unknown[];
    };
    expect(detection.status).toBe('available');
    expect(detection.detectedCapabilities['taskExecution']).toBe(true);
    expect(detection.diagnostics.length).toBeLessThanOrEqual(50);
    const operations = result.structured['operationCompatibility'] as { operation: string; supported: boolean }[];
    expect(operations.find((entry) => entry.operation === 'stage-generation')?.supported).toBe(true);
    const conformance = result.structured['conformance'] as { note: string; groups: unknown[] };
    expect(conformance.note).toContain('Invocation-free');
    expect(conformance.groups.length).toBeGreaterThan(0);
    const boundary = result.structured['boundary'] as { constraints: string[] };
    expect(boundary.constraints.join(' ')).toContain('provider-independent');
  });

  it('runner_doctor diagnoses a profile without any inference request', async () => {
    const { session, server, root } = await runnerToolsSession();
    const log = path.join(root, 'gemini-invocations.jsonl');
    process.env['FAKE_GEMINI_LOG'] = log;
    const gemini = await callTool(session, 'runner_doctor', { profile: 'gemini-default', verbose: true });
    expect(gemini.isError).toBe(false);
    const detection = gemini.structured['detection'] as { status: string; authentication: string };
    expect(detection.status).toBe('available');
    expect(detection.authentication).toBe('unknown');
    expect(gemini.structured['ready']).toBe(true);
    // No headless Gemini invocation happened (probes never reach the log).
    expect(() => readFileSync(log, 'utf8')).toThrow();

    const openai = await callTool(session, 'runner_doctor', { profile: 'openai-compatible-local' });
    expect(openai.isError).toBe(false);
    // The static openai profile (no modelsEndpoint) makes NO request at all.
    expect(server.requests).toHaveLength(0);
  });

  it('runner_doctor defaults to the configured default runner and rejects unknown profiles', async () => {
    const { session } = await runnerToolsSession();
    const fallback = await callTool(session, 'runner_doctor', {});
    expect(fallback.isError).toBe(false);
    expect(fallback.structured['profile']).toBe('mock');
    const unknown = await callTool(session, 'runner_doctor', { profile: 'no-such-profile' });
    expect(unknown.isError).toBe(true);
    expect(unknown.errorCode).toBe('SBMCP002');
  });

  it('runner_matrix matches the shared CLI matrix implementation exactly', async () => {
    const { session, root } = await runnerToolsSession();
    const result = await callTool(session, 'runner_matrix', {});
    expect(result.isError).toBe(false);
    const workspace = (await import('@specbridge/core')).resolveWorkspace(root);
    if (workspace === undefined) throw new Error('fixture has no workspace');
    const read = readAgentConfig(workspace);
    if (read.config === undefined) throw new Error('fixture config invalid');
    const registry = createDefaultRunnerRegistry(read.config);
    const expectedRows = runnerMatrixRows(registry.listProfiles());
    expect(result.structured['rows']).toEqual(JSON.parse(JSON.stringify(expectedRows)));
    expect(result.structured['markdown']).toBe(renderRunnerMatrixMarkdown(expectedRows));
    // Antigravity is present and never advertised beyond experimental.
    const antigravity = expectedRows.find((row) => row.profile === 'antigravity');
    expect(antigravity?.support).toBe('experimental');
    expect(antigravity?.execute).toBe(false);
  });

  it('runner tools are read-only: the configuration file is byte-identical afterwards', async () => {
    const { session, root } = await runnerToolsSession();
    const configPath = path.join(root, '.specbridge', 'config.json');
    const before = readFileSync(configPath);
    await callTool(session, 'runner_list', { detect: true, limit: 200 });
    await callTool(session, 'runner_show', { profile: 'gemini-default' });
    await callTool(session, 'runner_doctor', { profile: 'gemini-default' });
    await callTool(session, 'runner_matrix', {});
    expect(readFileSync(configPath).equals(before)).toBe(true);
  });

  it('no secret value ever appears in any runner tool result', async () => {
    process.env[KEY_VARIABLE] = FAKE_KEY;
    const { session } = await runnerToolsSession();
    for (const [tool, args] of [
      ['runner_list', { detect: false, limit: 200 }],
      ['runner_show', { profile: 'openai-compatible-local' }],
      ['runner_doctor', { profile: 'openai-compatible-local', verbose: true }],
      ['runner_matrix', {}],
    ] as const) {
      const result = await callTool(session, tool, args as Record<string, unknown>);
      const serialized = JSON.stringify(result);
      expect(serialized, tool).not.toContain(FAKE_KEY);
    }
    // The variable NAME may appear (it is configuration); the VALUE never.
    const show = await callTool(session, 'runner_show', { profile: 'openai-compatible-local' });
    const configuration = show.structured['configuration'] as Record<string, unknown>;
    expect(JSON.stringify(configuration)).not.toContain(FAKE_KEY);
  });

  it('concurrent diagnostic reads are safe and log only to the stderr sink', async () => {
    const { session } = await runnerToolsSession();
    const results = await Promise.all([
      callTool(session, 'runner_matrix', {}),
      callTool(session, 'runner_list', {}),
      callTool(session, 'runner_doctor', { profile: 'gemini-default' }),
      callTool(session, 'runner_matrix', {}),
      callTool(session, 'runner_list', { enabledOnly: true }),
    ]);
    for (const result of results) expect(result.isError).toBe(false);
    // Both matrix results are identical (deterministic).
    expect(results[0]?.structured).toEqual(results[3]?.structured);
    // Tool lifecycle events went to the structured stderr logger sink.
    const events = parsedLogs(session).map((entry) => entry.event);
    expect(events).toContain('tool_started');
    expect(events).toContain('tool_completed');
  });
});
