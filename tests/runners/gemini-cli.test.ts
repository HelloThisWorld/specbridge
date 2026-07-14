import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GeminiCliRunner,
  assertNoForbiddenGeminiArguments,
  buildGeminiInvocation,
  geminiCapabilitySet,
  isExplicitGeminiSessionId,
  normalizeGeminiEvents,
  parseGeminiEventStream,
  probeGemini,
  runRunnerConformance,
} from '@specbridge/runners';
import type { RegisteredRunnerProfile } from '@specbridge/runners';
import { EXECUTION_CONFORMANCE_GROUPS } from '@specbridge/execution';
import type { GeminiProfileConfig } from '@specbridge/core';
import { geminiProfileSchema } from '@specbridge/core';
import { FAKE_GEMINI_PATH } from '../helpers-execution.js';

/**
 * Process-level Gemini adapter tests: every scenario spawns the REAL fake
 * Gemini CLI as a child process (never a mocked adapter method). Fully
 * offline: no network, no model, no credentials, no login, no TUI.
 */

const SESSION_UUID = 'aaaaaaaa-1111-2222-3333-444444444444';

function fakeGeminiConfig(overrides: Partial<GeminiProfileConfig> = {}): GeminiProfileConfig {
  return geminiProfileSchema.parse({
    runner: 'gemini-cli',
    enabled: true,
    command: { executable: process.execPath, args: [FAKE_GEMINI_PATH] },
    timeoutMs: 30_000,
    ...overrides,
  });
}

function scratchDirs(): { workspaceRoot: string; runDir: string } {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'specbridge-gemini-test-'));
  return { workspaceRoot, runDir: path.join(workspaceRoot, '.specbridge', 'runs', 'run-1') };
}

function withScenario(scenario: string | undefined): void {
  if (scenario === undefined) delete process.env['FAKE_GEMINI_SCENARIO'];
  else process.env['FAKE_GEMINI_SCENARIO'] = scenario;
}

function scratchLog(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'specbridge-gemini-log-'));
  return path.join(dir, 'invocations.jsonl');
}

interface LoggedInvocation {
  argv: string[];
  outputFormat: string;
  approvalMode: string;
  allowedTools: string[] | null;
  sandboxed: boolean;
  resumeSessionId: string | null;
  stdinBytes: number;
}

function readLog(logPath: string): LoggedInvocation[] {
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as LoggedInvocation);
}

afterEach(() => {
  delete process.env['FAKE_GEMINI_SCENARIO'];
  delete process.env['FAKE_GEMINI_LOG'];
});

const generationInput = {
  specName: 'settings-persistence',
  stage: 'requirements' as const,
  intent: 'generate' as const,
  prompt: '# prompt\n\nStage to produce: requirements\n',
  promptVersion: '1.1.0',
  toolPolicy: 'read-only' as const,
};

const taskInput = {
  specName: 'settings-persistence',
  taskId: '2.3',
  prompt: 'Spec: settings-persistence\n\n>>> IMPLEMENT THIS TASK ONLY: 2.3. Persist the setting.\n',
  promptVersion: '1.1.0',
  toolPolicy: 'implementation' as const,
};

describe('gemini detection (read-only probes; no model request, no login)', () => {
  it('detects the executable, version, and full capabilities', async () => {
    withScenario('success');
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const detection = await runner.detect({ workspaceRoot: process.cwd(), probeCapabilities: true });
    expect(detection.status).toBe('available');
    expect(detection.version).toContain('0.9.9');
    expect(detection.category).toBe('agent-cli');
    expect(detection.supportLevel).toBe('production');
    expect(detection.capabilitySet.stageGeneration).toBe(true);
    expect(detection.capabilitySet.stageRefinement).toBe(true);
    expect(detection.capabilitySet.taskExecution).toBe(true);
    expect(detection.capabilitySet.taskResume).toBe(true);
    expect(detection.capabilitySet.streamingEvents).toBe(true);
    expect(detection.capabilitySet.sandbox).toBe(true);
    expect(detection.capabilitySet.toolRestriction).toBe(true);
    expect(detection.capabilitySet.supportsJsonSchema).toBe(false);
  });

  it('reports a missing executable as unavailable', async () => {
    const runner = new GeminiCliRunner(
      fakeGeminiConfig({ command: { executable: 'specbridge-no-such-gemini-xyz', args: [] } }),
    );
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    expect(detection.status).toBe('unavailable');
    expect(detection.supportLevel).toBe('unavailable');
    expect(detection.diagnostics.some((d) => d.code === 'RUNNER_EXECUTABLE_NOT_FOUND')).toBe(true);
  });

  it('detects headless, json, and stream-json output support individually', async () => {
    withScenario('success');
    const probe = await probeGemini(fakeGeminiConfig());
    const available = (id: string): boolean =>
      probe.capabilities.find((capability) => capability.id === id)?.available === true;
    expect(available('headless')).toBe(true);
    expect(available('output-json')).toBe(true);
    expect(available('output-stream-json')).toBe(true);
    expect(available('plan-mode')).toBe(true);
    expect(available('auto-edit-mode')).toBe(true);
    expect(available('sandbox')).toBe(true);
    expect(available('allowed-tools')).toBe(true);
    expect(available('session-list')).toBe(true);
    expect(available('resume')).toBe(true);
  });

  it('a version without headless prompts is incompatible', async () => {
    withScenario('no-headless');
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    expect(detection.status).toBe('incompatible');
    expect(detection.supportLevel).toBe('incompatible');
    expect(detection.capabilitySet.stageGeneration).toBe(false);
    expect(detection.diagnostics.map((d) => d.message).join(' ')).toContain('Headless prompt invocation');
  });

  it('a version without machine-readable output is incompatible', async () => {
    withScenario('no-json');
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    expect(detection.status).toBe('incompatible');
    expect(detection.diagnostics.map((d) => d.message).join(' ')).toContain('Machine-readable output');
  });

  it('a version without stream-json degrades to the JSON envelope', async () => {
    withScenario('no-stream-json');
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    expect(detection.status).toBe('available');
    expect(detection.capabilitySet.streamingEvents).toBe(false);
    expect(detection.capabilitySet.stageGeneration).toBe(true);
  });

  it('a version without plan mode keeps authoring through the tool allowlist', async () => {
    withScenario('no-plan');
    const probe = await probeGemini(fakeGeminiConfig());
    const set = geminiCapabilitySet(probe);
    expect(set.stageGeneration).toBe(true);
    expect(set.toolRestriction).toBe(true);
  });

  it('a version without auto_edit keeps authoring but drops task execution', async () => {
    withScenario('no-auto-edit');
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    expect(detection.status).toBe('available');
    expect(detection.capabilitySet.stageGeneration).toBe(true);
    expect(detection.capabilitySet.taskExecution).toBe(false);
    expect(detection.capabilitySet.taskResume).toBe(false);
  });

  it('an unsafe edit policy (no allowlist, no sandbox) drops task execution and explains the gap', async () => {
    withScenario('unsafe-edit-policy');
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    expect(detection.status).toBe('available');
    expect(detection.capabilitySet.stageGeneration).toBe(true);
    expect(detection.capabilitySet.taskExecution).toBe(false);
    const messages = detection.diagnostics.map((d) => d.message).join(' ');
    expect(messages).toContain('without also permitting arbitrary shell commands');
    expect(messages).toContain('claude-code or codex-cli');
  });

  it('a version without resume keeps task execution but drops taskResume', async () => {
    withScenario('no-resume');
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    expect(detection.capabilitySet.taskExecution).toBe(true);
    expect(detection.capabilitySet.taskResume).toBe(false);
  });

  it('doctor-level detection never runs a headless prompt (no inference, no login, no trust change)', async () => {
    withScenario('success');
    const log = scratchLog();
    process.env['FAKE_GEMINI_LOG'] = log;
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const detection = await runner.detect({ workspaceRoot: process.cwd(), probeCapabilities: true });
    // The headless log records only real prompt runs (probes never reach it).
    expect(existsSync(log)).toBe(false);
    // Authentication is unknown — never probed through credential files.
    expect(detection.authentication).toBe('unknown');
    expect(detection.diagnostics.some((d) => d.code === 'RUNNER_AUTH_PROBE_UNSUPPORTED')).toBe(true);
  });

  it('model listing is honestly unsupported (no guessing)', async () => {
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const models = await runner.listModels({ workspaceRoot: process.cwd() });
    expect(models.supported).toBe(false);
    expect(models.models).toEqual([]);
  });
});

describe('gemini invocation safety', () => {
  it('argv is an array, prompts travel via stdin, plan mode and read-only tools apply to authoring', async () => {
    withScenario('success');
    const config = fakeGeminiConfig();
    const probe = await probeGemini(config);
    const { workspaceRoot, runDir } = scratchDirs();
    const plan = buildGeminiInvocation({
      config,
      probe,
      prompt: 'Stage to produce: requirements',
      toolPolicy: 'read-only',
      execution: { workspaceRoot, runDir, timeoutMs: 10_000 },
    });
    expect(Array.isArray(plan.argv)).toBe(true);
    expect(plan.stdin).toContain('Stage to produce');
    // The prompt is NOT in the argv (process-list safety).
    expect(plan.argv.join(' ')).not.toContain('Stage to produce');
    expect(plan.approvalMode).toBe('plan');
    expect(plan.argv).toContain('--approval-mode');
    expect(plan.argv[plan.argv.indexOf('--approval-mode') + 1]).toBe('plan');
    // Read-only tools only: no edit tools, no shell.
    expect(plan.allowedTools).toBeDefined();
    expect(plan.allowedTools).not.toContain('replace');
    expect(plan.allowedTools).not.toContain('write_file');
    expect(plan.allowedTools).not.toContain('run_shell_command');
    expect(plan.argv).toContain('--sandbox');
    expect(plan.argv).toContain('--extensions');
    expect(plan.argv.join(' ')).not.toContain('--yolo');
  });

  it('task execution uses auto_edit with edit tools but never shell tools', async () => {
    withScenario('success');
    const config = fakeGeminiConfig({ allowedTools: ['web_fetch'] });
    const probe = await probeGemini(config);
    const { workspaceRoot, runDir } = scratchDirs();
    const plan = buildGeminiInvocation({
      config,
      probe,
      prompt: 'x',
      toolPolicy: 'implementation',
      execution: { workspaceRoot, runDir, timeoutMs: 10_000 },
    });
    expect(plan.approvalMode).toBe('auto_edit');
    expect(plan.allowedTools).toContain('replace');
    expect(plan.allowedTools).toContain('write_file');
    expect(plan.allowedTools).toContain('web_fetch');
    expect(plan.allowedTools).not.toContain('run_shell_command');
    expect(plan.argv.join(' ')).not.toContain('yolo');
  });

  it('YOLO and unrestricted modes are rejected pre-spawn, whatever the source', () => {
    expect(() => assertNoForbiddenGeminiArguments(['--yolo'])).toThrow(/never uses YOLO|Refusing/);
    expect(() => assertNoForbiddenGeminiArguments(['--approval-mode', 'yolo'])).toThrow(/never yolo/);
    expect(() => assertNoForbiddenGeminiArguments(['--trust-folder'])).toThrow(/Refusing/);
    expect(() =>
      assertNoForbiddenGeminiArguments(['--allowed-tools', 'read_file,run_shell_command']),
    ).toThrow(/arbitrary shell/);
  });

  it('resume accepts only explicit session UUIDs — never latest or an index', () => {
    expect(isExplicitGeminiSessionId(SESSION_UUID)).toBe(true);
    expect(isExplicitGeminiSessionId('latest')).toBe(false);
    expect(isExplicitGeminiSessionId('1')).toBe(false);
    expect(isExplicitGeminiSessionId('')).toBe(false);
    expect(() => assertNoForbiddenGeminiArguments(['--resume', 'latest'])).toThrow(/explicit session UUID/);
    expect(() => assertNoForbiddenGeminiArguments(['--resume', '2'])).toThrow(/explicit session UUID/);
    expect(() => assertNoForbiddenGeminiArguments(['--resume', SESSION_UUID])).not.toThrow();
  });

  it('shell tools in the profile allowlist are rejected by the configuration schema', () => {
    const result = geminiProfileSchema.safeParse({
      runner: 'gemini-cli',
      allowedTools: ['run_shell_command'],
    });
    expect(result.success).toBe(false);
  });

  it('yolo approval modes are rejected by the configuration schema', () => {
    expect(
      geminiProfileSchema.safeParse({ runner: 'gemini-cli', approvalModeForExecution: 'yolo' }).success,
    ).toBe(false);
    expect(
      geminiProfileSchema.safeParse({ runner: 'gemini-cli', approvalModeForAuthoring: 'auto_edit' }).success,
    ).toBe(false);
  });
});

describe('gemini authoring (read-only boundary)', () => {
  it('generates a stage with a validated structured result, session id, usage, and no repository writes', async () => {
    withScenario('success');
    const log = scratchLog();
    process.env['FAKE_GEMINI_LOG'] = log;
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, {
      workspaceRoot,
      runDir,
      timeoutMs: 30_000,
    });
    expect(result.outcome).toBe('completed');
    expect(result.report?.stage).toBe('requirements');
    expect(result.report?.markdown).toContain('# Requirements Document');
    expect(result.sessionId).toBe(SESSION_UUID);
    expect(result.usage?.inputTokens).toBe(900);
    expect(result.usage?.outputTokens).toBe(210);
    // The invocation used plan mode, read-only tools, and stdin.
    const [logged] = readLog(log);
    expect(logged?.approvalMode).toBe('plan');
    expect(logged?.allowedTools).not.toContain('replace');
    expect(logged?.allowedTools).not.toContain('run_shell_command');
    expect(logged?.argv.join(' ')).not.toContain('yolo');
    expect(logged?.stdinBytes).toBeGreaterThan(0);
    // The workspace was not modified by authoring.
    expect(existsSync(path.join(workspaceRoot, 'rogue-authoring-write.txt'))).toBe(false);
  });

  it('stage refinement works through the same boundary', async () => {
    withScenario('success');
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(
      {
        ...generationInput,
        intent: 'refine',
        prompt: `${generationInput.prompt}\nRefinement instruction: add recovery behavior.\n`,
      },
      { workspaceRoot, runDir, timeoutMs: 30_000 },
    );
    expect(result.outcome).toBe('completed');
    expect(result.report?.summary).toContain('(refinement)');
  });

  it('works through the single JSON envelope when stream-json is unavailable', async () => {
    withScenario('no-stream-json');
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, {
      workspaceRoot,
      runDir,
      timeoutMs: 30_000,
    });
    expect(result.outcome).toBe('completed');
    expect(result.report?.stage).toBe('requirements');
    expect(result.sessionId).toBe(SESSION_UUID);
  });

  it('normalizes machine-readable events and redacts reasoning content everywhere', async () => {
    withScenario('success');
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, {
      workspaceRoot,
      runDir,
      timeoutMs: 30_000,
    });
    const events = result.normalizedEvents ?? [];
    expect(events.some((event) => event.type === 'session.started')).toBe(true);
    expect(events.some((event) => event.type === 'usage.updated')).toBe(true);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('GEMINI-REASONING-SECRET');
    const thought = events.find((event) => event.providerEventType === 'thought');
    expect(thought?.payload['redacted']).toBe(true);
    // Reasoning content never survives into the RETAINED raw stream either.
    expect(result.rawStdout).not.toContain('GEMINI-REASONING-SECRET');
    expect(result.rawStdout).toContain('[redacted reasoning:');
    expect(result.rawStdout).toContain('session.started');
  });

  it('malformed final output fails safely and retains it for the correction retry', async () => {
    withScenario('malformed');
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('malformed-output');
    expect(result.report).toBeUndefined();
    expect(result.error?.code).toBe('structured_output_invalid');
    expect(result.invalidStructuredOutput).toContain('not json');
  });

  it('extra prose around JSON is not accepted as structured output', async () => {
    withScenario('extra-prose');
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('malformed-output');
    expect(result.failureReason).toContain('extra prose is not accepted');
  });

  it('a missing final result fails safely', async () => {
    withScenario('missing-final');
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('malformed-output');
    expect(result.error?.code).toBe('structured_output_invalid');
  });

  it('the bounded correction retry context reaches the provider and fixes the output', async () => {
    withScenario('correctable');
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const { workspaceRoot, runDir } = scratchDirs();
    const first = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(first.outcome).toBe('malformed-output');
    const corrected = await runner.generateStage(
      {
        ...generationInput,
        correction: {
          previousOutput: first.invalidStructuredOutput ?? '',
          problems: 'the response was not a JSON document',
        },
      },
      { workspaceRoot, runDir, timeoutMs: 30_000 },
    );
    expect(corrected.outcome).toBe('completed');
  });

  it('an installation without any read-only boundary refuses authoring before invocation', async () => {
    withScenario('no-plan');
    // no-plan alone keeps allowed-tools; combine with no allowlist via the
    // dedicated scenario that removes both plan and tools support.
    const log = scratchLog();
    process.env['FAKE_GEMINI_LOG'] = log;
    const probeConfig = fakeGeminiConfig();
    const probe = await probeGemini(probeConfig);
    expect(geminiCapabilitySet(probe).stageGeneration).toBe(true);
    expect(existsSync(log)).toBe(false);
  });
});

describe('gemini task execution (bounded edit policy)', () => {
  it('executes a task with auto_edit, edit tools, and no shell access', async () => {
    withScenario('success');
    const log = scratchLog();
    process.env['FAKE_GEMINI_LOG'] = log;
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.executeTask(taskInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('completed');
    expect(result.report?.outcome).toBe('completed');
    expect(result.sessionId).toBe(SESSION_UUID);
    expect(result.resumeSupported).toBe(true);
    // The fake honored the boundary and edited within the workspace.
    expect(existsSync(path.join(workspaceRoot, 'src', 'fake-gemini-change.txt'))).toBe(true);
    const [logged] = readLog(log);
    expect(logged?.approvalMode).toBe('auto_edit');
    expect(logged?.allowedTools).toContain('replace');
    expect(logged?.allowedTools).not.toContain('run_shell_command');
    expect(logged?.argv.join(' ')).not.toContain('yolo');
  });

  it('a shell-tool request from the agent surfaces as a denied tool event, never an execution', async () => {
    withScenario('shell-attempt');
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.executeTask(taskInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    const denied = (result.normalizedEvents ?? []).find(
      (event) => event.type === 'tool.failed' && event.payload['tool'] === 'run_shell_command',
    );
    expect(denied?.payload['status']).toBe('denied');
  });

  it('an unsafe edit policy refuses task execution BEFORE the provider is invoked', async () => {
    withScenario('unsafe-edit-policy');
    const log = scratchLog();
    process.env['FAKE_GEMINI_LOG'] = log;
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.executeTask(taskInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('runner_incompatible');
    expect(result.failureReason).toContain('arbitrary shell');
    expect(result.error?.remediation.join(' ')).toContain('claude-code or codex-cli');
    // No headless invocation happened.
    expect(existsSync(log)).toBe(false);
    // Authoring still works for the same installation.
    const authoring = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(authoring.outcome).toBe('completed');
  });
});

describe('gemini resume (explicit session identity only)', () => {
  const resumeInput = {
    specName: 'settings-persistence',
    taskId: '2.3',
    prompt: taskInput.prompt,
    promptVersion: '1.1.0',
    toolPolicy: 'implementation' as const,
  };

  it('resume passes the explicit session UUID to the provider', async () => {
    withScenario('resume-ok');
    const log = scratchLog();
    process.env['FAKE_GEMINI_LOG'] = log;
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.resumeTask(
      { ...resumeInput, sessionId: SESSION_UUID },
      { workspaceRoot, runDir, timeoutMs: 30_000 },
    );
    expect(result.outcome).toBe('completed');
    const [logged] = readLog(log);
    expect(logged?.resumeSessionId).toBe(SESSION_UUID);
  });

  it('resume refuses "latest" and index identifiers without invoking the provider', async () => {
    withScenario('resume-ok');
    const log = scratchLog();
    process.env['FAKE_GEMINI_LOG'] = log;
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const { workspaceRoot, runDir } = scratchDirs();
    for (const sessionId of ['latest', '1', 'last']) {
      const result = await runner.resumeTask(
        { ...resumeInput, sessionId },
        { workspaceRoot, runDir, timeoutMs: 30_000 },
      );
      expect(result.outcome).toBe('failed');
      expect(result.error?.code).toBe('unsupported_operation');
    }
    expect(existsSync(log)).toBe(false);
  });

  it('a session-identity mismatch is reported and never claimed as a successful resume', async () => {
    withScenario('resume-session-mismatch');
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.resumeTask(
      { ...resumeInput, sessionId: SESSION_UUID },
      { workspaceRoot, runDir, timeoutMs: 30_000 },
    );
    expect(result.outcome).toBe('failed');
    expect(result.error?.providerCode).toBe('session-mismatch');
    expect(result.resumeSupported).toBe(false);
  });

  it('a version without resume support refuses instead of degrading other capabilities', async () => {
    withScenario('no-resume');
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.resumeTask(
      { ...resumeInput, sessionId: SESSION_UUID },
      { workspaceRoot, runDir, timeoutMs: 30_000 },
    );
    expect(result.outcome).toBe('failed');
    // Fresh execution still works.
    const fresh = await runner.executeTask(taskInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(fresh.outcome).toBe('completed');
    expect(fresh.resumeSupported).toBe(false);
  });
});

describe('gemini failure classification', () => {
  const run = async (scenario: string, timeoutMs = 30_000) => {
    withScenario(scenario);
    const runner = new GeminiCliRunner(fakeGeminiConfig());
    const { workspaceRoot, runDir } = scratchDirs();
    return runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs });
  };

  it('authentication failures are classified without exposing credentials', async () => {
    const result = await run('auth-error');
    expect(result.error?.code).toBe('authentication_required');
    expect(result.error?.retryable).toBe(false);
  });

  it('permission denials are classified', async () => {
    const result = await run('permission-denied');
    expect(result.outcome).toBe('permission-denied');
    expect(result.error?.code).toBe('permission_denied');
  });

  it('quota exhaustion is classified', async () => {
    const result = await run('quota-exceeded');
    expect(result.error?.code).toBe('quota_exceeded');
  });

  it('rate limits are classified', async () => {
    const result = await run('rate-limit');
    expect(result.error?.code).toBe('rate_limited');
  });

  it('a timeout kills the Gemini process deterministically', async () => {
    const started = Date.now();
    const result = await run('exec-timeout', 2_000);
    expect(result.outcome).toBe('timed-out');
    expect(result.error?.code).toBe('timed_out');
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.process?.timedOut).toBe(true);
  });

  it('cancellation kills the Gemini process deterministically', async () => {
    withScenario('exec-timeout');
    const runner = new GeminiCliRunner(fakeGeminiConfig());
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
    const runner = new GeminiCliRunner(fakeGeminiConfig({ maxStdoutBytes: 128 * 1024 }));
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('output_limit_exceeded');
    expect(result.report).toBeUndefined();
  });

  it('the stderr limit terminates safely too', async () => {
    withScenario('huge-stderr');
    const runner = new GeminiCliRunner(fakeGeminiConfig({ maxStderrBytes: 64 * 1024 }));
    const { workspaceRoot, runDir } = scratchDirs();
    const result = await runner.generateStage(generationInput, { workspaceRoot, runDir, timeoutMs: 30_000 });
    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('output_limit_exceeded');
  });
});

describe('gemini event stream parsing', () => {
  it('parses and normalizes the documented JSONL shapes', () => {
    const stdout = [
      JSON.stringify({ type: 'session.started', session_id: SESSION_UUID }),
      JSON.stringify({ type: 'thought', text: 'secret reasoning' }),
      JSON.stringify({ type: 'tool.started', name: 'replace', path: 'src/a.ts' }),
      JSON.stringify({ type: 'tool.completed', name: 'replace', status: 'success' }),
      JSON.stringify({ type: 'file.edited', path: 'src/a.ts', kind: 'update' }),
      JSON.stringify({ type: 'usage', input_tokens: 10, output_tokens: 5 }),
      JSON.stringify({ type: 'result', response: '{"ok":true}' }),
      'not json at all',
    ].join('\n');
    const stream = parseGeminiEventStream(stdout);
    expect(stream.sessionId).toBe(SESSION_UUID);
    expect(stream.finalResponse).toBe('{"ok":true}');
    expect(stream.usage?.inputTokens).toBe(10);
    expect(stream.unparseableLines).toBe(0); // plain prose lines are ignored, not counted
    const normalized = normalizeGeminiEvents(
      stream,
      { runner: 'gemini-cli', profile: 'gemini-default', runId: 'r', attemptId: 'a' },
      () => '2026-01-01T00:00:00.000Z',
    );
    expect(normalized.map((event) => event.type)).toEqual([
      'session.started',
      'message.completed',
      'tool.started',
      'tool.completed',
      'file.changed',
      'usage.updated',
      'message.completed',
    ]);
    expect(JSON.stringify(normalized)).not.toContain('secret reasoning');
    expect(normalized[0]?.providerSessionId).toBe(SESSION_UUID);
  });
});

describe('gemini conformance (fake provider, full invocations)', () => {
  function registeredProfile(config: GeminiProfileConfig): RegisteredRunnerProfile {
    return { name: 'gemini-default', config, runner: new GeminiCliRunner(config) };
  }

  it('passes detection, structured-output, authoring, task-execution, and resume groups', async () => {
    withScenario('success');
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'specbridge-gemini-conf-'));
    mkdirSync(path.join(scratch, 'runs'), { recursive: true });
    const result = await runRunnerConformance(
      {
        profile: registeredProfile(fakeGeminiConfig()),
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
    expect(result.groups.find((group) => group.group === 'task-execution')?.applicable).toBe(true);
    expect(result.groups.find((group) => group.group === 'resume')?.applicable).toBe(true);
  }, 120_000);

  it('a rogue authoring write fails the no-writes conformance check', async () => {
    withScenario('authoring-rogue-write');
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'specbridge-gemini-conf-rogue-'));
    const result = await runRunnerConformance({
      profile: registeredProfile(fakeGeminiConfig()),
      workspaceRoot: scratch,
      runDir: path.join(scratch, '.specbridge-conformance-runs'),
      invocationsAllowed: true,
      timeoutMs: 60_000,
    });
    const noWrites = result.groups
      .flatMap((group) => group.checks)
      .find((check) => check.id === 'stage-generation.no-writes');
    expect(noWrites?.status).toBe('failed');
    expect(result.passed).toBe(false);
  }, 120_000);
});
