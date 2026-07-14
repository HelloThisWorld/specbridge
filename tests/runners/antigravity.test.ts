import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunner } from '@specbridge/runners';
import {
  AntigravityCliRunner,
  RUNNER_OPERATIONS,
  checkOperationSupport,
  createDefaultRunnerRegistry,
  runRunnerConformance,
  selectRunner,
} from '@specbridge/runners';
import type { RegisteredRunnerProfile } from '@specbridge/runners';
import type { AntigravityProfileConfig } from '@specbridge/core';
import { antigravityProfileSchema, defaultResolvedAgentConfig } from '@specbridge/core';
import { FAKE_ANTIGRAVITY_PATH } from '../helpers-execution.js';

/**
 * Experimental Antigravity adapter tests: detection and diagnostics ONLY.
 * The fake executable HANGS on any invocation other than --version/--help,
 * so any accidental automation attempt fails via timeout — proving the
 * adapter never starts a TUI, never injects keystrokes, never uses a PTY.
 */

function fakeAntigravityConfig(
  overrides: Partial<AntigravityProfileConfig> = {},
): AntigravityProfileConfig {
  return antigravityProfileSchema.parse({
    runner: 'antigravity-cli',
    enabled: true,
    command: { executable: process.execPath, args: [FAKE_ANTIGRAVITY_PATH] },
    timeoutMs: 5_000,
    ...overrides,
  });
}

function withScenario(scenario: string | undefined): void {
  if (scenario === undefined) delete process.env['FAKE_ANTIGRAVITY_SCENARIO'];
  else process.env['FAKE_ANTIGRAVITY_SCENARIO'] = scenario;
}

afterEach(() => {
  delete process.env['FAKE_ANTIGRAVITY_SCENARIO'];
  delete process.env['FAKE_ANTIGRAVITY_LOG'];
});

describe('antigravity detection (observation only)', () => {
  it('reports a missing executable as unavailable and stays experimental', async () => {
    const runner = new AntigravityCliRunner(
      fakeAntigravityConfig({ command: { executable: 'specbridge-no-such-agy-xyz', args: [] } }),
    );
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    expect(detection.status).toBe('unavailable');
    expect(detection.supportLevel).toBe('experimental');
    expect(detection.diagnostics.some((d) => d.code === 'RUNNER_EXECUTABLE_NOT_FOUND')).toBe(true);
  });

  it('detects the executable and version; every capability stays disabled', async () => {
    withScenario('interactive-only');
    const runner = new AntigravityCliRunner(fakeAntigravityConfig());
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    expect(detection.status).toBe('available');
    expect(detection.version).toContain('0.3.1');
    expect(detection.category).toBe('experimental');
    expect(detection.supportLevel).toBe('experimental');
    // The capability SET is fully false: nothing is executable.
    expect(Object.values(detection.capabilitySet).every((value) => value === false)).toBe(true);
    expect(detection.diagnostics.some((d) => d.code === 'RUNNER_EXPERIMENTAL')).toBe(true);
  });

  it('classifies an interactive-only installation with actionable diagnostics', async () => {
    withScenario('interactive-only');
    const runner = new AntigravityCliRunner(fakeAntigravityConfig());
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    const messages = detection.diagnostics.map((d) => d.message).join(' ');
    expect(messages).toContain('interactive');
    expect(messages).toContain('never automates a TUI');
    // Missing headless mode and structured output are reported explicitly.
    const notProven = detection.diagnostics.find((d) => d.code === 'RUNNER_CAPABILITY_NOT_PROVEN');
    expect(notProven?.message).toContain('headless');
    expect(notProven?.message).toContain('structured');
  });

  it('claimed headless support without structured output stays not-proven for output', async () => {
    withScenario('headless-claimed');
    const runner = new AntigravityCliRunner(fakeAntigravityConfig());
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    const capability = (id: string) => detection.capabilities.find((entry) => entry.id === id);
    expect(capability('headless')?.available).toBe(true);
    expect(capability('machine-readable')?.available).toBe(false);
    // Detected-or-not, execution stays off.
    expect(detection.capabilitySet.taskExecution).toBe(false);
  });

  it('even a documented structured-output fixture keeps automation disabled in v0.6.1', async () => {
    withScenario('documented-structured');
    const runner = new AntigravityCliRunner(fakeAntigravityConfig());
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    const capability = (id: string) => detection.capabilities.find((entry) => entry.id === id);
    expect(capability('headless')?.available).toBe(true);
    expect(capability('machine-readable')?.available).toBe(true);
    expect(capability('resume')?.available).toBe(true);
    // Diagnostics detected the tokens; the capability SET stays false.
    expect(detection.capabilitySet.stageGeneration).toBe(false);
    expect(detection.capabilitySet.taskExecution).toBe(false);
    expect(detection.capabilitySet.taskResume).toBe(false);
    expect(detection.supportLevel).toBe('experimental');
  });

  it('a build that hijacks --version into an interactive session is classified, not automated', async () => {
    withScenario('interactive-hang');
    const runner = new AntigravityCliRunner(fakeAntigravityConfig({ timeoutMs: 2_000 }));
    const started = Date.now();
    const detection = await runner.detect({ workspaceRoot: process.cwd(), timeoutMs: 2_000 });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(detection.status).toBe('incompatible');
    expect(detection.diagnostics.some((d) => d.code === 'RUNNER_INTERACTIVE_ONLY')).toBe(true);
  });

  it('the doctor only ever runs --version and --help — no TUI, no login, no sessions', async () => {
    withScenario('documented-structured');
    const log = path.join(mkdtempSync(path.join(os.tmpdir(), 'specbridge-agy-log-')), 'invocations.jsonl');
    process.env['FAKE_ANTIGRAVITY_LOG'] = log;
    const runner = new AntigravityCliRunner(fakeAntigravityConfig());
    await runner.detect({ workspaceRoot: process.cwd(), probeCapabilities: true });
    const invocations = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { argv: string[] }).argv);
    expect(invocations).toEqual([['--version'], ['--help']]);
  });
});

describe('antigravity execution refusals (defense in depth)', () => {
  it('stage generation and task execution refuse without spawning anything', async () => {
    withScenario('interactive-only');
    const log = path.join(mkdtempSync(path.join(os.tmpdir(), 'specbridge-agy-log2-')), 'invocations.jsonl');
    process.env['FAKE_ANTIGRAVITY_LOG'] = log;
    const runner = new AntigravityCliRunner(fakeAntigravityConfig());
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'specbridge-agy-exec-'));
    const execution = { workspaceRoot: scratch, runDir: path.join(scratch, 'run'), timeoutMs: 5_000 };
    const stage = await runner.generateStage(
      {
        specName: 'x',
        stage: 'requirements',
        intent: 'generate',
        prompt: 'p',
        promptVersion: '1',
        toolPolicy: 'read-only',
      },
      execution,
    );
    expect(stage.outcome).toBe('failed');
    expect(stage.error?.code).toBe('unsupported_operation');
    const task = await runner.executeTask(
      { specName: 'x', taskId: '1', prompt: 'p', promptVersion: '1', toolPolicy: 'implementation' },
      execution,
    );
    expect(task.outcome).toBe('failed');
    expect(task.resumeSupported).toBe(false);
    expect((runner as AgentRunner).resumeTask).toBeUndefined();
    // NO process was spawned by either refusal.
    expect(existsSync(log)).toBe(false);
  });
});

describe('antigravity selection and support rules', () => {
  it('is registered as a built-in profile that defaults to disabled', () => {
    const registry = createDefaultRunnerRegistry();
    const profile = registry.getProfile('antigravity');
    expect(profile.config.enabled).toBe(false);
    expect(profile.runner.category).toBe('experimental');
    expect(profile.runner.declaredSupportLevel).toBe('experimental');
  });

  it('is never selected automatically and requires explicit opt-in even when enabled', () => {
    const config = defaultResolvedAgentConfig();
    const antigravity = config.runnerProfiles['antigravity'];
    if (antigravity === undefined || antigravity.runner !== 'antigravity-cli') {
      throw new Error('expected the antigravity built-in profile');
    }
    config.runnerProfiles['antigravity'] = { ...antigravity, enabled: true };
    config.defaultRunner = 'antigravity';
    const registry = createDefaultRunnerRegistry(config);
    // Global-default selection is refused for experimental profiles…
    const implicit = selectRunner(registry, config, { operation: 'stage-generation' });
    expect(implicit.ok).toBe(false);
    // …and every executing operation is capability-refused even with
    // --runner. (model-list has no capability requirements by frozen design;
    // it is gated by the absent listModels affordance instead.)
    for (const operation of RUNNER_OPERATIONS) {
      if (operation === 'model-list') continue;
      const explicit = selectRunner(registry, config, {
        operation,
        explicitProfile: 'antigravity',
      });
      expect(explicit.ok, operation).toBe(false);
    }
    expect(registry.get('antigravity').listModels).toBeUndefined();
    expect(registry.get('antigravity').selfTest).toBeUndefined();
  });

  it('the experimental flag cannot be turned off in configuration', () => {
    expect(
      antigravityProfileSchema.safeParse({ runner: 'antigravity-cli', experimental: false }).success,
    ).toBe(false);
  });

  it('declares no supported executing operations at all', () => {
    const runner = new AntigravityCliRunner(fakeAntigravityConfig());
    for (const operation of RUNNER_OPERATIONS) {
      if (operation === 'model-list') continue;
      expect(checkOperationSupport(operation, runner.declaredCapabilities).supported, operation).toBe(
        false,
      );
    }
  });

  it('cannot be confirmed production by conformance, even with all checks passing', async () => {
    withScenario('documented-structured');
    const config = fakeAntigravityConfig();
    const profile: RegisteredRunnerProfile = {
      name: 'antigravity',
      config,
      runner: new AntigravityCliRunner(config),
    };
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'specbridge-agy-conf-'));
    const result = await runRunnerConformance({
      profile,
      workspaceRoot: scratch,
      runDir: path.join(scratch, '.specbridge-conformance-runs'),
      invocationsAllowed: true,
      timeoutMs: 30_000,
    });
    // Detection conformance passes (doctor has no side effects)…
    expect(result.failedChecks).toBe(0);
    expect(result.passed).toBe(true);
    // …but production is NEVER confirmed for an experimental adapter.
    expect(result.productionConfirmed).toBe(false);
    // Only detection is applicable: no authoring, no execution, no resume.
    for (const group of result.groups) {
      if (group.group !== 'detection') expect(group.applicable, group.group).toBe(false);
    }
  });
});

describe('no PTY/TUI automation exists for antigravity', () => {
  it('the adapter source uses no PTY library, keystroke automation, or ANSI screen parsing', () => {
    const source = readFileSync(
      path.join(
        process.cwd(),
        'packages',
        'runners',
        'src',
        'antigravity-cli',
        'runner.ts',
      ),
      'utf8',
    );
    for (const forbidden of [
      'node-pty',
      'pty.js',
      'openpty',
      'forkpty',
      'sendKeys(',
      'ansi-regex',
      'strip-ansi',
      'xterm',
    ]) {
      expect(source.includes(forbidden), forbidden).toBe(false);
    }
    // The adapter never pipes anything to the process (no keystroke
    // injection is possible: runSafeProcess ignores stdin when absent).
    expect(source).not.toContain('stdin:');
    // No Gemini flags are assumed for Antigravity.
    expect(source).not.toContain('--approval-mode plan');
    expect(source).not.toContain('--yolo');
  });

  it('no PTY dependency exists anywhere in the runners package manifest', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(process.cwd(), 'packages', 'runners', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const all = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
    for (const name of Object.keys(all)) {
      expect(/pty|xterm|ansi/i.test(name), name).toBe(false);
    }
  });
});
