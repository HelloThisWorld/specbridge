import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DeepSeekHarnessRunner,
  DSH_DECLARED_CAPABILITIES,
  DSH_SDK_TESTED_VERSION,
  checkOperationSupport,
  dshCapabilitySet,
} from '@specbridge/runners';
import type { DeepSeekHarnessProfileConfig } from '@specbridge/core';
import { deepseekHarnessProfileSchema } from '@specbridge/core';
import { FAKE_DSH_PATH } from '../helpers-execution.js';

/**
 * Process-level DeepSeek Harness adapter tests: every scenario drives the
 * REAL official SDK client (`@deepseek-ai/dsh-sdk-client`, exact-pinned)
 * against the fake DSH runtime speaking the real stdio JSON-RPC protocol —
 * never a mocked adapter method. Fully offline: no network, no model, no
 * credentials.
 */

const PASSTHROUGH = [
  'FAKE_DSH_SCENARIO',
  'FAKE_DSH_SESSIONS_DIR',
  'FAKE_DSH_EDIT_PATH',
  'FAKE_DSH_LOG',
];

function fakeDshConfig(
  overrides: Partial<DeepSeekHarnessProfileConfig> = {},
): DeepSeekHarnessProfileConfig {
  return deepseekHarnessProfileSchema.parse({
    runner: 'deepseek-harness',
    enabled: true,
    command: { executable: process.execPath, args: [FAKE_DSH_PATH] },
    provider: 'fake-provider',
    model: 'fake-model',
    workspaceBoundary: 'runtime-profile',
    environmentPassthrough: PASSTHROUGH,
    timeoutMs: 60_000,
    handshakeTimeoutMs: 15_000,
    ...overrides,
  });
}

function scratch(): { workspaceRoot: string; runDir: string } {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'specbridge-dsh-test-'));
  return { workspaceRoot, runDir: path.join(workspaceRoot, '.specbridge', 'runs', 'run-1') };
}

function withScenario(scenario: string | undefined): void {
  if (scenario === undefined) delete process.env['FAKE_DSH_SCENARIO'];
  else process.env['FAKE_DSH_SCENARIO'] = scenario;
}

function executionOptions(dirs: { workspaceRoot: string; runDir: string }, timeoutMs = 60_000) {
  return { workspaceRoot: dirs.workspaceRoot, runDir: dirs.runDir, timeoutMs };
}

const taskInput = (sessionId?: string) => ({
  specName: 'settings-persistence',
  taskId: '1',
  prompt: '# task prompt\n\nImplement task 1.\n',
  promptVersion: '1.1.0',
  toolPolicy: 'implementation' as const,
  ...(sessionId !== undefined ? { sessionId } : {}),
});

afterEach(() => {
  for (const name of PASSTHROUGH) delete process.env[name];
  delete process.env['FAKE_DSH_SECRET_PROBE'];
});

describe('deepseek-harness detection (read-only; no model turn)', () => {
  it('Test A: a configured compatible runtime detects as available without inference', async () => {
    withScenario('success');
    const dirs = scratch();
    const log = path.join(dirs.workspaceRoot, 'fake-dsh-log.jsonl');
    process.env['FAKE_DSH_LOG'] = log;
    const runner = new DeepSeekHarnessRunner(fakeDshConfig());
    const detection = await runner.detect({
      workspaceRoot: dirs.workspaceRoot,
      probeCapabilities: true,
    });
    expect(detection.status).toBe('available');
    expect(detection.version).toBe('0.1.1-rc.1-fake');
    expect(detection.category).toBe('agent-cli');
    // Preview: usable only through explicit selection, never automatically.
    expect(detection.supportLevel).toBe('preview');
    expect(detection.authentication).toBe('unknown');
    expect(detection.capabilitySet.taskExecution).toBe(true);
    expect(detection.capabilitySet.sandbox).toBe(true);
    expect(detection.capabilitySet.stageGeneration).toBe(false);
    const pin = detection.capabilities.find((capability) => capability.id === 'sdk-pin');
    expect(pin?.detail).toContain(DSH_SDK_TESTED_VERSION);
    // The probe performed initialize + shutdown ONLY — never session/prompt.
    const requests = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; method?: string })
      .filter((entry) => entry.event === 'request')
      .map((entry) => entry.method);
    expect(requests).toContain('initialize');
    expect(requests).not.toContain('session/prompt');
  });

  it('cheap detection (no probe) never spawns the runtime', async () => {
    withScenario('success');
    const dirs = scratch();
    const log = path.join(dirs.workspaceRoot, 'fake-dsh-log.jsonl');
    process.env['FAKE_DSH_LOG'] = log;
    const runner = new DeepSeekHarnessRunner(fakeDshConfig());
    const detection = await runner.detect({ workspaceRoot: dirs.workspaceRoot });
    expect(detection.status).toBe('available');
    expect(detection.version).toBeUndefined();
    expect(existsSync(log)).toBe(false);
  });

  it('reports a missing runtime command as unavailable', async () => {
    const runner = new DeepSeekHarnessRunner(
      fakeDshConfig({ command: { executable: 'specbridge-no-such-dsh-runtime', args: [] } }),
    );
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    expect(detection.status).toBe('unavailable');
    expect(detection.supportLevel).toBe('unavailable');
    expect(detection.diagnostics.some((d) => d.code === 'RUNNER_EXECUTABLE_NOT_FOUND')).toBe(true);
  });

  it('Test B: the profile is disabled by default and refuses to run', async () => {
    const defaulted = deepseekHarnessProfileSchema.parse({ runner: 'deepseek-harness' });
    expect(defaulted.enabled).toBe(false);
    expect(defaulted.workspaceBoundary).toBe('unconfirmed');
    expect(defaulted.sessionPersistence).toBe('none');

    const runner = new DeepSeekHarnessRunner(fakeDshConfig({ enabled: false }));
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    expect(detection.status).toBe('misconfigured');
    expect(detection.diagnostics.some((d) => d.code === 'RUNNER_DISABLED')).toBe(true);

    const dirs = scratch();
    const result = await runner.executeTask(taskInput(), executionOptions(dirs));
    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('runner_disabled');
  });

  it('an incompatible runtime identity is refused (wrong serverInfo.name)', async () => {
    withScenario('wrong-identity');
    const dirs = scratch();
    const runner = new DeepSeekHarnessRunner(fakeDshConfig());
    const detection = await runner.detect({
      workspaceRoot: dirs.workspaceRoot,
      probeCapabilities: true,
    });
    expect(detection.status).toBe('incompatible');
    expect(detection.supportLevel).toBe('incompatible');

    const execute = await new DeepSeekHarnessRunner(fakeDshConfig()).executeTask(
      taskInput(),
      executionOptions(scratch()),
    );
    expect(execute.outcome).toBe('failed');
    expect(execute.error?.code).toBe('runner_incompatible');
  });

  it('Test N: an unconfirmed workspace boundary fails closed before any spawn', async () => {
    withScenario('success');
    const dirs = scratch();
    const log = path.join(dirs.workspaceRoot, 'fake-dsh-log.jsonl');
    process.env['FAKE_DSH_LOG'] = log;
    const config = fakeDshConfig({ workspaceBoundary: 'unconfirmed' });
    const runner = new DeepSeekHarnessRunner(config);
    // The capability set downgrades, so selection refuses the operation…
    expect(dshCapabilitySet(config).sandbox).toBe(false);
    expect(checkOperationSupport('task-execution', runner.declaredCapabilities).supported).toBe(false);
    // …and the runner itself fails closed even if selection were bypassed.
    const result = await runner.executeTask(taskInput(), executionOptions(dirs));
    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('sandbox_unavailable');
    expect(existsSync(log)).toBe(false);
  });

  it('an incomplete profile (provider/model) is invalid configuration', async () => {
    const runner = new DeepSeekHarnessRunner(fakeDshConfig({ model: null }));
    const result = await runner.executeTask(taskInput(), executionOptions(scratch()));
    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('invalid_configuration');
  });

  it('stage generation is refused before any model invocation', async () => {
    withScenario('success');
    const dirs = scratch();
    const log = path.join(dirs.workspaceRoot, 'fake-dsh-log.jsonl');
    process.env['FAKE_DSH_LOG'] = log;
    const runner = new DeepSeekHarnessRunner(fakeDshConfig());
    const result = await runner.generateStage(
      {
        specName: 's',
        stage: 'requirements',
        intent: 'generate',
        prompt: 'p',
        promptVersion: '1',
        toolPolicy: 'read-only',
      },
      executionOptions(dirs),
    );
    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('unsupported_operation');
    expect(existsSync(log)).toBe(false);
    expect(DSH_DECLARED_CAPABILITIES.stageGeneration).toBe(false);
  });
});

describe('deepseek-harness task execution (real SDK client against the fake runtime)', () => {
  it('Test C (runner level): executes a task, edits the workspace, returns a validated claim', async () => {
    withScenario('success');
    const dirs = scratch();
    const runner = new DeepSeekHarnessRunner(fakeDshConfig());
    const result = await runner.executeTask(taskInput('sess-exec-1'), executionOptions(dirs));
    expect(result.outcome).toBe('completed');
    expect(result.report?.outcome).toBe('completed');
    expect(result.sessionId).toBe('sess-exec-1');
    // The agent actually edited the fixture workspace…
    expect(readFileSync(path.join(dirs.workspaceRoot, 'src', 'fake-dsh-change.txt'), 'utf8')).toContain(
      'fake dsh implementation',
    );
    // …and the report stays a CLAIM (evidence is decided by orchestration).
    expect(result.report?.changedFiles).toContain('src/fake-dsh-change.txt');
    // No session persistence attested ⇒ resume is not offered.
    expect(result.resumeSupported).toBe(false);
    // Usage is provider-reported, never guessed.
    expect(result.usage?.inputTokens).toBe(1200);
    expect(result.usage?.outputTokens).toBe(180);
    expect(result.usage?.cachedInputTokens).toBe(300);
    expect(result.usage?.model).toBe('fake-model');
    // Normalized events cover the §25 lifecycle categories.
    const types = (result.normalizedEvents ?? []).map((event) => event.type);
    expect(types).toContain('runner.started');
    expect(types).toContain('session.started');
    expect(types).toContain('turn.started');
    expect(types).toContain('tool.started');
    expect(types).toContain('command.started');
    expect(types).toContain('command.completed');
    expect(types).toContain('message.completed');
    expect(types).toContain('usage.updated');
    expect(types).toContain('turn.completed');
    const launch = (result.normalizedEvents ?? []).find((event) => event.type === 'runner.started');
    expect(launch?.payload['runtimeVersion']).toBe('0.1.1-rc.1-fake');
    expect(launch?.payload['sdkVersion']).toBe(DSH_SDK_TESTED_VERSION);
  });

  it('Test D (runner level): a false completion claim is still returned as a claim only', async () => {
    withScenario('false-claim');
    const dirs = scratch();
    const runner = new DeepSeekHarnessRunner(fakeDshConfig());
    const result = await runner.executeTask(taskInput(), executionOptions(dirs));
    // The RUNNER reports what the agent claimed…
    expect(result.outcome).toBe('completed');
    expect(result.report?.changedFiles).toContain('src/fake-dsh-change.txt');
    // …but the repository was untouched — the evidence pipeline (exercised
    // in the execution-level suite) is what refuses completion.
    expect(existsSync(path.join(dirs.workspaceRoot, 'src', 'fake-dsh-change.txt'))).toBe(false);
  });

  it('strict structured output: malformed JSON is never repaired', async () => {
    withScenario('malformed-result');
    const runner = new DeepSeekHarnessRunner(fakeDshConfig());
    const result = await runner.executeTask(taskInput(), executionOptions(scratch()));
    expect(result.outcome).toBe('malformed-output');
    expect(result.error?.code).toBe('structured_output_invalid');
    expect(result.report).toBeUndefined();
  });

  it('strict structured output: JSON is never extracted from surrounding prose', async () => {
    withScenario('prose-wrapped');
    const runner = new DeepSeekHarnessRunner(fakeDshConfig());
    const result = await runner.executeTask(taskInput(), executionOptions(scratch()));
    expect(result.outcome).toBe('malformed-output');
    expect(result.error?.code).toBe('structured_output_invalid');
  });

  it('Test K: reasoning content is never persisted anywhere in the result', async () => {
    withScenario('reasoning');
    const dirs = scratch();
    const runner = new DeepSeekHarnessRunner(fakeDshConfig());
    const result = await runner.executeTask(taskInput(), executionOptions(dirs));
    expect(result.outcome).toBe('completed');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('SECRET-REASONING');
    // Only safe status metadata about reasoning survives.
    const message = (result.normalizedEvents ?? []).find(
      (event) => event.type === 'message.completed' && event.payload['reasoningRedacted'] === true,
    );
    expect(message).toBeDefined();
    expect(typeof message?.payload['reasoningChars']).toBe('number');
    // The retained raw notification log keeps the redaction marker instead.
    expect(result.rawStdout).toContain('[redacted reasoning:');
  });

  it('Test I (runner level): native compaction is observed, never canonical', async () => {
    withScenario('compaction');
    const runner = new DeepSeekHarnessRunner(fakeDshConfig());
    const result = await runner.executeTask(taskInput(), executionOptions(scratch()));
    expect(result.outcome).toBe('completed');
    const compaction = (result.normalizedEvents ?? []).filter(
      (event) => event.type === 'compaction.occurred',
    );
    expect(compaction.length).toBeGreaterThan(0);
    expect(compaction[0]?.providerEventType).toBe('session.event:compaction/end');
  });

  it('normalizes attempt-internal subagents as bounded tool activity', async () => {
    withScenario('subagent');
    const runner = new DeepSeekHarnessRunner(fakeDshConfig());
    const result = await runner.executeTask(taskInput(), executionOptions(scratch()));
    expect(result.outcome).toBe('completed');
    const types = (result.normalizedEvents ?? []).map((event) => `${event.type}:${event.providerEventType ?? ''}`);
    expect(types).toContain('tool.started:subagent.started');
    expect(types).toContain('tool.completed:subagent.finished');
  });

  it('Test M: an unresponsive runtime is bounded by the timeout and reaped', async () => {
    withScenario('hang');
    const dirs = scratch();
    const runner = new DeepSeekHarnessRunner(fakeDshConfig());
    const started = Date.now();
    const result = await runner.executeTask(taskInput(), executionOptions(dirs, 2_000));
    expect(result.outcome).toBe('timed-out');
    expect(result.error?.code).toBe('timed_out');
    expect(result.process?.timedOut).toBe(true);
    // Bounded: the SDK teardown ladder finishes promptly for a cooperative
    // child (well under the ladder's worst-case grace windows).
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 45_000);

  it('Test L: cancellation stops the run, cleans up, and is classified as cancelled', async () => {
    withScenario('hang');
    const dirs = scratch();
    const runner = new DeepSeekHarnessRunner(fakeDshConfig());
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await runner.executeTask(taskInput(), {
      ...executionOptions(dirs),
      signal: controller.signal,
    });
    expect(result.outcome).toBe('cancelled');
    expect(result.error?.code).toBe('cancelled');
    expect(result.error?.retryable).toBe(false);
    expect(result.process?.cancelled).toBe(true);
  }, 45_000);

  it('an already-aborted signal cancels before the runtime is even launched', async () => {
    withScenario('success');
    const dirs = scratch();
    const log = path.join(dirs.workspaceRoot, 'fake-dsh-log.jsonl');
    process.env['FAKE_DSH_LOG'] = log;
    const controller = new AbortController();
    controller.abort();
    const runner = new DeepSeekHarnessRunner(fakeDshConfig());
    const result = await runner.executeTask(taskInput(), {
      ...executionOptions(dirs),
      signal: controller.signal,
    });
    expect(result.outcome).toBe('cancelled');
    expect(existsSync(log)).toBe(false);
  });

  it('cleanup stays bounded even when the runtime ignores the cooperative quiesce', async () => {
    withScenario('no-exit');
    const dirs = scratch();
    const runner = new DeepSeekHarnessRunner(fakeDshConfig());
    const started = Date.now();
    const result = await runner.executeTask(taskInput(), executionOptions(dirs, 1_500));
    expect(result.outcome).toBe('timed-out');
    // shutdown bound (1s) + EOF grace (6s) + termination window (3s) — the
    // ladder must land well inside its documented worst case.
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it('Test G (runner level): a runtime crash mid-attempt is a normalized worker failure', async () => {
    withScenario('crash-mid-run');
    const dirs = scratch();
    const runner = new DeepSeekHarnessRunner(fakeDshConfig());
    const result = await runner.executeTask(taskInput(), executionOptions(dirs));
    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('process_failed');
    // Events observed before the crash are preserved for diagnostics.
    const types = (result.normalizedEvents ?? []).map((event) => event.type);
    expect(types).toContain('tool.started');
    expect(result.resumeSupported).toBe(false);
  });

  it('classifies provider auth and rate-limit errors from the runtime', async () => {
    withScenario('rpc-auth-error');
    const auth = await new DeepSeekHarnessRunner(fakeDshConfig()).executeTask(
      taskInput(),
      executionOptions(scratch()),
    );
    expect(auth.error?.code).toBe('authentication_required');
    expect(auth.error?.providerCode).toBe('-32001');

    withScenario('rpc-rate-limit');
    const rate = await new DeepSeekHarnessRunner(fakeDshConfig()).executeTask(
      taskInput(),
      executionOptions(scratch()),
    );
    expect(rate.error?.code).toBe('rate_limited');
  });

  it('the child environment is allowlist-built: parent secrets never leak', async () => {
    withScenario('success');
    const dirs = scratch();
    const log = path.join(dirs.workspaceRoot, 'fake-dsh-log.jsonl');
    process.env['FAKE_DSH_LOG'] = log;
    process.env['FAKE_DSH_SECRET_PROBE'] = 'never-inherited';
    const runner = new DeepSeekHarnessRunner(fakeDshConfig());
    const result = await runner.executeTask(taskInput(), executionOptions(dirs));
    expect(result.outcome).toBe('completed');
    const spawn = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; envNames?: string[] })
      .find((entry) => entry.event === 'spawn');
    expect(spawn?.envNames).toContain('FAKE_DSH_SCENARIO');
    // Not in the allowlist ⇒ not in the child environment.
    expect(spawn?.envNames).not.toContain('FAKE_DSH_SECRET_PROBE');
  });

  it('a CLI model override reaches the initialize handshake', async () => {
    withScenario('success');
    const dirs = scratch();
    const log = path.join(dirs.workspaceRoot, 'fake-dsh-log.jsonl');
    process.env['FAKE_DSH_LOG'] = log;
    const runner = new DeepSeekHarnessRunner(fakeDshConfig());
    await runner.executeTask(taskInput(), { ...executionOptions(dirs), model: 'override-model' });
    const initialize = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; method?: string; params?: { model?: string } })
      .find((entry) => entry.event === 'request' && entry.method === 'initialize');
    expect(initialize?.params?.model).toBe('override-model');
  });
});

describe('deepseek-harness session resume (fast path + continuity verification)', () => {
  it('resume is refused when the profile attests no session persistence', async () => {
    const runner = new DeepSeekHarnessRunner(fakeDshConfig());
    const result = await runner.resumeTask(
      { ...taskInput('sess-r0'), sessionId: 'sess-r0' },
      executionOptions(scratch()),
    );
    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('unsupported_operation');
    expect(result.resumeSupported).toBe(false);
  });

  it('Test E (runner level): a valid persisted session resumes and continues', async () => {
    withScenario('resume');
    const dirs = scratch();
    const sessions = path.join(dirs.workspaceRoot, '.dsh-sessions');
    process.env['FAKE_DSH_SESSIONS_DIR'] = sessions;
    const config = fakeDshConfig({ sessionPersistence: 'runtime-managed' });

    const first = await new DeepSeekHarnessRunner(config).executeTask(
      taskInput('sess-resume-1'),
      executionOptions(dirs),
    );
    expect(first.outcome).toBe('completed');
    expect(first.resumeSupported).toBe(true);
    expect(first.sessionId).toBe('sess-resume-1');

    const resumed = await new DeepSeekHarnessRunner(config).resumeTask(
      { ...taskInput(), sessionId: 'sess-resume-1' },
      executionOptions(dirs),
    );
    expect(resumed.outcome).toBe('completed');
    expect(resumed.report?.summary).toContain('restored session');
    const content = readFileSync(path.join(dirs.workspaceRoot, 'src', 'fake-dsh-change.txt'), 'utf8');
    expect(content).toContain('fake dsh implementation\n');
    expect(content).toContain('(resumed)');
  });

  it('Test F (runner level): a lost session is detected by seq continuity and fails as session_unavailable', async () => {
    withScenario('resume');
    const dirs = scratch();
    const sessions = path.join(dirs.workspaceRoot, '.dsh-sessions');
    process.env['FAKE_DSH_SESSIONS_DIR'] = sessions;
    const config = fakeDshConfig({ sessionPersistence: 'runtime-managed' });

    const first = await new DeepSeekHarnessRunner(config).executeTask(
      taskInput('sess-lost-1'),
      executionOptions(dirs),
    );
    expect(first.outcome).toBe('completed');
    const editedOnce = readFileSync(path.join(dirs.workspaceRoot, 'src', 'fake-dsh-change.txt'), 'utf8');

    // Delete ALL runtime session state: the next "resume" silently restores
    // nothing — the runtime would start an EMPTY session under the old id.
    rmSync(sessions, { recursive: true, force: true });

    const resumed = await new DeepSeekHarnessRunner(config).resumeTask(
      { ...taskInput(), sessionId: 'sess-lost-1' },
      executionOptions(dirs),
    );
    expect(resumed.outcome).toBe('failed');
    expect(resumed.error?.code).toBe('session_unavailable');
    expect(resumed.error?.retryable).toBe(false);
    expect(resumed.resumeSupported).toBe(false);
    // The run was stopped before any agentic work happened on wrong context.
    expect(readFileSync(path.join(dirs.workspaceRoot, 'src', 'fake-dsh-change.txt'), 'utf8')).toBe(
      editedOnce,
    );
  }, 30_000);
});
