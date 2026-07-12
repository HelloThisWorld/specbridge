import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeRunnerConfigSchema } from '@specbridge/core';
import type { RunnerExecutionOptions } from '@specbridge/runners';
import {
  ClaudeCodeRunner,
  assertNoForbiddenArguments,
  buildClaudeInvocation,
  parseClaudeEnvelope,
  probeClaude,
  runSafeProcess,
} from '@specbridge/runners';
import { FAKE_CLAUDE_PATH } from '../helpers-execution.js';

/**
 * Process-level integration against the fake Claude CLI (a local node
 * script). No real Claude installation, no network — exactly what CI runs.
 */

function fakeConfig(overrides: Record<string, unknown> = {}) {
  return claudeRunnerConfigSchema.parse({
    command: process.execPath,
    commandArgs: [FAKE_CLAUDE_PATH],
    timeoutMs: 30_000,
    ...overrides,
  });
}

function execOptions(overrides: Partial<RunnerExecutionOptions> = {}): RunnerExecutionOptions {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'specbridge-claude-test-'));
  return { workspaceRoot: dir, runDir: path.join(dir, 'run'), timeoutMs: 30_000, ...overrides };
}

const savedScenario = process.env['FAKE_CLAUDE_SCENARIO'];
afterEach(() => {
  if (savedScenario === undefined) delete process.env['FAKE_CLAUDE_SCENARIO'];
  else process.env['FAKE_CLAUDE_SCENARIO'] = savedScenario;
  delete process.env['FAKE_CLAUDE_LOG'];
});

function scenario(name: string): void {
  process.env['FAKE_CLAUDE_SCENARIO'] = name;
}

const TASK_INPUT = {
  specName: 'settings-persistence',
  taskId: '1',
  prompt: 'contract...\n>>> IMPLEMENT THIS TASK ONLY: 1. Implement the settings store <<<\n',
  promptVersion: '1.0.0',
  toolPolicy: 'implementation' as const,
  sessionId: '11111111-2222-3333-4444-555555555555',
};

describe('detection against the fake CLI', () => {
  it('finds the executable, version, authentication, and capabilities', async () => {
    scenario('success');
    const probe = await probeClaude(fakeConfig());
    expect(probe.found).toBe(true);
    expect(probe.version).toContain('9.9.9');
    expect(probe.authState).toBe('authenticated');
    expect(probe.status).toBe('available');
    expect(probe.capabilities.find((c) => c.id === 'structured-output')?.available).toBe(true);
    expect(probe.capabilities.find((c) => c.id === 'resume')?.available).toBe(true);
  });

  it('reports unauthenticated with actionable guidance and NO credential output', async () => {
    scenario('unauthenticated');
    const probe = await probeClaude(fakeConfig());
    expect(probe.status).toBe('unauthenticated');
    const messages = probe.diagnostics.map((d) => d.message).join(' ');
    expect(messages).toContain('claude auth login');
  });

  it('never echoes auth-status output (secret redaction)', async () => {
    scenario('success');
    const probe = await probeClaude(fakeConfig());
    const serialized = JSON.stringify(probe);
    // The fake CLI prints "oauth-FAKE-SECRET-VALUE-12345" on auth status.
    expect(serialized).not.toContain('FAKE-SECRET-VALUE');
  });

  it('handles a version-probe timeout as a diagnostic, not a hang', async () => {
    scenario('version-timeout');
    const probe = await probeClaude(fakeConfig(), { timeoutMs: 1500 });
    expect(probe.status).toBe('error');
    expect(probe.diagnostics.some((d) => d.code === 'RUNNER_VERSION_TIMEOUT')).toBe(true);
  }, 20_000);

  it('a missing required capability marks the runner incompatible', async () => {
    scenario('missing-required-capability');
    const probe = await probeClaude(fakeConfig());
    expect(probe.status).toBe('incompatible');
    expect(probe.diagnostics.map((d) => d.message).join(' ')).toContain('Tool restrictions');
  });

  it('a missing optional capability degrades with a warning', async () => {
    scenario('no-structured-output');
    const probe = await probeClaude(fakeConfig());
    expect(probe.status).toBe('available');
    expect(probe.capabilities.find((c) => c.id === 'structured-output')?.available).toBe(false);
    expect(probe.diagnostics.some((d) => d.code === 'RUNNER_DEGRADED_CAPABILITY')).toBe(true);
  });
});

describe('argument vector construction', () => {
  it('builds a pure argv array with no shell concatenation and no bypass flags', async () => {
    scenario('success');
    const config = fakeConfig({ model: 'claude-sonnet-5', maxBudgetUsd: 3 });
    const probe = await probeClaude(config);
    const plan = buildClaudeInvocation({
      config,
      probe,
      prompt: 'prompt text',
      toolPolicy: 'implementation',
      outputJsonSchema: { type: 'object' },
      sessionId: TASK_INPUT.sessionId,
      execution: execOptions(),
      materializeTempFiles: false,
    });
    expect(Array.isArray(plan.argv)).toBe(true);
    expect(plan.argv).toContain('--output-format');
    expect(plan.argv).toContain('--permission-mode');
    expect(plan.argv[plan.argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(plan.argv).toContain('--session-id');
    expect(plan.argv).toContain('--model');
    expect(plan.argv).toContain('--max-budget-usd');
    // The prompt travels via stdin, never argv.
    expect(plan.argv.join(' ')).not.toContain('prompt text');
    expect(plan.stdin).toBe('prompt text');
    for (const forbidden of ['--dangerously-skip-permissions', 'bypassPermissions']) {
      expect(plan.argv.join(' ')).not.toContain(forbidden);
    }
  });

  it('Bash tool access is expressed only through configured allow rules', async () => {
    scenario('success');
    const config = fakeConfig();
    const probe = await probeClaude(config);
    const plan = buildClaudeInvocation({
      config,
      probe,
      prompt: 'p',
      toolPolicy: 'implementation',
      outputJsonSchema: {},
      execution: execOptions(),
      materializeTempFiles: false,
    });
    const tools = plan.argv[plan.argv.indexOf('--allowedTools') + 1] ?? '';
    expect(tools).toContain('Bash(git status *)');
    expect(tools.split(',')).not.toContain('Bash');
  });

  it('stage generation restricts tools to Read,Glob,Grep with default permission mode', async () => {
    scenario('success');
    const config = fakeConfig();
    const probe = await probeClaude(config);
    const plan = buildClaudeInvocation({
      config,
      probe,
      prompt: 'p',
      toolPolicy: 'read-only',
      outputJsonSchema: {},
      execution: execOptions(),
      materializeTempFiles: false,
    });
    expect(plan.argv[plan.argv.indexOf('--allowedTools') + 1]).toBe('Read,Glob,Grep');
    expect(plan.argv[plan.argv.indexOf('--permission-mode') + 1]).toBe('default');
  });

  it('assertNoForbiddenArguments throws on any bypass flag', () => {
    expect(() => assertNoForbiddenArguments(['-p', '--dangerously-skip-permissions'])).toThrow(
      /never skips or bypasses/,
    );
    expect(() => assertNoForbiddenArguments(['--permission-mode', 'bypassPermissions'])).toThrow();
  });
});

describe('task execution through the fake CLI', () => {
  it('a successful run parses the structured result and records the session', async () => {
    scenario('success');
    const runner = new ClaudeCodeRunner(fakeConfig());
    const options = execOptions();
    const result = await runner.executeTask(TASK_INPUT, options);
    expect(result.outcome).toBe('completed');
    expect(result.report?.summary).toContain('task 1');
    expect(result.sessionId).toBe(TASK_INPUT.sessionId);
    expect(result.resumeSupported).toBe(true);
    expect(result.process?.exitCode).toBe(0);
    expect(result.process?.redactedArgv).toContain('--session-id');
    // The fake actually wrote the file in the workspace.
    const changed = readFileSync(path.join(options.workspaceRoot, 'src', 'fake-claude-change.txt'), 'utf8');
    expect(changed).toContain('fake implementation of 1');
  });

  it('a structured_result envelope validates directly', async () => {
    scenario('structured-result');
    const runner = new ClaudeCodeRunner(fakeConfig());
    const result = await runner.executeTask(TASK_INPUT, execOptions());
    expect(result.outcome).toBe('completed');
    expect(result.report).toBeDefined();
  });

  it('malformed output fails safely and retains the raw output', async () => {
    scenario('malformed');
    const runner = new ClaudeCodeRunner(fakeConfig());
    const result = await runner.executeTask(TASK_INPUT, execOptions());
    expect(result.outcome).toBe('malformed-output');
    expect(result.report).toBeUndefined();
    expect(result.rawStdout).toContain('not json');
  });

  it('a nonzero exit is recorded with stderr retained', async () => {
    scenario('nonzero-exit');
    const runner = new ClaudeCodeRunner(fakeConfig());
    const result = await runner.executeTask(TASK_INPUT, execOptions());
    expect(result.outcome).toBe('failed');
    expect(result.process?.exitCode).toBe(3);
    expect(result.rawStderr).toContain('simulated internal failure');
  });

  it('a permission denial is surfaced as permission-denied', async () => {
    scenario('permission-denied');
    const runner = new ClaudeCodeRunner(fakeConfig());
    const result = await runner.executeTask(TASK_INPUT, execOptions());
    expect(result.outcome).toBe('permission-denied');
    expect(result.failureReason).toContain('never bypasses');
  });

  it('an error envelope without a report is failed, not repaired', async () => {
    scenario('error-envelope');
    const runner = new ClaudeCodeRunner(fakeConfig());
    const result = await runner.executeTask(TASK_INPUT, execOptions());
    expect(result.outcome).toBe('failed');
    expect(result.failureReason).toContain('error_max_turns');
  });

  it('a timeout kills the process and reports timed-out', async () => {
    scenario('exec-timeout');
    const runner = new ClaudeCodeRunner(fakeConfig());
    const started = Date.now();
    const result = await runner.executeTask(TASK_INPUT, execOptions({ timeoutMs: 2000 }));
    expect(result.outcome).toBe('timed-out');
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.process?.timedOut).toBe(true);
  }, 30_000);

  it('cancellation kills the process and reports cancelled', async () => {
    scenario('exec-timeout'); // long-running process, cancelled from outside
    const controller = new AbortController();
    const runner = new ClaudeCodeRunner(fakeConfig());
    setTimeout(() => controller.abort(), 1000);
    const result = await runner.executeTask(
      TASK_INPUT,
      execOptions({ signal: controller.signal, timeoutMs: 60_000 }),
    );
    expect(result.outcome).toBe('cancelled');
    expect(result.process?.cancelled).toBe(true);
  }, 30_000);

  it('the stdout size limit terminates the run without parsing partial JSON', async () => {
    scenario('huge-stdout');
    const runner = new ClaudeCodeRunner(fakeConfig({ maxStdoutBytes: 128 * 1024 }));
    const result = await runner.executeTask(TASK_INPUT, execOptions());
    expect(result.outcome).toBe('failed');
    expect(result.failureReason).toContain('output exceeded');
    expect(result.report).toBeUndefined();
    expect(result.process?.stdoutTruncated).toBe(true);
  }, 30_000);

  it('the stderr size limit works the same way', async () => {
    scenario('huge-stderr');
    const runner = new ClaudeCodeRunner(fakeConfig({ maxStderrBytes: 64 * 1024 }));
    const result = await runner.executeTask(TASK_INPUT, execOptions());
    expect(result.outcome).toBe('failed');
    expect(result.failureReason).toContain('output exceeded');
  }, 30_000);

  it('resume passes --resume with the original session id', async () => {
    scenario('resume-ok');
    const log = path.join(mkdtempSync(path.join(os.tmpdir(), 'fake-claude-log-')), 'invocations.jsonl');
    process.env['FAKE_CLAUDE_LOG'] = log;
    const runner = new ClaudeCodeRunner(fakeConfig());
    const result = await runner.resumeTask(
      { ...TASK_INPUT, sessionId: 'aaaa-bbbb' },
      execOptions(),
    );
    expect(result.outcome).toBe('completed');
    const invocations = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { argv: string[] });
    const executed = invocations.find((invocation) => invocation.argv.includes('--resume'));
    expect(executed).toBeDefined();
    expect(executed?.argv[executed.argv.indexOf('--resume') + 1]).toBe('aaaa-bbbb');
    expect(executed?.argv).not.toContain('--session-id');
  });
});

describe('envelope parsing', () => {
  it('parses a plain result envelope', () => {
    const parsed = parseClaudeEnvelope('{"type":"result","result":"{}","session_id":"s"}');
    expect(parsed.envelope?.session_id).toBe('s');
    expect(parsed.reportText).toBe('{}');
  });

  it('takes the last parseable JSON line when streams precede the envelope', () => {
    const parsed = parseClaudeEnvelope(
      'progress line\n{"type":"turn"}\n{"type":"result","result":"{\\"a\\":1}"}',
    );
    expect(parsed.reportText).toBe('{"a":1}');
  });

  it('reports a problem for garbage without guessing', () => {
    const parsed = parseClaudeEnvelope('not json');
    expect(parsed.problem).toBeDefined();
  });
});

describe('safe process guardrails', () => {
  it('never leaves the child running after a timeout (no orphaned pipes)', async () => {
    scenario('exec-timeout');
    const result = await runSafeProcess({
      executable: process.execPath,
      argv: [FAKE_CLAUDE_PATH, '-p'],
      cwd: process.cwd(),
      timeoutMs: 1500,
      stdin: 'x',
    });
    expect(result.status).toBe('timeout');
    expect(result.observation.timedOut).toBe(true);
  }, 20_000);

  it('rejects argv containing null bytes before spawning', async () => {
    await expect(
      runSafeProcess({
        executable: process.execPath,
        argv: ['a\0b'],
        cwd: process.cwd(),
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/null bytes/);
  });

  it('redacts configured argv values in the audit record', async () => {
    scenario('success');
    const result = await runSafeProcess({
      executable: process.execPath,
      argv: [FAKE_CLAUDE_PATH, '--version', 'super-secret'],
      cwd: process.cwd(),
      timeoutMs: 15_000,
      redactValues: ['super-secret'],
    });
    expect(result.observation.redactedArgv).toContain('<redacted>');
    expect(result.observation.redactedArgv.join(' ')).not.toContain('super-secret');
  });
});
