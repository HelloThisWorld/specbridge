import { createServer } from 'node:http';
import type { RequestListener, Server } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  DeerFlowResearchBridge,
  parseDeerFlowContentLocation,
  researchRequestSchema,
} from '@specbridge/orchestration';
import { deerFlowResearchProviderConfigSchema } from '@specbridge/core';

const NOW = new Date('2026-08-29T10:00:00.000Z');

async function localServer(
  handler: RequestListener,
): Promise<{ server: Server; baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

function request(id = 'deerflow-test', depth: 'QUICK' | 'DEEP' = 'QUICK') {
  return researchRequestSchema.parse({
    researchId: id,
    depth,
    question: 'Does current platform X require behavior Y?',
    topicTags: ['platform-x'],
    context: { knownFacts: [], observedFailures: [], failedStrategies: [], constraints: [], contextRefs: [] },
    expectedOutput: { questionsToAnswer: ['Is behavior Y required?'] },
    sourcePolicy: { preferPrimarySources: true, requireSources: true },
  });
}

function payload(): Record<string, unknown> {
  return {
    status: 'COMPLETED',
    findings: [
      {
        findingId: 'finding-1',
        statement: 'Current platform X requires behavior Y.',
        kind: 'COMPATIBILITY_FACT',
        confidence: 'HIGH',
        sourceRefs: ['source-1'],
      },
    ],
    sourceRefs: [
      {
        refId: 'source-1',
        url: 'https://example.test/platform-x',
        title: 'Platform X primary documentation',
      },
    ],
    recommendations: ['Evaluate Y through the product decision path.'],
    unresolved: [],
    conflicts: [],
  };
}

function bridge(baseUrl: string, overrides: Record<string, unknown> = {}, fetchImpl?: typeof fetch) {
  return new DeerFlowResearchBridge(
    deerFlowResearchProviderConfigSchema.parse({
      enabled: true,
      baseUrl,
      timeoutMs: 2_000,
      maxEventBytes: 16_384,
      maxTotalResponseBytes: 65_536,
      ...overrides,
    }),
    { clock: () => NOW, ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}) },
  );
}

function successStream(): string {
  const values = JSON.stringify({
    messages: [{ type: 'ai', content: JSON.stringify(payload()) }],
    usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
  });
  return `event: metadata\ndata: {"run_id":"run-1"}\n\nevent: values\ndata: ${values}\n\nevent: end\ndata: {}\n\n`;
}

describe('DeerFlowResearchBridge health, auth, and network safety', () => {
  it('normalizes healthy, auth failure, malformed health, and server failure', async () => {
    for (const scenario of [
      { path: '/healthy', status: 200, body: '{"status":"healthy"}', expected: 'HEALTHY' },
      { path: '/auth', status: 401, body: '{}', expected: 'AUTH_FAILED' },
      { path: '/malformed', status: 200, body: 'not-json', expected: 'UNKNOWN' },
      { path: '/down', status: 503, body: '{}', expected: 'UNAVAILABLE' },
    ] as const) {
      const fake = await localServer((incoming, response) => {
        if (incoming.url !== `${scenario.path}/health`) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(scenario.status, { 'content-type': 'application/json' }).end(scenario.body);
      });
      try {
        const result = await bridge(`${fake.baseUrl}${scenario.path}`).health();
        expect(result.status, scenario.path).toBe(scenario.expected);
      } finally {
        await fake.close();
      }
    }
  });

  it('maps missing token configuration to AUTH_FAILED without exposing or contacting with a token', async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      throw new Error('must not be called');
    }) as typeof fetch;
    const configured = deerFlowResearchProviderConfigSchema.parse({
      enabled: true,
      baseUrl: 'http://127.0.0.1:2026',
      internalAuthTokenEnvironmentVariable: 'DEERFLOW_TEST_TOKEN',
    });
    const adapter = new DeerFlowResearchBridge(configured, {
      fetch: fakeFetch,
      environment: {},
      clock: () => NOW,
    });
    const health = await adapter.health();
    expect(health.status).toBe('AUTH_FAILED');
    expect(health.detail).toContain('DEERFLOW_TEST_TOKEN');
    expect(calls).toBe(0);
  });

  it('rejects embedded credentials, file URLs, and remote insecure HTTP', () => {
    for (const baseUrl of [
      'http://user:password@127.0.0.1:2026',
      'file:///tmp/deerflow',
      'http://research.example.test:2026',
    ]) {
      expect(() => deerFlowResearchProviderConfigSchema.parse({ enabled: true, baseUrl })).toThrow();
    }
    expect(() =>
      deerFlowResearchProviderConfigSchema.parse({
        enabled: true,
        baseUrl: 'https://research.example.test',
      }),
    ).not.toThrow();
  });

  it('normalizes network refusal and timeout without provider payload leakage', async () => {
    const refusedServer = await localServer((_request, response) => response.end('{}'));
    const refusedUrl = refusedServer.baseUrl;
    await refusedServer.close();
    const refused = await bridge(refusedUrl).health();
    expect(refused.status).toBe('UNAVAILABLE');

    const never = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted === true) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true,
        });
      })) as typeof fetch;
    const timed = await bridge('http://127.0.0.1:2026', { timeoutMs: 1_000 }, never).health();
    expect(timed.status).toBe('UNAVAILABLE');
    expect(timed.detail).toMatch(/timed out|could not be reached/);
  });
});

describe('DeerFlow bounded SSE streaming', () => {
  it('parses arbitrary TCP boundaries, Content-Location ids, final JSON, sources, and usage', async () => {
    let posted = '';
    const fake = await localServer((incoming, response) => {
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => {
        posted += chunk;
      });
      incoming.on('end', () => {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'content-location': '/api/threads/thread-123/runs/run-456',
        });
        const stream = successStream();
        for (let index = 0; index < stream.length; index += 7) {
          response.write(stream.slice(index, index + 7));
        }
        response.end();
      });
    });
    try {
      const result = await bridge(fake.baseUrl).investigate(request());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.providerRefs).toEqual({ threadId: 'thread-123', runId: 'run-456' });
      expect(result.report.status).toBe('COMPLETED');
      expect(result.report.findings[0]?.kind).toBe('COMPATIBILITY_FACT');
      expect(result.report.sourceRefs[0]?.url).toBe('https://example.test/platform-x');
      expect(result.report.usage).toMatchObject({ inputTokens: 11, outputTokens: 22, totalTokens: 33 });
      expect(result.report.usage?.durationMs).toBeUndefined();
      const body = JSON.parse(posted) as { context: Record<string, unknown>; config: { recursion_limit: number } };
      expect(body.context).toMatchObject({
        thinking_enabled: false,
        is_plan_mode: false,
        subagent_enabled: false,
      });
      expect(body.config.recursion_limit).toBe(100);
    } finally {
      await fake.close();
    }
  });

  it('handles CRLF split across TCP chunks and retains metadata ids when the header is absent', async () => {
    const fake = await localServer((_incoming, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const stream = successStream()
        .replace('{"run_id":"run-1"}', '{"thread_id":"thread-meta","run_id":"run-meta"}')
        .replaceAll('\n', '\r\n');
      for (const character of stream) response.write(character);
      response.end();
    });
    try {
      const result = await bridge(fake.baseUrl).investigate(request('metadata-fallback'));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.providerRefs).toEqual({ threadId: 'thread-meta', runId: 'run-meta' });
    } finally {
      await fake.close();
    }
  });

  it('returns structured outcomes for unsourced and inconsistent source references', async () => {
    const cases = [
      {
        id: 'unsourced',
        value: {
          ...payload(),
          findings: [{ ...(payload().findings as Array<Record<string, unknown>>)[0], sourceRefs: [] }],
        },
        expectedOk: true,
        expectedStatus: 'INCONCLUSIVE',
      },
      {
        id: 'bad-source-ref',
        value: { ...payload(), sourceRefs: [] },
        expectedOk: false,
        expectedStatus: 'MALFORMED_RESPONSE',
      },
    ] as const;
    for (const scenario of cases) {
      const fake = await localServer((_incoming, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          `event: values\ndata: ${JSON.stringify({ messages: [{ type: 'ai', content: JSON.stringify(scenario.value) }] })}\n\nevent: end\ndata: {}\n\n`,
        );
      });
      try {
        const result = await bridge(fake.baseUrl).investigate(request(scenario.id));
        expect(result.ok).toBe(scenario.expectedOk);
        expect(result.ok ? result.report.status : result.failure.classification).toBe(scenario.expectedStatus);
      } finally {
        await fake.close();
      }
    }
  });

  it('maps DEEP intent internally without exposing provider mode names', async () => {
    let body: Record<string, unknown> | undefined;
    const fake = await localServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(successStream());
      });
    });
    try {
      const result = await bridge(fake.baseUrl).investigate(request('deep-test', 'DEEP'));
      expect(result.ok).toBe(true);
      const sent = body as { context: Record<string, unknown>; config: { recursion_limit: number } };
      expect(sent.context).toMatchObject({ thinking_enabled: true, is_plan_mode: true, subagent_enabled: true });
      expect(sent.config.recursion_limit).toBe(300);
      expect(JSON.stringify(result)).not.toMatch(/\b(?:flash|pro|ultra)\b/i);
    } finally {
      await fake.close();
    }
  });

  it.each([
    {
      name: 'malformed event',
      stream: 'event: values\ndata: {not-json}\n\nevent: end\ndata: {}\n\n',
    },
    {
      name: 'provider error event',
      stream: 'event: error\ndata: {"message":"provider failed"}\n\n',
    },
    {
      name: 'connection closes early',
      stream: `event: values\ndata: ${JSON.stringify({ messages: [] })}\n\n`,
    },
  ])('normalizes $name without fabricating a report', async ({ stream }) => {
    const fake = await localServer((_incoming, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(stream);
    });
    try {
      const result = await bridge(fake.baseUrl).investigate(request());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.classification).toBe('MALFORMED_RESPONSE');
    } finally {
      await fake.close();
    }
  });

  it('bounds individual events and the total response', async () => {
    for (const scenario of [
      {
        overrides: { maxEventBytes: 1_024, maxTotalResponseBytes: 65_536 },
        stream: `event: values\ndata: ${JSON.stringify({ padding: 'x'.repeat(2_000) })}\n\nevent: end\ndata: {}\n\n`,
      },
      {
        overrides: { maxEventBytes: 4_096, maxTotalResponseBytes: 1_024 },
        stream: `${`event: custom\ndata: {"padding":"${'x'.repeat(800)}"}\n\n`.repeat(3)}event: end\ndata: {}\n\n`,
      },
    ]) {
      const fake = await localServer((_incoming, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(scenario.stream);
      });
      try {
        const result = await bridge(fake.baseUrl, scenario.overrides).investigate(request());
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.failure.classification).toBe('MALFORMED_RESPONSE');
      } finally {
        await fake.close();
      }
    }
  });

  it('normalizes HTTP auth, timeout, and caller abort', async () => {
    const auth = await localServer((_incoming, response) => response.writeHead(403).end('{}'));
    try {
      const result = await bridge(auth.baseUrl).investigate(request());
      expect(!result.ok && result.failure.classification).toBe('AUTHENTICATION');
    } finally {
      await auth.close();
    }

    const never = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted === true) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true,
        });
      })) as typeof fetch;
    const timeout = await bridge('http://127.0.0.1:2026', { timeoutMs: 1_000 }, never).investigate(request());
    expect(!timeout.ok && timeout.failure.classification).toBe('TIMEOUT');

    const controller = new AbortController();
    controller.abort();
    const cancelled = await bridge('http://127.0.0.1:2026', {}, never).investigate(request(), controller.signal);
    expect(!cancelled.ok && cancelled.failure.classification).toBe('CANCELLED');
  });

  it('parses only bounded safe Content-Location identities', () => {
    expect(parseDeerFlowContentLocation('/api/threads/thread-1/runs/run-2')).toEqual({ threadId: 'thread-1', runId: 'run-2' });
    expect(parseDeerFlowContentLocation('file:///threads/a/runs/b')).toBeUndefined();
    expect(parseDeerFlowContentLocation('/api/threads/%2e%2e/runs/run')).toBeUndefined();
    expect(parseDeerFlowContentLocation(null)).toBeUndefined();
  });
});
