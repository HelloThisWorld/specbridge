import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexCliRunner, buildCodexInvocation, probeCodex, parseCodexEventStream, normalizeCodexEvents } from '@specbridge/runners';
import type { CodexProfileConfig } from '@specbridge/core';
import { STAGE_RUNNER_REPORT_JSON_SCHEMA, codexProfileSchema } from '@specbridge/core';
import { FAKE_CODEX_PATH } from '../helpers-execution.js';

/**
 * Process-level Codex adapter tests: every scenario spawns the REAL fake
 * Codex CLI as a child process (never a mocked adapter method). Fully
 * offline: no network, no model, no credentials.
 */

function fakeCodexConfig(overrides: Partial<CodexProfileConfig> = {}): CodexProfileConfig {
  return codexProfileSchema.parse({
    runner: 'codex-cli',
    enabled: true,
    command: { executable: process.execPath, args: [FAKE_CODEX_PATH] },
    timeoutMs: 30_000,
    ...overrides,
  });
}

function scratchDirs(): { workspaceRoot: string; runDir: string } {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'specbridge-codex-test-'));
  return { workspaceRoot, runDir: path.join(workspaceRoot, '.specbridge', 'runs', 'run-1') };
}

function withScenario(scenario: string | undefined): void {
  if (scenario === undefined) delete process.env['FAKE_CODEX_SCENARIO'];
  else process.env['FAKE_CODEX_SCENARIO'] = scenario;
}

afterEach(() => {
  delete process.env['FAKE_CODEX_SCENARIO'];
  delete process.env['FAKE_CODEX_LOG'];
});

const generationInput = {
  specName: 'settings-persistence',
  stage: 'requirements' as const,
  intent: 'generate' as const,
  prompt: '# prompt\n\nStage to produce: requirements\n',
  promptVersion: '1.1.0',
  toolPolicy: 'read-only' as const,
};

describe('codex detection (read-only probes; no model request)', () => {
  it('detects the executable, version, and full capabilities', async () => {
    withScenario('success');
    const runner = new CodexCliRunner(fakeCodexConfig());
    const detection = await runner.detect({ workspaceRoot: process.cwd(), probeCapabilities: true });
    expect(detection.status).toBe('available');
    expect(detection.version).toContain('9.9.9');
    expect(detection.category).toBe('agent-cli');
    expect(detection.supportLevel).toBe('production');
    expect(detection.capabilitySet.taskExecution).toBe(true);
    expect(detection.capabilitySet.taskResume).toBe(true);
    expect(detection.capabilitySet.supportsJsonSchema).toBe(true);
    expect(detection.capabilitySet.sandbox).toBe(true);
    // Auth was probed via `login status` and its output is summarized, never
    // echoed (it contains a fake secret).
    expect(detection.authentication).toBe('authenticated');
    expect(JSON.stringify(detection)).not.toContain('FAKE-CODEX-SECRET');
  });

  it('reports a missing executable as unavailable', async () => {
    const runner = new CodexCliRunner(
      fakeCodexConfig({ command: { executable: 'specbridge-no-such-codex-xyz', args: [] } }),
    );
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    expect(detection.status).toBe('unavailable');
    expect(detection.supportLevel).toBe('unavailable');
    expect(detection.diagnostics.some((d) => d.code === 'RUNNER_EXECUTABLE_NOT_FOUND')).toBe(true);
  });

  it('classifies an unauthenticated CLI without reading credential files', async () => {
    withScenario('unauthenticated');
    const runner = new CodexCliRunner(fakeCodexConfig());
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    expect(detection.status).toBe('unauthenticated');
    expect(detection.authentication).toBe('unauthenticated');
  });

  it('reports authentication as unknown when no safe status command exists', async () => {
    withScenario('no-login-command');
    const runner = new CodexCliRunner(fakeCodexConfig());
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    expect(detection.authentication).toBe('unknown');
    expect(detection.status).toBe('available');
  });

  it('an incompatible version (no --json) is marked incompatible with the exact capability', async () => {
    withScenario('incompatible-version');
    const runner = new CodexCliRunner(fakeCodexConfig());
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    expect(detection.status).toBe('incompatible');
    expect(detection.supportLevel).toBe('incompatible');
    expect(detection.diagnostics.map((d) => d.message).join(' ')).toContain('Machine-readable event output');
  });

  it('a version without workspace-write keeps authoring but drops task execution', async () => {
    withScenario('no-workspace-write');
    const runner = new CodexCliRunner(fakeCodexConfig());
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    expect(detection.status).toBe('available');
    expect(detection.capabilitySet.stageGeneration).toBe(true);
    expect(detection.capabilitySet.taskExecution).toBe(false);
    expect(detection.capabilitySet.taskResume).toBe(false);
  });

  it('doctor-level detection never runs exec (no model request)', async () => {
    withScenario('success');
    const log = path.join(mkdtempSync(path.join(os.tmpdir(), 'specbridge-codex-log-')), 'invocations.jsonl');
    process.env['FAKE_CODEX_LOG'] = log;
    const runner = new CodexCliRunner(fakeCodexConfig());
    await runner.detect({ workspaceRoot: process.cwd(), probeCapabilities: true });
    // The exec log records only real exec runs (probes never reach it).
    expect(existsSync(log)).toBe(false);
  });

  it('model listing is honestly unsupported (no guessing)', async () => {
    const runner = new CodexCliRunner(fakeCodexConfig());
    const models = await runner.listModels({ workspaceRoot: process.cwd() });
    expect(models.supported).toBe(false);
    expect(models.models).toEqual([]);
  });
});

describe('codex invocation safety', () => {
  it('argv is an array, prompts travel via stdin, temp schema files are used', async () => {
    withScenario('success');
    const config = fakeCodexConfig();
    const probe = await probeCodex(config);
    const { workspaceRoot, runDir } = scratchDirs();
    const plan = buildCodexInvocation({
      config,
      probe,
      prompt: 'Stage to produce: requirements',
      toolPolicy: 'read-only',
      outputJsonSchema: STAGE_RUNNER_REPORT_JSON_SCHEMA,
      execution: { workspaceRoot, runDir, timeoutMs: 10_000 },
    });
    expect(Array.isArray(plan.argv)).toBe(true);
    expect(plan.argv[plan.argv.length - 1]).toBe('-');
    expect(plan.stdin).toContain('Stage to produce');
    // The prompt is NOT in the argv (process-list safety).
    expect(plan.argv.join(' ')).not.toContain('Stage to produce');
    expect(plan.sandbox).toBe('read-only');
    expect(plan.argv).toContain('--output-schema');
  });

  it('unrestricted modes are rejected pre-spawn, whatever the source', async () => {
    withScenario('success');
    const config = fakeCodexConfig();
    const probe = await probeCodex(config);
    const { workspaceRoot, runDir } = scratchDirs();
    const plan = buildCodexInvocation({
      config,
      probe,
      prompt: 'x',
      toolPolicy: 'implementation',
      outputJsonSchema: STAGE_RUNNER_REPORT_JSON_SCHEMA,
      execution: { workspaceRoot, runDir, timeoutMs: 10_000 },
      materializeTempFiles: false,
    });
    expect(plan.argv).toContain('workspace-write');
    expect(plan.argv.join(' ')).not.toContain('danger-full-access');
    expect(plan.argv.join(' ')).not.toContain('--yolo');
    expect(plan.argv.join(' ')).not.toContain('--skip-git-repo-check');
    const { assertNoForbiddenCodexArguments } = await import('@specbridge/runners');
    expect(() => assertNoForbiddenCodexArguments(['exec', '--sandbox', 'danger-full-access'])).toThrow(
      /never used|Refusing/,
    );
    expect(() =>
      assertNoForbiddenCodexArguments(['exec', '--dangerously-bypass-approvals-and-sandbox']),
    ).toThrow(/Refusing/);
  });

  it('the sandbox config can narrow to read-only but never broaden', async () => {
    withScenario('success');
    const config = fakeCodexConfig({ sandbox: 'read-only' });
    const probe = await probeCodex(config);
    const { workspaceRoot, runDir } = scratchDirs();
    const plan = buildCodexInvocation({
      config,
      probe,
      prompt: 'x',
      toolPolicy: 'implementation',
      outputJsonSchema: STAGE_RUNNER_REPORT_JSON_SCHEMA,
      execution: { workspaceRoot, runDir, timeoutMs: 10_000 },
      materializeTempFiles: false,
    });
    expect(plan.sandbox).toBe('read-only');
  });
});

describe('codex authoring (read-only boundary)', () => {
  it('generates a stage with a validated structured result and session id', async () => {
    withScenario('success');
    const log = path.join(mkdtempSync(path.join(os.tmpdir(), 'specbridge-codex-log-')), 'invocations.jsonl');
    process.env['FAKE_CODEX_LOG'] = log;
    const runner = new CodexCliRunner(fakeCodexConfig());
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, {
      workspaceRoot,
      runDir,
      timeoutMs: 30_000,
    });
    expect(result.outcome).toBe('completed');
    expect(result.report?.stage).toBe('requirements');
    expect(result.report?.markdown).toContain('# Requirements Document');
    expect(result.sessionId).toBe('fake-thread-0001');
    expect(result.usage?.inputTokens).toBe(1200);
    expect(result.usage?.outputTokens).toBe(250);
    // The invocation used the read-only sandbox and stdin.
    const logged = JSON.parse(readFileSync(log, 'utf8').trim()) as {
      sandbox: string;
      stdinBytes: number;
      outputSchemaExists: boolean;
    };
    expect(logged.sandbox).toBe('read-only');
    expect(logged.stdinBytes).toBeGreaterThan(0);
    expect(logged.outputSchemaExists).toBe(true);
    // Temp files (schema + last message) are cleaned up.
    const tmpDir = path.join(runDir, 'tmp');
    if (existsSync(tmpDir)) {
      expect(readdirSync(tmpDir)).toEqual([]);
    }
    // The workspace was not modified by authoring.
    expect(existsSync(path.join(workspaceRoot, 'rogue-authoring-write.txt'))).toBe(false);
  });

  it('normalizes machine-readable events and redacts reasoning content everywhere', async () => {
    withScenario('success');
    const runner = new CodexCliRunner(fakeCodexConfig());
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, {
      workspaceRoot,
      runDir,
      timeoutMs: 30_000,
    });
    const events = result.normalizedEvents ?? [];
    expect(events.some((event) => event.type === 'session.started')).toBe(true);
    expect(events.some((event) => event.type === 'turn.started')).toBe(true);
    expect(events.some((event) => event.type === 'usage.updated')).toBe(true);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('REASONING-SECRET-DO-NOT-EXPOSE');
    const reasoning = events.find(
      (event) => event.providerEventType === 'item.completed:reasoning',
    );
    expect(reasoning?.payload['redacted']).toBe(true);
    // Reasoning content never survives into the RETAINED raw stream either —
    // only a length marker does (the non-reasoning events stay intact).
    expect(result.rawStdout).not.toContain('REASONING-SECRET-DO-NOT-EXPOSE');
    expect(result.rawStdout).toContain('[redacted reasoning:');
    expect(result.rawStdout).toContain('thread.started');
  });

  it('malformed final output fails safely', async () => {
    withScenario('malformed');
    const runner = new CodexCliRunner(fakeCodexConfig());
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('malformed-output');
    expect(result.report).toBeUndefined();
    expect(result.error?.code).toBe('structured_output_invalid');
  });

  it('extra prose around JSON is not accepted as structured output', async () => {
    withScenario('extra-prose');
    const runner = new CodexCliRunner(fakeCodexConfig());
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('malformed-output');
    expect(result.failureReason).toContain('extra prose is not accepted');
  });

  it('a missing final result fails safely', async () => {
    withScenario('missing-final');
    const runner = new CodexCliRunner(fakeCodexConfig());
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('malformed-output');
    expect(result.error?.code).toBe('structured_output_invalid');
  });
});

describe('codex failure classification', () => {
  const run = async (scenario: string) => {
    withScenario(scenario);
    const runner = new CodexCliRunner(fakeCodexConfig());
    const { workspaceRoot, runDir } = scratchDirs();
    return runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
  };

  it('nonzero exit is classified as process_failed', async () => {
    const result = await run('nonzero-exit');
    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('process_failed');
  });

  it('authentication errors are classified', async () => {
    const result = await run('auth-error');
    expect(result.error?.code).toBe('authentication_required');
    expect(result.error?.retryable).toBe(false);
  });

  it('permission denials are classified', async () => {
    const result = await run('permission-denied');
    expect(result.outcome).toBe('permission-denied');
    expect(result.error?.code).toBe('permission_denied');
  });

  it('sandbox unavailability is classified', async () => {
    const result = await run('sandbox-unavailable');
    expect(result.error?.code).toBe('sandbox_unavailable');
  });

  it('quota exhaustion is classified', async () => {
    const result = await run('quota-exceeded');
    expect(result.error?.code).toBe('quota_exceeded');
    expect(result.error?.retryable).toBe(false);
  });

  it('rate limits are classified', async () => {
    const result = await run('rate-limit');
    expect(result.error?.code).toBe('rate_limited');
  });

  it('a timeout kills the Codex process deterministically', async () => {
    withScenario('exec-timeout');
    const runner = new CodexCliRunner(fakeCodexConfig({ timeoutMs: 2_000 }));
    const { workspaceRoot, runDir } = scratchDirs();
    const started = Date.now();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 2_000 });
    expect(result.outcome).toBe('timed-out');
    expect(result.error?.code).toBe('timed_out');
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.process?.timedOut).toBe(true);
  });

  it('cancellation kills the Codex process deterministically', async () => {
    withScenario('exec-timeout');
    const runner = new CodexCliRunner(fakeCodexConfig());
    const { workspaceRoot, runDir } = scratchDirs();
    const controller = new AbortController();
    const pending = runner.generateStage(generationInput, {
      workspaceRoot,
      runDir,
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    const result = await pending;
    expect(result.outcome).toBe('cancelled');
    expect(result.error?.code).toBe('cancelled');
    expect(result.process?.cancelled).toBe(true);
  });

  it('the stdout limit terminates and never parses truncated output', async () => {
    withScenario('huge-stdout');
    const runner = new CodexCliRunner(fakeCodexConfig({ maxStdoutBytes: 128 * 1024 }));
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('output_limit_exceeded');
    expect(result.report).toBeUndefined();
  });

  it('the stderr limit terminates safely too', async () => {
    withScenario('huge-stderr');
    const runner = new CodexCliRunner(fakeCodexConfig({ maxStderrBytes: 64 * 1024 }));
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('output_limit_exceeded');
  });
});

describe('codex event stream parsing', () => {
  it('parses and normalizes the documented JSONL shapes', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 't-1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls', status: 'in_progress' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls', exit_code: 0, status: 'completed' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'f1', type: 'file_change', status: 'completed', changes: [{ path: 'src/a.ts', kind: 'update' }] } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: '{"ok":true}' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 } }),
      'not json at all',
    ].join('\n');
    const stream = parseCodexEventStream(stdout);
    expect(stream.threadId).toBe('t-1');
    expect(stream.lastAgentMessage).toBe('{"ok":true}');
    expect(stream.usage?.inputTokens).toBe(10);
    expect(stream.unparseableLines).toBe(0); // plain prose lines are ignored, not counted
    const normalized = normalizeCodexEvents(
      stream,
      { runner: 'codex-cli', profile: 'codex-default', runId: 'r', attemptId: 'a' },
      () => '2026-01-01T00:00:00.000Z',
    );
    expect(normalized.map((event) => event.type)).toEqual([
      'session.started',
      'turn.started',
      'command.started',
      'command.completed',
      'file.changed',
      'message.completed',
      'turn.completed',
      'usage.updated',
    ]);
    const command = normalized.find((event) => event.type === 'command.completed');
    expect(command?.payload['exitCode']).toBe(0);
    expect(command?.providerSessionId).toBe('t-1');
  });
});
