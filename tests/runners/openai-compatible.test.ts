import { mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunner } from '@specbridge/runners';
import {
  OpenAiCompatibleRunner,
  checkOperationSupport,
  checkRedirectTarget,
  runRunnerConformance,
} from '@specbridge/runners';
import type { RegisteredRunnerProfile } from '@specbridge/runners';
import type { OpenAiCompatibleProfileConfig } from '@specbridge/core';
import { agentConfigV2Schema, openAiCompatibleProfileSchema } from '@specbridge/core';
import type { FakeOpenAiServer } from '../helpers-fake-openai.js';
import { startFakeOpenAi } from '../helpers-fake-openai.js';

/**
 * OpenAI-compatible authoring adapter tests: every scenario talks to a REAL
 * loopback HTTP server (never a mocked adapter method). Fully offline: no
 * network beyond 127.0.0.1, no model, no real credentials.
 */

const FAKE_KEY = 'sk-FAKE-OPENAI-KEY-1234567890';
const KEY_VARIABLE = 'SPECBRIDGE_TEST_OPENAI_KEY';

const servers: FakeOpenAiServer[] = [];

async function fakeServer(options: Parameters<typeof startFakeOpenAi>[0] = {}): Promise<FakeOpenAiServer> {
  const server = await startFakeOpenAi(options);
  servers.push(server);
  return server;
}

afterEach(async () => {
  delete process.env[KEY_VARIABLE];
  while (servers.length > 0) await servers.pop()?.close();
});

function profileFor(
  server: FakeOpenAiServer,
  overrides: Partial<OpenAiCompatibleProfileConfig> = {},
): OpenAiCompatibleProfileConfig {
  return openAiCompatibleProfileSchema.parse({
    runner: 'openai-compatible',
    enabled: true,
    baseUrl: `${server.baseUrl}/v1`,
    model: 'fake-oai-model',
    timeoutMs: 30_000,
    ...overrides,
  });
}

function scratchDirs(): { workspaceRoot: string; runDir: string } {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'specbridge-oai-test-'));
  return { workspaceRoot, runDir: path.join(workspaceRoot, '.specbridge', 'runs', 'run-1') };
}

const generationInput = {
  specName: 'settings-persistence',
  stage: 'requirements' as const,
  intent: 'generate' as const,
  prompt: '# prompt\n\nStage to produce: requirements\n',
  promptVersion: '1.1.0',
  toolPolicy: 'read-only' as const,
};

const V2_BASE = { schemaVersion: '2.0.0' };

describe('openai-compatible profile validation', () => {
  it('accepts the loopback default and applies safe defaults', () => {
    const profile = openAiCompatibleProfileSchema.parse({ runner: 'openai-compatible' });
    expect(profile.enabled).toBe(false);
    expect(profile.baseUrl).toBe('http://127.0.0.1:8000/v1');
    expect(profile.apiStyle).toBe('chat-completions');
    expect(profile.structuredOutput).toBe('json-schema');
    expect(profile.allowStructuredOutputFallback).toBe(false);
    expect(profile.apiKeyEnvironmentVariable).toBeNull();
    expect(profile.allowInsecureHttp).toBe(false);
  });

  it('rejects unknown API styles and structured-output modes', () => {
    expect(
      openAiCompatibleProfileSchema.safeParse({ runner: 'openai-compatible', apiStyle: 'grpc' }).success,
    ).toBe(false);
    expect(
      openAiCompatibleProfileSchema.safeParse({ runner: 'openai-compatible', structuredOutput: 'yaml' })
        .success,
    ).toBe(false);
  });

  it('accepts remote HTTPS endpoints; rejects remote plain HTTP by default', () => {
    const https = agentConfigV2Schema.safeParse({
      ...V2_BASE,
      runnerProfiles: {
        remote: { runner: 'openai-compatible', baseUrl: 'https://models.example.com/v1' },
      },
    });
    expect(https.success).toBe(true);
    const http = agentConfigV2Schema.safeParse({
      ...V2_BASE,
      runnerProfiles: {
        remote: { runner: 'openai-compatible', baseUrl: 'http://models.example.com/v1' },
      },
    });
    expect(http.success).toBe(false);
  });

  it('the explicit insecure-development override permits remote HTTP and is clearly labeled', () => {
    const result = agentConfigV2Schema.safeParse({
      ...V2_BASE,
      runnerProfiles: {
        dev: {
          runner: 'openai-compatible',
          baseUrl: 'http://10.0.0.5:8000/v1',
          allowInsecureHttp: true,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects embedded credentials, file URLs, and unsupported schemes', () => {
    for (const baseUrl of [
      'https://user:pass@models.example.com/v1',
      'file:///etc/models',
      'ftp://models.example.com/v1',
      'unix:///var/run/model.sock',
    ]) {
      const result = agentConfigV2Schema.safeParse({
        ...V2_BASE,
        runnerProfiles: { bad: { runner: 'openai-compatible', baseUrl } },
      });
      expect(result.success, baseUrl).toBe(false);
    }
  });

  it('accepts an environment-variable NAME and rejects anything value-shaped', () => {
    expect(
      openAiCompatibleProfileSchema.safeParse({
        runner: 'openai-compatible',
        apiKeyEnvironmentVariable: 'MY_PROVIDER_KEY',
      }).success,
    ).toBe(true);
    expect(
      openAiCompatibleProfileSchema.safeParse({
        runner: 'openai-compatible',
        apiKeyEnvironmentVariable: 'sk-abc123 secret-value',
      }).success,
    ).toBe(false);
  });

  it('rejects credential-bearing header names (no key value can enter the config)', () => {
    for (const header of ['Authorization', 'x-api-key', 'Cookie']) {
      expect(
        openAiCompatibleProfileSchema.safeParse({
          runner: 'openai-compatible',
          headers: { [header]: 'value' },
        }).success,
        header,
      ).toBe(false);
    }
    expect(
      openAiCompatibleProfileSchema.safeParse({
        runner: 'openai-compatible',
        headers: { 'x-request-tag': 'specbridge' },
      }).success,
    ).toBe(true);
  });

  it('credential-looking keys anywhere in the profile are rejected', () => {
    const result = agentConfigV2Schema.safeParse({
      ...V2_BASE,
      runnerProfiles: {
        bad: { runner: 'openai-compatible', apiKey: 'sk-value' },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('openai-compatible authoring (chat-completions)', () => {
  it('generates a validated stage report with usage from a no-auth endpoint', async () => {
    const server = await fakeServer();
    const runner = new OpenAiCompatibleRunner(profileFor(server));
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('completed');
    expect(result.report?.stage).toBe('requirements');
    expect(result.report?.markdown).toContain('# Requirements Document');
    expect(result.usage?.inputTokens).toBe(222);
    expect(result.usage?.outputTokens).toBe(111);
    expect(result.usage?.cachedInputTokens).toBe(10);
    // Native JSON Schema was requested (the default mode).
    const [request] = server.inferenceCalls();
    expect(request?.url).toBe('/v1/chat/completions');
    const body = request?.body as { response_format?: { type?: string; json_schema?: { strict?: boolean } } };
    expect(body.response_format?.type).toBe('json_schema');
    expect(body.response_format?.json_schema?.strict).toBe(true);
    // The adapter created no repository files.
    expect(readdirSync(workspaceRoot)).toEqual([]);
  });

  it('stage refinement works through the same request path', async () => {
    const server = await fakeServer({ behaviors: ['valid-design'] });
    const runner = new OpenAiCompatibleRunner(profileFor(server));
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(
      {
        ...generationInput,
        stage: 'design',
        intent: 'refine',
        prompt: 'Refine the design.\n\nStage to produce: design\n',
      },
      { workspaceRoot, runDir, timeoutMs: 30_000 },
    );
    expect(result.outcome).toBe('completed');
    expect(result.report?.stage).toBe('design');
  });

  it('json-object mode sends response_format json_object and validates locally', async () => {
    const server = await fakeServer();
    const runner = new OpenAiCompatibleRunner(profileFor(server, { structuredOutput: 'json-object' }));
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('completed');
    const body = server.inferenceCalls()[0]?.body as { response_format?: { type?: string } };
    expect(body.response_format?.type).toBe('json_object');
  });

  it('strict-json-prompt mode sends no response_format and still validates the complete text', async () => {
    const server = await fakeServer();
    const runner = new OpenAiCompatibleRunner(profileFor(server, { structuredOutput: 'strict-json-prompt' }));
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('completed');
    const body = server.inferenceCalls()[0]?.body as Record<string, unknown>;
    expect(body['response_format']).toBeUndefined();
  });
});

describe('openai-compatible authoring (responses API style)', () => {
  it('generates a validated stage report through POST /responses', async () => {
    const server = await fakeServer();
    const runner = new OpenAiCompatibleRunner(profileFor(server, { apiStyle: 'responses' }));
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('completed');
    expect(result.report?.stage).toBe('requirements');
    expect(result.usage?.inputTokens).toBe(222);
    const [request] = server.inferenceCalls();
    expect(request?.url).toBe('/v1/responses');
    const body = request?.body as { text?: { format?: { type?: string } } };
    expect(body.text?.format?.type).toBe('json_schema');
  });
});

describe('openai-compatible structured-output strictness', () => {
  const run = async (behavior: string, overrides: Partial<OpenAiCompatibleProfileConfig> = {}) => {
    const server = await fakeServer({ behaviors: [behavior as never] });
    const runner = new OpenAiCompatibleRunner(profileFor(server, overrides));
    const { workspaceRoot, runDir } = scratchDirs();
    return {
      server,
      result: await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 }),
    };
  };

  it('invalid JSON is rejected', async () => {
    const { result } = await run('invalid-json');
    expect(result.outcome).toBe('malformed-output');
    expect(result.error?.code).toBe('structured_output_invalid');
    expect(result.invalidStructuredOutput).toContain('not json');
  });

  it('schema-invalid JSON is rejected with the exact problems', async () => {
    const { result } = await run('schema-invalid');
    expect(result.outcome).toBe('malformed-output');
    expect(result.failureReason).toContain('markdown');
  });

  it('extra prose around JSON is rejected (no substring extraction)', async () => {
    const { result } = await run('extra-prose');
    expect(result.outcome).toBe('malformed-output');
    expect(result.report).toBeUndefined();
  });

  it('Markdown-fenced JSON is rejected (fences are not parsed)', async () => {
    const { result } = await run('fenced-json');
    expect(result.outcome).toBe('malformed-output');
    expect(result.report).toBeUndefined();
  });

  it('an unsupported native mode fails hard when no fallback is configured — no silent downgrade', async () => {
    const { server, result } = await run('http-400-schema-unsupported');
    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('structured_output_unsupported');
    // Exactly ONE request: no hidden second attempt with a weaker mode.
    expect(server.inferenceCalls()).toHaveLength(1);
  });

  it('the explicit fallback option downgrades once, with a warning', async () => {
    const server = await fakeServer({ behaviors: ['http-400-schema-unsupported', 'valid'] });
    const runner = new OpenAiCompatibleRunner(
      profileFor(server, { allowStructuredOutputFallback: true }),
    );
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('completed');
    expect(result.warnings.join(' ')).toContain('json-object');
    const calls = server.inferenceCalls();
    expect(calls).toHaveLength(2);
    const second = calls[1]?.body as { response_format?: { type?: string } };
    expect(second.response_format?.type).toBe('json_object');
  });

  it('the correction retry context reaches the endpoint as extra messages', async () => {
    const server = await fakeServer({ behaviors: ['invalid-json', 'valid'] });
    const runner = new OpenAiCompatibleRunner(profileFor(server));
    const { workspaceRoot, runDir } = scratchDirs();
    const first = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(first.outcome).toBe('malformed-output');
    const corrected = await runner.generateStage(
      {
        ...generationInput,
        correction: {
          previousOutput: first.invalidStructuredOutput ?? '',
          problems: 'not a JSON document',
        },
      },
      { workspaceRoot, runDir, timeoutMs: 30_000 },
    );
    expect(corrected.outcome).toBe('completed');
    const second = server.inferenceCalls()[1]?.body as { messages?: unknown[] };
    expect(second.messages).toHaveLength(3);
  });

  it('a failed correction retry stops with the malformed result (no loop)', async () => {
    const server = await fakeServer({ behaviors: ['invalid-json'] });
    const runner = new OpenAiCompatibleRunner(profileFor(server));
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(
      { ...generationInput, correction: { previousOutput: 'x', problems: 'y' } },
      { workspaceRoot, runDir, timeoutMs: 30_000 },
    );
    expect(result.outcome).toBe('malformed-output');
  });
});

describe('openai-compatible authentication and secret redaction', () => {
  it('sends the key from the configured environment variable and never retains its value', async () => {
    process.env[KEY_VARIABLE] = FAKE_KEY;
    const server = await fakeServer({ requireBearer: FAKE_KEY });
    const config = profileFor(server, { apiKeyEnvironmentVariable: KEY_VARIABLE });
    // The profile stores the NAME only.
    expect(JSON.stringify(config)).not.toContain(FAKE_KEY);
    const runner = new OpenAiCompatibleRunner(config);
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('completed');
    // The server received it; nothing retained contains it.
    expect(server.inferenceCalls()[0]?.headers['authorization']).toBe(`Bearer ${FAKE_KEY}`);
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });

  it('an endpoint without authentication works with no key configured', async () => {
    const server = await fakeServer();
    const runner = new OpenAiCompatibleRunner(profileFor(server));
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('completed');
    expect(server.inferenceCalls()[0]?.headers['authorization']).toBeUndefined();
  });

  it('authentication errors are normalized and the provider message is not echoed as-is', async () => {
    process.env[KEY_VARIABLE] = FAKE_KEY;
    const server = await fakeServer({ behaviors: ['http-401'] });
    const runner = new OpenAiCompatibleRunner(profileFor(server, { apiKeyEnvironmentVariable: KEY_VARIABLE }));
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.error?.code).toBe('authentication_required');
    expect(result.error?.retryable).toBe(false);
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });

  it('detection reports an unset key variable without reading anything else', async () => {
    const server = await fakeServer();
    const runner = new OpenAiCompatibleRunner(
      profileFor(server, { apiKeyEnvironmentVariable: 'SPECBRIDGE_TEST_UNSET_VARIABLE_XYZ' }),
    );
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    expect(detection.authentication).toBe('unauthenticated');
    expect(detection.status).toBe('misconfigured');
    expect(detection.diagnostics.some((d) => d.code === 'RUNNER_API_KEY_VARIABLE_UNSET')).toBe(true);
  });
});

describe('openai-compatible failure classification and limits', () => {
  it('rate limits are normalized', async () => {
    const server = await fakeServer({ behaviors: ['http-429-rate'] });
    const runner = new OpenAiCompatibleRunner(profileFor(server));
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.error?.code).toBe('rate_limited');
  });

  it('quota exhaustion is normalized as non-retryable', async () => {
    const server = await fakeServer({ behaviors: ['http-429-quota'] });
    const runner = new OpenAiCompatibleRunner(profileFor(server));
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.error?.code).toBe('quota_exceeded');
    expect(result.error?.retryable).toBe(false);
  });

  it('a timeout aborts the request deterministically', async () => {
    const server = await fakeServer({ behaviors: ['timeout'] });
    const runner = new OpenAiCompatibleRunner(profileFor(server));
    const { workspaceRoot, runDir } = scratchDirs();
    const started = Date.now();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 1_500 });
    expect(result.outcome).toBe('timed-out');
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('cancellation aborts the request deterministically', async () => {
    const server = await fakeServer({ behaviors: ['timeout'] });
    const runner = new OpenAiCompatibleRunner(profileFor(server));
    const { workspaceRoot, runDir } = scratchDirs();
    const controller = new AbortController();
    const pending = runner.generateStage(generationInput, {
      workspaceRoot,
      runDir,
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    const result = await pending;
    expect(result.outcome).toBe('cancelled');
    expect(result.error?.code).toBe('cancelled');
  });

  it('the response-size limit aborts oversized bodies without parsing them', async () => {
    const server = await fakeServer({ behaviors: ['huge'] });
    const runner = new OpenAiCompatibleRunner(profileFor(server, { maximumOutputBytes: 64 * 1024 }));
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('output_limit_exceeded');
    expect(result.report).toBeUndefined();
  });

  it('the input-size limit refuses BEFORE any request is sent', async () => {
    const server = await fakeServer();
    const runner = new OpenAiCompatibleRunner(profileFor(server, { maximumInputCharacters: 1000 }));
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(
      { ...generationInput, prompt: 'x'.repeat(2000) },
      { workspaceRoot, runDir, timeoutMs: 30_000 },
    );
    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('invalid_configuration');
    expect(server.requests).toHaveLength(0);
  });
});

describe('openai-compatible redirect policy', () => {
  it('a same-origin redirect is followed within the bound', async () => {
    const server = await fakeServer({ behaviors: ['redirect-same-origin'] });
    const runner = new OpenAiCompatibleRunner(profileFor(server));
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('completed');
    // Two requests on the same server: original + redirected hop.
    expect(server.inferenceCalls().map((call) => call.url)).toEqual([
      '/v1/chat/completions',
      '/redirected/v1/chat/completions',
    ]);
  });

  it('a redirect loop is stopped at the bounded limit', async () => {
    const server = await fakeServer({ behaviors: ['redirect-loop'] });
    const runner = new OpenAiCompatibleRunner(profileFor(server));
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('endpoint_unreachable');
    expect(result.failureReason).toContain('redirect');
    // 1 original + 3 followed hops, then refusal.
    expect(server.inferenceCalls().length).toBeLessThanOrEqual(4);
  });

  it('a cross-origin redirect never forwards the Authorization header', async () => {
    process.env[KEY_VARIABLE] = FAKE_KEY;
    const target = await fakeServer();
    const origin = await fakeServer({
      behaviors: ['redirect-cross-origin'],
      redirectTargetUrl: target.baseUrl,
    });
    const runner = new OpenAiCompatibleRunner(
      profileFor(origin, { apiKeyEnvironmentVariable: KEY_VARIABLE }),
    );
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('completed');
    // The origin got the key; the cross-origin hop did NOT.
    expect(origin.inferenceCalls()[0]?.headers['authorization']).toBe(`Bearer ${FAKE_KEY}`);
    const hop = target.requests.find((entry) => entry.url.startsWith('/redirected'));
    expect(hop).toBeDefined();
    expect(hop?.headers['authorization']).toBeUndefined();
  });

  it('an HTTPS-to-HTTP downgrade is rejected by the redirect policy', () => {
    const decision = checkRedirectTarget(
      new URL('https://models.example.com/v1/chat/completions'),
      'http://models.example.com/v1/chat/completions',
    );
    expect(decision.ok).toBe(false);
    expect(decision.detail).toContain('downgrade');
  });

  it('redirects to unsupported schemes and credential-bearing targets are rejected', async () => {
    const server = await fakeServer({ behaviors: ['redirect-ftp'] });
    const runner = new OpenAiCompatibleRunner(profileFor(server));
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('failed');
    expect(result.failureReason).toContain('unsupported scheme');
    const credential = checkRedirectTarget(
      new URL('https://models.example.com/v1'),
      'https://user:pass@other.example.com/v1',
    );
    expect(credential.ok).toBe(false);
  });
});

describe('openai-compatible capability boundaries', () => {
  it('task execution is rejected by declared capabilities and defensively by the adapter', async () => {
    const server = await fakeServer();
    const runner = new OpenAiCompatibleRunner(profileFor(server));
    expect(checkOperationSupport('task-execution', runner.declaredCapabilities).supported).toBe(false);
    expect(checkOperationSupport('task-resume', runner.declaredCapabilities).supported).toBe(false);
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.executeTask(
      {
        specName: 'settings-persistence',
        taskId: '2.4',
        prompt: 'implement',
        promptVersion: '1.1.0',
        toolPolicy: 'implementation',
      },
      { workspaceRoot, runDir, timeoutMs: 30_000 },
    );
    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('unsupported_operation');
    // No HTTP request happened.
    expect(server.requests).toHaveLength(0);
  });

  it('resume is not implemented at all (capability-rejected)', async () => {
    const server = await fakeServer();
    const runner = new OpenAiCompatibleRunner(profileFor(server));
    expect((runner as AgentRunner).resumeTask).toBeUndefined();
  });
});

describe('openai-compatible model listing (no inference)', () => {
  it('lists models through GET /models when the profile declares support', async () => {
    const server = await fakeServer();
    const runner = new OpenAiCompatibleRunner(profileFor(server, { modelsEndpoint: true }));
    const models = await runner.listModels({ workspaceRoot: process.cwd() });
    expect(models.supported).toBe(true);
    expect(models.models.map((model) => model.name)).toEqual(['fake-oai-model', 'fake-oai-mini']);
    // Safe reported fields only — no invented capabilities.
    expect(models.models[0]).not.toHaveProperty('capabilities');
    // GET only; no inference request occurred.
    expect(server.requests.every((entry) => entry.method === 'GET')).toBe(true);
  });

  it('is honestly unsupported when the profile does not declare the endpoint', async () => {
    const server = await fakeServer();
    const runner = new OpenAiCompatibleRunner(profileFor(server));
    const models = await runner.listModels({ workspaceRoot: process.cwd() });
    expect(models.supported).toBe(false);
    expect(models.models).toEqual([]);
    expect(server.requests).toHaveLength(0);
  });

  it('doctor probes reachability ONLY when the models endpoint is declared', async () => {
    const server = await fakeServer();
    const withProbe = new OpenAiCompatibleRunner(profileFor(server, { modelsEndpoint: true }));
    const detection = await withProbe.detect({ workspaceRoot: process.cwd() });
    expect(detection.status).toBe('available');
    expect(server.requests.every((entry) => entry.method === 'GET')).toBe(true);

    const before = server.requests.length;
    const withoutProbe = new OpenAiCompatibleRunner(profileFor(server));
    const staticDetection = await withoutProbe.detect({ workspaceRoot: process.cwd() });
    expect(staticDetection.status).toBe('available');
    expect(staticDetection.diagnostics.some((d) => d.code === 'RUNNER_REACHABILITY_NOT_PROBED')).toBe(true);
    // No request of any kind happened for the static profile.
    expect(server.requests.length).toBe(before);
  });
});

describe('openai-compatible conformance (fake endpoint, full invocations)', () => {
  it('passes the applicable authoring groups; task-execution conformance is not applicable', async () => {
    const server = await fakeServer();
    const config = profileFor(server);
    const profile: RegisteredRunnerProfile = {
      name: 'openai-compatible-local',
      config,
      runner: new OpenAiCompatibleRunner(config),
    };
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'specbridge-oai-conf-'));
    const { EXECUTION_CONFORMANCE_GROUPS } = await import('@specbridge/execution');
    const result = await runRunnerConformance(
      {
        profile,
        workspaceRoot: scratch,
        runDir: path.join(scratch, '.specbridge-conformance-runs'),
        invocationsAllowed: true,
        timeoutMs: 60_000,
      },
      EXECUTION_CONFORMANCE_GROUPS,
    );
    const failed = result.groups.flatMap((group) => group.checks.filter((check) => check.status === 'failed'));
    expect(failed.map((check) => `${check.id}: ${check.detail ?? ''}`)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.groups.find((group) => group.group === 'task-execution')?.applicable).toBe(false);
    expect(result.groups.find((group) => group.group === 'resume')?.applicable).toBe(false);
  }, 120_000);
});
