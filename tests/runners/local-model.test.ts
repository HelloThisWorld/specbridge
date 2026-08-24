import { afterEach, describe, expect, it } from 'vitest';
import type { LocalInferenceConfig } from '@specbridge/core';
import { effectiveLocalInputCharacters, localInferenceConfigSchema } from '@specbridge/core';
import {
  LocalModelManager,
  localModelDoctor,
  localStructuredInference,
} from '@specbridge/runners';
import type { LocalModelEvent } from '@specbridge/runners';
import { AGENT_OUTPUT_JSON_SCHEMAS, validateAgentOutput } from '@specbridge/orchestration';
import { fixturePath } from '../helpers.js';

/**
 * LocalModelManager lifecycle against a REAL child process (the fake
 * llama-server node script) and structured inference against its real HTTP
 * endpoint. Fully offline: everything binds to 127.0.0.1.
 */

const FAKE_LLAMA = fixturePath('fake-llama', 'fake-llama-server.mjs');

function config(overrides: Partial<LocalInferenceConfig> & { scenario?: string } = {}): LocalInferenceConfig {
  const { scenario, ...rest } = overrides;
  const parsed = localInferenceConfigSchema.parse({
    enabled: true,
    executable: process.execPath,
    executableArgs: [FAKE_LLAMA],
    model: FAKE_LLAMA,
    ...(scenario !== undefined ? { extraArgs: [`--scenario=${scenario}`] } : {}),
  });
  return { ...parsed, ...rest };
}

const managers: LocalModelManager[] = [];
function manager(options: ConstructorParameters<typeof LocalModelManager>[0]): LocalModelManager {
  const instance = new LocalModelManager(options);
  managers.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((instance) => instance.stop('test cleanup')));
});

describe('LocalModelManager', () => {
  it('refuses to start when disabled', async () => {
    const instance = manager({ config: { ...config(), enabled: false } });
    const result = await instance.ensureStarted();
    expect(result).toMatchObject({ ok: false, kind: 'disabled' });
  });

  it('reports a missing executable without spawning anything', async () => {
    const instance = manager({
      config: config({ executable: `${FAKE_LLAMA}.does-not-exist.exe` }),
    });
    const result = await instance.ensureStarted();
    expect(result).toMatchObject({ ok: false, kind: 'executable-missing' });
    expect(instance.status()).toBe('stopped');
  });

  it('reports a missing model file', async () => {
    const instance = manager({ config: config({ model: `${FAKE_LLAMA}.missing.gguf` }) });
    const result = await instance.ensureStarted();
    expect(result).toMatchObject({ ok: false, kind: 'model-missing' });
  });

  it('starts, becomes healthy on loopback, and is idempotent', async () => {
    const events: LocalModelEvent[] = [];
    const instance = manager({
      config: config(),
      healthPollMs: 60,
      onEvent: (event) => events.push(event),
    });
    const result = await instance.ensureStarted();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      expect(result.restarted).toBe(false);
    }
    expect(instance.status()).toBe('ready');
    expect(instance.endpoint()).toContain('127.0.0.1');
    // Idempotent: a second call reuses the running server.
    const again = await instance.ensureStarted();
    expect(again.ok).toBe(true);
    expect(events.map((event) => event.type)).toEqual(['starting', 'ready']);
    // Bounded log capture saw the server's stdout.
    expect(instance.logsExcerpt()).toContain('fake-llama-server');
  });

  it('startup times out against a never-healthy server and cleans up', async () => {
    const instance = manager({
      config: { ...config({ scenario: 'never-healthy' }), startupTimeoutMs: 1_500 },
      healthPollMs: 100,
    });
    const result = await instance.ensureStarted();
    expect(result).toMatchObject({ ok: false, kind: 'startup-timeout' });
    expect(instance.status()).toBe('failed');
  }, 15_000);

  it('detects a process that exits during startup', async () => {
    const instance = manager({
      config: config({ scenario: 'exit-early' }),
      healthPollMs: 60,
    });
    const result = await instance.ensureStarted();
    expect(result).toMatchObject({ ok: false, kind: 'process-exited' });
    expect(instance.status()).toBe('failed');
  });

  it('cancellation aborts startup', async () => {
    const controller = new AbortController();
    const instance = manager({
      config: config({ scenario: 'slow-health' }),
      healthPollMs: 60,
    });
    const startPromise = instance.ensureStarted(controller.signal);
    controller.abort();
    const result = await startPromise;
    expect(result).toMatchObject({ ok: false, kind: 'cancelled' });
  });

  it('an unexpected exit is a worker failure with a bounded lazy restart', async () => {
    const instance = manager({
      config: { ...config({ scenario: 'die-on-infer' }), maxRestarts: 1 },
      healthPollMs: 60,
    });
    const first = await instance.ensureStarted();
    expect(first.ok).toBe(true);
    // The inference request kills the fake server.
    if (first.ok) {
      const inference = await localStructuredInference({
        baseUrl: first.baseUrl,
        systemPrompt: 's',
        userPrompt: 'u',
        jsonSchema: AGENT_OUTPUT_JSON_SCHEMAS['PLANNER'] as Record<string, unknown>,
        schemaName: 'PLANNER',
        temperature: 0,
        timeoutMs: 5_000,
        maxOutputBytes: 1_048_576,
      });
      expect(inference.ok).toBe(false);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(instance.status()).toBe('failed');

    // First restart is within budget…
    const second = await instance.ensureStarted();
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.restarted).toBe(true);
    expect(instance.restartCount()).toBe(1);

    // …kill it again: the budget is exhausted and the manager refuses.
    if (second.ok) {
      await localStructuredInference({
        baseUrl: second.baseUrl,
        systemPrompt: 's',
        userPrompt: 'u',
        jsonSchema: AGENT_OUTPUT_JSON_SCHEMAS['PLANNER'] as Record<string, unknown>,
        schemaName: 'PLANNER',
        temperature: 0,
        timeoutMs: 5_000,
        maxOutputBytes: 1_048_576,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const third = await instance.ensureStarted();
    expect(third).toMatchObject({ ok: false, kind: 'restart-budget-exhausted' });
  }, 30_000);

  it('idle shutdown stops the server after the quiet period', async () => {
    const instance = manager({
      config: { ...config(), idleShutdownMs: 400 },
      healthPollMs: 60,
    });
    const result = await instance.ensureStarted();
    expect(result.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(instance.status()).toBe('stopped');
  }, 15_000);

  it('stop() reaps the child and is safe to call repeatedly', async () => {
    const instance = manager({ config: config(), healthPollMs: 60 });
    await instance.ensureStarted();
    await instance.stop('test');
    expect(instance.status()).toBe('stopped');
    await instance.stop('again');
    expect(instance.endpoint()).toBeUndefined();
  });
});

describe('localStructuredInference', () => {
  async function readyManager(scenario?: string): Promise<{ baseUrl: string }> {
    const instance = manager({
      config: config(scenario !== undefined ? { scenario } : {}),
      healthPollMs: 60,
    });
    const result = await instance.ensureStarted();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    return { baseUrl: result.baseUrl };
  }

  it('one endpoint serves multiple roles with schema-appropriate answers', async () => {
    const { baseUrl } = await readyManager();
    for (const role of ['PLANNER', 'CRITIC', 'DIAGNOSER', 'REPLANNER', 'CLASSIFIER'] as const) {
      const result = await localStructuredInference({
        baseUrl,
        systemPrompt: 'system',
        userPrompt: 'packet',
        jsonSchema: AGENT_OUTPUT_JSON_SCHEMAS[role] as Record<string, unknown>,
        schemaName: role,
        temperature: 0,
        timeoutMs: 5_000,
        maxOutputBytes: 1_048_576,
      });
      expect(result.ok, `${role} inference`).toBe(true);
      if (result.ok) {
        const validated = validateAgentOutput(role, result.text);
        expect(validated.ok, `${role} contract`).toBe(true);
        expect(result.usage?.inputTokens).toBe(120);
        expect(result.downgradedStructuredOutput).toBe(false);
      }
    }
  }, 20_000);

  it('downgrades once to json-object when json-schema is rejected, and reports it', async () => {
    const { baseUrl } = await readyManager('schema-unsupported');
    const result = await localStructuredInference({
      baseUrl,
      systemPrompt: 's',
      userPrompt: 'u',
      jsonSchema: AGENT_OUTPUT_JSON_SCHEMAS['CRITIC'] as Record<string, unknown>,
      schemaName: 'CRITIC',
      temperature: 0,
      timeoutMs: 5_000,
      maxOutputBytes: 1_048_576,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.downgradedStructuredOutput).toBe(true);
  }, 15_000);

  it('prose output passes transport but fails the contract (no substring mining)', async () => {
    const { baseUrl } = await readyManager('invalid-output');
    const result = await localStructuredInference({
      baseUrl,
      systemPrompt: 's',
      userPrompt: 'u',
      jsonSchema: AGENT_OUTPUT_JSON_SCHEMAS['PLANNER'] as Record<string, unknown>,
      schemaName: 'PLANNER',
      temperature: 0,
      timeoutMs: 5_000,
      maxOutputBytes: 1_048_576,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const validated = validateAgentOutput('PLANNER', result.text);
      expect(validated.ok).toBe(false);
    }
  }, 15_000);

  it('an unreachable endpoint is a transport failure, never an exception', async () => {
    const result = await localStructuredInference({
      baseUrl: 'http://127.0.0.1:9/v1',
      systemPrompt: 's',
      userPrompt: 'u',
      jsonSchema: {},
      schemaName: 'PLANNER',
      temperature: 0,
      timeoutMs: 1_500,
      maxOutputBytes: 1_024,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(['unreachable', 'timeout']).toContain(result.kind);
  });
});

describe('localModelDoctor', () => {
  it('reports a coherent, startable configuration', async () => {
    const report = await localModelDoctor(config());
    expect(report.startable).toBe(true);
    expect(report.binding).toBe('loopback-only');
    expect(report.executable.found).toBe(true);
    expect(report.model.found).toBe(true);
    expect(report.model.sizeBytes).toBeGreaterThan(0);
    expect(report.port).toBe('dynamic');
    expect(report.localOnly).toBe(true);
  });

  it('reports what is missing without spawning or inferring', async () => {
    const report = await localModelDoctor(
      config({ executable: 'C:/does/not/exist/llama-server.exe' }),
    );
    expect(report.startable).toBe(false);
    expect(report.executable.found).toBe(false);
  });

  it('a disabled default config is honestly not startable', async () => {
    const report = await localModelDoctor(localInferenceConfigSchema.parse({}));
    expect(report.enabled).toBe(false);
    expect(report.startable).toBe(false);
    expect(report.configProblems.length).toBeGreaterThan(0);
  });
});

describe('configuration safety', () => {
  it('reserved flags are rejected in extraArgs and executableArgs', () => {
    for (const field of ['extraArgs', 'executableArgs'] as const) {
      for (const flag of ['--host', '--host=0.0.0.0', '--port', '-m', '--api-key']) {
        expect(() =>
          localInferenceConfigSchema.parse({ [field]: [flag] }),
        ).toThrowError(/must not contain/);
      }
    }
  });

  it('null bytes are rejected in paths', () => {
    expect(() => localInferenceConfigSchema.parse({ executable: 'a\0b' })).toThrow();
  });
});


describe('the prompt ceiling that actually holds', () => {
  it('refuses more text than the context can hold, whatever the character limit says', () => {
    // The two settings are configured independently and their DEFAULTS
    // contradict each other: 48,000 characters is roughly 14,000 tokens and
    // the default context is 8,192. A packet between the two passed every
    // check SpecBridge made and was then refused by llama-server as a bare
    // HTTP 400.
    //
    // The vNext.10.1 dogfood lost a whole task to that. An oversize packet
    // caught HERE reports `context-exceeded` and escalates to the large
    // tier without failing anything; the same packet caught by the SERVER
    // rejected the work unit and burned its attempt budget.
    expect(
      effectiveLocalInputCharacters({ maximumInputCharacters: 48_000, contextSize: 8_192 }),
    ).toBeLessThan(48_000);
  });

  it('never loosens a limit the operator set deliberately', () => {
    // A generous context does not license more than the configured ceiling.
    expect(
      effectiveLocalInputCharacters({ maximumInputCharacters: 10_000, contextSize: 131_072 }),
    ).toBe(10_000);
  });

  it('leaves room for the answer, not just the question', () => {
    // A ceiling equal to the whole context would let a prompt fill it and
    // leave the model nowhere to reply.
    const ceiling = effectiveLocalInputCharacters({
      maximumInputCharacters: 2_000_000,
      contextSize: 8_192,
    });
    expect(ceiling).toBeLessThan(8_192 * 3);
  });
});
