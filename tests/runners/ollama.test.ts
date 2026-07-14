import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OllamaProfileConfig } from '@specbridge/core';
import { ollamaProfileSchema } from '@specbridge/core';
import { OllamaRunner } from '@specbridge/runners';
import { FAKE_THINKING_SECRET, startFakeOllama } from '../helpers-fake-ollama.js';
import type { FakeChatBehavior, FakeOllamaServer } from '../helpers-fake-ollama.js';

/**
 * Ollama adapter tests against a REAL loopback HTTP server (never mocked
 * adapter methods). Fully offline: 127.0.0.1 only, no model, no credentials.
 */

function ollamaConfig(baseUrl: string, overrides: Partial<OllamaProfileConfig> = {}): OllamaProfileConfig {
  return ollamaProfileSchema.parse({
    runner: 'ollama',
    enabled: true,
    baseUrl,
    model: 'qwen-fake:7b',
    timeoutMs: 15_000,
    ...overrides,
  });
}

function execution(timeoutMs = 15_000): { workspaceRoot: string; runDir: string; timeoutMs: number } {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'specbridge-ollama-test-'));
  return { workspaceRoot, runDir: path.join(workspaceRoot, 'run'), timeoutMs };
}

const generationInput = {
  specName: 'settings-persistence',
  stage: 'requirements' as const,
  intent: 'generate' as const,
  prompt: '# prompt\n\nStage to produce: requirements\n',
  promptVersion: '1.1.0',
  toolPolicy: 'read-only' as const,
};

async function withServer(
  options: Parameters<typeof startFakeOllama>[0],
  body: (server: FakeOllamaServer) => Promise<void>,
): Promise<void> {
  const server = await startFakeOllama(options);
  try {
    await body(server);
  } finally {
    await server.close();
  }
}

describe('ollama detection (read-only; no inference)', () => {
  it('detects a loopback endpoint, version, models, and the configured model', async () => {
    await withServer({}, async (server) => {
      const runner = new OllamaRunner(ollamaConfig(server.baseUrl));
      const detection = await runner.detect({ workspaceRoot: process.cwd() });
      expect(detection.status).toBe('available');
      expect(detection.version).toBe('0.9.9-fake');
      expect(detection.category).toBe('model-api');
      expect(detection.networkBacked).toBe(false);
      expect(detection.capabilitySet.localOnly).toBe(true);
      expect(detection.capabilitySet.taskExecution).toBe(false);
      expect(detection.capabilitySet.repositoryWrite).toBe(false);
      // Detection performed no /api/chat request (no model request).
      expect(server.chatCalls()).toHaveLength(0);
    });
  });

  it('reports an unreachable endpoint as unavailable', async () => {
    const server = await startFakeOllama({});
    await server.close();
    const runner = new OllamaRunner(ollamaConfig(server.baseUrl));
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    expect(detection.status).toBe('unavailable');
    expect(detection.supportLevel).toBe('unavailable');
  });

  it('a missing configured model is misconfigured — never auto-selected, never pulled', async () => {
    await withServer({ models: ['other-model:3b'] }, async (server) => {
      const runner = new OllamaRunner(ollamaConfig(server.baseUrl, { model: 'qwen-fake:7b' }));
      const detection = await runner.detect({ workspaceRoot: process.cwd() });
      expect(detection.status).toBe('misconfigured');
      expect(detection.diagnostics.map((d) => d.message).join(' ')).toContain('never pulls models automatically');
      // Only read-only GETs happened: no pull, no delete, no chat.
      expect(server.requests.every((request) => request.method === 'GET')).toBe(true);
    });
  });

  it('no configured model is misconfigured for generation with listing still available', async () => {
    await withServer({}, async (server) => {
      const runner = new OllamaRunner(ollamaConfig(server.baseUrl, { model: null }));
      const detection = await runner.detect({ workspaceRoot: process.cwd() });
      expect(detection.status).toBe('misconfigured');
      expect(detection.diagnostics.map((d) => d.message).join(' ')).toContain('never selects a model automatically');
      const models = await runner.listModels({ workspaceRoot: process.cwd() });
      expect(models.supported).toBe(true);
      expect(models.models.map((model) => model.name)).toContain('qwen-fake:7b');
    });
  });

  it('lists models with metadata and local classification', async () => {
    await withServer({}, async (server) => {
      const runner = new OllamaRunner(ollamaConfig(server.baseUrl));
      const models = await runner.listModels({ workspaceRoot: process.cwd() });
      expect(models.supported).toBe(true);
      const first = models.models[0];
      expect(first?.family).toBe('fake');
      expect(first?.parameterSize).toBe('7B');
      expect(first?.quantization).toBe('Q4_K_M');
      expect(first?.location).toBe('local');
      expect(server.chatCalls()).toHaveLength(0);
    });
  });
});

describe('ollama structured output (schema-validated, bounded)', () => {
  it('a valid structured request completes with usage and unavailable cost', async () => {
    await withServer({}, async (server) => {
      const runner = new OllamaRunner(ollamaConfig(server.baseUrl));
      const result = await runner.generateStage(generationInput, execution());
      expect(result.outcome).toBe('completed');
      expect(result.report?.markdown).toContain('# Requirements Document');
      expect(result.usage?.inputTokens).toBe(321);
      expect(result.usage?.outputTokens).toBe(123);
      expect(result.usage?.model).toBe('qwen-fake:7b');
      // Local does not mean free — cost is UNAVAILABLE, never zero.
      expect(result.cost?.source).toBe('unavailable');
      expect(result.cost?.amount).toBeNull();
      // The request carried the JSON Schema through the format field.
      const chat = server.chatCalls()[0]?.body as { format?: unknown; stream?: boolean; options?: { temperature?: number } };
      expect(chat.format).toBeDefined();
      expect(chat.stream).toBe(false);
      expect(chat.options?.temperature).toBe(0);
    });
  });

  it('thinking content is never exposed in results or retained artifacts', async () => {
    await withServer({}, async (server) => {
      const runner = new OllamaRunner(ollamaConfig(server.baseUrl));
      const result = await runner.generateStage(generationInput, execution());
      expect(JSON.stringify(result)).not.toContain(FAKE_THINKING_SECRET);
      expect(result.rawStdout).toContain('[redacted thinking');
    });
  });

  it('invalid JSON content is malformed-output with the candidate retained', async () => {
    await withServer({ chatBehaviors: ['invalid-json'] }, async (server) => {
      const runner = new OllamaRunner(ollamaConfig(server.baseUrl));
      const result = await runner.generateStage(generationInput, execution());
      expect(result.outcome).toBe('malformed-output');
      expect(result.error?.code).toBe('structured_output_invalid');
      expect(result.invalidStructuredOutput).toContain('not json');
      expect(server.chatCalls()).toHaveLength(1);
    });
  });

  it('schema-invalid JSON is malformed-output with validation problems', async () => {
    await withServer({ chatBehaviors: ['schema-invalid'] }, async (server) => {
      const runner = new OllamaRunner(ollamaConfig(server.baseUrl));
      const result = await runner.generateStage(generationInput, execution());
      expect(result.outcome).toBe('malformed-output');
      expect(result.failureReason).toContain('markdown');
      void server;
    });
  });

  it('markdown code fences are NOT parsed as structured output', async () => {
    await withServer({ chatBehaviors: ['fenced-json'] }, async (server) => {
      const runner = new OllamaRunner(ollamaConfig(server.baseUrl));
      const result = await runner.generateStage(generationInput, execution());
      expect(result.outcome).toBe('malformed-output');
      void server;
    });
  });

  it('the correction retry input produces a correction conversation', async () => {
    await withServer({ chatBehaviors: ['valid'] }, async (server) => {
      const runner = new OllamaRunner(ollamaConfig(server.baseUrl));
      const result = await runner.generateStage(
        {
          ...generationInput,
          correction: { previousOutput: 'not json {', problems: 'markdown: Required' },
        },
        execution(),
      );
      expect(result.outcome).toBe('completed');
      const chat = server.chatCalls()[0]?.body as { messages: { role: string; content: string }[] };
      expect(chat.messages).toHaveLength(3);
      expect(chat.messages[1]?.role).toBe('assistant');
      expect(chat.messages[1]?.content).toBe('not json {');
      expect(chat.messages[2]?.content).toContain('Validation problems');
    });
  });
});

describe('ollama HTTP failure classification', () => {
  const run = async (behaviors: FakeChatBehavior[], timeoutMs = 15_000) => {
    const server = await startFakeOllama({ chatBehaviors: behaviors });
    try {
      const runner = new OllamaRunner(ollamaConfig(server.baseUrl, { timeoutMs }));
      return await runner.generateStage(generationInput, execution(timeoutMs));
    } finally {
      await server.close();
    }
  };

  it('HTTP 5xx is a retryable api_error', async () => {
    const result = await run(['http-500']);
    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('api_error');
    expect(result.error?.retryable).toBe(true);
  });

  it('HTTP 429 is rate_limited', async () => {
    const result = await run(['http-429']);
    expect(result.error?.code).toBe('rate_limited');
  });

  it('HTTP 401 is authentication_required (never retried)', async () => {
    const result = await run(['http-401']);
    expect(result.error?.code).toBe('authentication_required');
    expect(result.error?.retryable).toBe(false);
  });

  it('HTTP 404 with a model hint is model_not_found', async () => {
    const result = await run(['http-404-model']);
    expect(result.error?.code).toBe('model_not_found');
  });

  it('a timeout aborts the request deterministically', async () => {
    const started = Date.now();
    const result = await run(['timeout'], 1_500);
    expect(result.outcome).toBe('timed-out');
    expect(result.error?.code).toBe('timed_out');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('cancellation aborts the request', async () => {
    const server = await startFakeOllama({ chatBehaviors: ['timeout'] });
    try {
      const runner = new OllamaRunner(ollamaConfig(server.baseUrl));
      const controller = new AbortController();
      const pending = runner.generateStage(generationInput, {
        ...execution(60_000),
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 200);
      const result = await pending;
      expect(result.outcome).toBe('cancelled');
      expect(result.error?.code).toBe('cancelled');
    } finally {
      await server.close();
    }
  });

  it('the response size limit aborts oversized bodies', async () => {
    const server = await startFakeOllama({ chatBehaviors: ['huge'] });
    try {
      const runner = new OllamaRunner(
        ollamaConfig(server.baseUrl, { maximumOutputBytes: 64 * 1024 }),
      );
      const result = await runner.generateStage(generationInput, execution());
      expect(result.outcome).toBe('failed');
      expect(result.error?.code).toBe('output_limit_exceeded');
    } finally {
      await server.close();
    }
  });

  it('the input size limit refuses oversized prompts before any request', async () => {
    const server = await startFakeOllama({});
    try {
      const runner = new OllamaRunner(
        ollamaConfig(server.baseUrl, { maximumInputCharacters: 1000 }),
      );
      const result = await runner.generateStage(
        { ...generationInput, prompt: 'x'.repeat(5000) },
        execution(),
      );
      expect(result.outcome).toBe('failed');
      expect(result.error?.code).toBe('invalid_configuration');
      expect(server.chatCalls()).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('an unexpected content type is rejected', async () => {
    const result = await run(['wrong-content-type']);
    expect(result.outcome).toBe('malformed-output');
    expect(result.error?.code).toBe('api_error');
  });

  it('redirects are never followed', async () => {
    const result = await run(['redirect']);
    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('endpoint_unreachable');
    expect(result.failureReason).toContain('redirect');
  });
});

describe('ollama boundaries', () => {
  it('task execution is refused without any HTTP request or repository access', async () => {
    const server = await startFakeOllama({});
    try {
      const runner = new OllamaRunner(ollamaConfig(server.baseUrl));
      const result = await runner.executeTask(
        {
          specName: 's',
          taskId: '1',
          prompt: 'x',
          promptVersion: '1',
          toolPolicy: 'implementation',
        },
        execution(),
      );
      expect(result.outcome).toBe('failed');
      expect(result.error?.code).toBe('unsupported_operation');
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('embedded credentials, bad schemes, and non-loopback HTTP are refused before requests', async () => {
    for (const baseUrl of [
      'http://user:pass@127.0.0.1:11434',
      'ftp://127.0.0.1:11434',
      'http://remote.example.com:11434',
    ]) {
      // Constructed directly (bypassing the config schema) to prove the
      // adapter re-validates the URL itself — defense in depth.
      const runner = new OllamaRunner({
        runner: 'ollama',
        enabled: true,
        baseUrl,
        model: 'm',
        temperature: 0,
        timeoutMs: 5_000,
        maximumInputCharacters: 500_000,
        maximumOutputBytes: 2_097_152,
        allowInsecureHttp: false,
      } as never);
      const result = await runner.generateStage(generationInput, execution());
      expect(result.outcome, baseUrl).toBe('failed');
      expect(result.error?.code, baseUrl).toBe('invalid_configuration');
    }
  });

  it('a remote HTTPS endpoint is classified network-backed in detection', async () => {
    const runner = new OllamaRunner(
      ollamaConfig('https://ollama.example.invalid', { model: 'qwen-fake:7b' }),
    );
    const detection = await runner.detect({ workspaceRoot: process.cwd(), timeoutMs: 1_500 });
    expect(detection.networkBacked).toBe(true);
    expect(detection.capabilitySet.localOnly).toBe(false);
    expect(detection.capabilitySet.requiresNetwork).toBe(true);
    // Unreachable (invalid host) — still classified honestly.
    expect(detection.status).toBe('unavailable');
  });
});
