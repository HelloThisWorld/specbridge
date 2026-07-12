import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveComparisonFromEvent } from '../../integrations/github-action/src/event.js';
import { parseActionInputs } from '../../integrations/github-action/src/inputs.js';
import { ACTION_VERSION } from '../../integrations/github-action/src/version.js';
import { git } from '../helpers-execution.js';
import { setupVerifyFixture, VERIFY_SPEC } from '../helpers-verify.js';
import { fixturePath } from '../helpers.js';

/**
 * GitHub Action tests.
 *
 * Unit level: event resolution and input validation (pure functions).
 * Process level: the committed node20 bundle runs against real fixture
 * repositories with real GITHUB_* environment files — exactly as the runner
 * would execute it, requiring no model and no network access.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const actionDir = path.join(repoRoot, 'integrations', 'github-action');
const bundlePath = path.join(actionDir, 'dist', 'index.js');

beforeAll(() => {
  if (!existsSync(bundlePath)) {
    // Local runs may predate a build; CI builds before testing.
    execFileSync('pnpm', ['--filter', 'specbridge-github-action', 'build'], {
      cwd: repoRoot,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
  }
}, 120_000);

describe('event resolution (unit)', () => {
  const payload = (name: string): unknown =>
    JSON.parse(readFileSync(fixturePath('github-events', `${name}.json`), 'utf8'));

  it('pull_request events resolve base and head SHAs', () => {
    const resolution = resolveComparisonFromEvent({
      eventName: 'pull_request',
      payload: payload('pull_request'),
      sha: 'HEAD_SHA_PLACEHOLDER',
      baseRef: undefined,
      headRef: undefined,
    });
    expect(resolution).toEqual({
      ok: true,
      request: { mode: 'diff', base: 'BASE_SHA_PLACEHOLDER', head: 'HEAD_SHA_PLACEHOLDER' },
      source: 'pull_request event',
    });
  });

  it('push events resolve before...after', () => {
    const resolution = resolveComparisonFromEvent({
      eventName: 'push',
      payload: payload('push'),
      sha: 'HEAD_SHA_PLACEHOLDER',
      baseRef: undefined,
      headRef: undefined,
    });
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.request).toEqual({
        mode: 'diff',
        base: 'BASE_SHA_PLACEHOLDER',
        head: 'HEAD_SHA_PLACEHOLDER',
      });
    }
  });

  it('a branch-creating push (zero before-SHA) fails with guidance', () => {
    const resolution = resolveComparisonFromEvent({
      eventName: 'push',
      payload: { before: '0'.repeat(40), after: 'abc' },
      sha: 'abc',
      baseRef: undefined,
      headRef: undefined,
    });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.message).toContain('base-ref');
  });

  it('workflow_dispatch requires explicit refs and accepts them', () => {
    const withoutRefs = resolveComparisonFromEvent({
      eventName: 'workflow_dispatch',
      payload: payload('workflow_dispatch'),
      sha: 'abc',
      baseRef: undefined,
      headRef: undefined,
    });
    expect(withoutRefs.ok).toBe(false);
    if (!withoutRefs.ok) expect(withoutRefs.message).toContain('base-ref');

    const withRefs = resolveComparisonFromEvent({
      eventName: 'workflow_dispatch',
      payload: payload('workflow_dispatch'),
      sha: 'abc',
      baseRef: 'v1.0.0',
      headRef: undefined,
    });
    expect(withRefs).toEqual({
      ok: true,
      request: { mode: 'diff', base: 'v1.0.0', head: 'HEAD' },
      source: 'explicit base-ref/head-ref inputs',
    });
  });

  it('hostile refs from any source are rejected', () => {
    const resolution = resolveComparisonFromEvent({
      eventName: 'pull_request',
      payload: { pull_request: { base: { sha: '--upload-pack=evil' }, head: { sha: 'abc' } } },
      sha: 'abc',
      baseRef: undefined,
      headRef: undefined,
    });
    expect(resolution.ok).toBe(false);
  });
});

describe('input validation (unit)', () => {
  const inputs = (values: Record<string, string>) => (name: string): string => values[name] ?? '';

  it('applies documented defaults', () => {
    const parsed = parseActionInputs(inputs({}));
    expect(parsed).toMatchObject({
      mode: 'changed',
      failOn: 'error',
      strict: false,
      runVerification: true,
      reportDirectory: '.specbridge/action-reports',
      annotations: true,
      writeStepSummary: true,
      annotationLimit: 50,
    });
  });

  it('rejects invalid enums, booleans, limits, and mode/spec combinations', () => {
    expect(() => parseActionInputs(inputs({ mode: 'everything' }))).toThrow(/single, changed, all/);
    expect(() => parseActionInputs(inputs({ 'fail-on': 'maybe' }))).toThrow(/error, warning, never/);
    expect(() => parseActionInputs(inputs({ strict: 'yep' }))).toThrow(/true.*false/);
    expect(() => parseActionInputs(inputs({ mode: 'single' }))).toThrow(/required/);
    expect(() => parseActionInputs(inputs({ spec: 'x' }))).toThrow(/only applies/);
    expect(() => parseActionInputs(inputs({ 'annotation-limit': '-1' }))).toThrow(/between 0 and 1000/);
    expect(() => parseActionInputs(inputs({ 'report-directory': '../escape' }))).toThrow(/\.\./);
  });

  it('version constant matches the action package version', () => {
    const packageJson = JSON.parse(readFileSync(path.join(actionDir, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(ACTION_VERSION).toBe(packageJson.version);
  });
});

interface ActionRun {
  code: number;
  stdout: string;
  outputs: string;
  summary: string;
}

function runBundledAction(
  workspaceRoot: string,
  options: {
    eventName: string;
    payload: unknown;
    inputs?: Record<string, string>;
    sha?: string;
  },
): ActionRun {
  const ghDir = path.join(workspaceRoot, '.github-runtime');
  mkdirSync(ghDir, { recursive: true });
  const eventPath = path.join(ghDir, 'event.json');
  const outputPath = path.join(ghDir, 'output.txt');
  const summaryPath = path.join(ghDir, 'summary.md');
  writeFileSync(eventPath, JSON.stringify(options.payload), 'utf8');
  writeFileSync(outputPath, '', 'utf8');
  writeFileSync(summaryPath, '', 'utf8');

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GITHUB_WORKSPACE: workspaceRoot,
    GITHUB_EVENT_NAME: options.eventName,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: outputPath,
    GITHUB_STEP_SUMMARY: summaryPath,
    GITHUB_SHA: options.sha ?? 'unset',
  };
  for (const [name, value] of Object.entries(options.inputs ?? {})) {
    env[`INPUT_${name.toUpperCase()}`] = value;
  }

  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync(process.execPath, [bundlePath], {
      cwd: workspaceRoot,
      env,
      encoding: 'utf8',
    });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    code = failure.status ?? 1;
    stdout = failure.stdout ?? '';
  }
  return {
    code,
    stdout,
    outputs: readFileSync(outputPath, 'utf8'),
    summary: readFileSync(summaryPath, 'utf8'),
  };
}

function outputValue(outputs: string, name: string): string | undefined {
  // @actions/core writes os.EOL — tolerate CRLF on Windows.
  const match = new RegExp(`${name}<<(ghadelimiter_[^\r\n]+)\r?\n([\\s\\S]*?)\r?\n\\1`).exec(
    outputs,
  );
  return match?.[2];
}

describe('bundled action (process level)', () => {
  it('passes on a clean pull_request diff, writing outputs, reports, and the step summary', () => {
    const fixture = setupVerifyFixture();
    fixture.writePolicy({ impactAreas: ['src/settings/**'] });
    fixture.commit('policy baseline');
    fixture.write('src/settings/store.ts', 'export {};\n');
    fixture.commit('implementation');
    const base = git(fixture.root, 'rev-parse', 'HEAD~1').trim();
    const head = fixture.head();

    const run = runBundledAction(fixture.root, {
      eventName: 'pull_request',
      payload: { pull_request: { base: { sha: base }, head: { sha: head } } },
      sha: head,
    });

    expect(run.code).toBe(0);
    expect(outputValue(run.outputs, 'result')).toBe('passed');
    expect(outputValue(run.outputs, 'spec-count')).toBe('1');
    expect(outputValue(run.outputs, 'affected-specs')).toBe(`["${VERIFY_SPEC}"]`);
    expect(outputValue(run.outputs, 'json-report')).toBe('.specbridge/action-reports/report.json');
    expect(run.summary).toContain('# SpecBridge Verification');
    expect(run.summary).toContain('Passed');
    for (const file of ['report.json', 'report.md', 'report.html']) {
      expect(existsSync(path.join(fixture.root, '.specbridge', 'action-reports', file))).toBe(true);
    }
  });

  it('fails the step at the threshold with rule-ID annotations, without touching tracked files', () => {
    const fixture = setupVerifyFixture();
    fixture.writePolicy({ mode: 'strict', impactAreas: ['src/settings/**'] });
    fixture.commit('policy');
    fixture.write('src/billing/invoice.ts', 'export {};\n');
    fixture.commit('out-of-scope change');
    const base = git(fixture.root, 'rev-parse', 'HEAD~1').trim();
    const head = fixture.head();
    const statusBefore = git(fixture.root, 'status', '--porcelain');

    const run = runBundledAction(fixture.root, {
      eventName: 'pull_request',
      payload: { pull_request: { base: { sha: base }, head: { sha: head } } },
      sha: head,
      inputs: { mode: 'single', spec: VERIFY_SPEC },
    });

    expect(run.code).toBe(1);
    expect(outputValue(run.outputs, 'result')).toBe('failed');
    expect(Number(outputValue(run.outputs, 'error-count'))).toBeGreaterThan(0);
    expect(run.stdout).toContain('::error');
    expect(run.stdout).toContain('SBV005');
    expect(run.stdout).toContain('file=src/billing/invoice.ts');
    // Tracked files stay untouched; only the report directory appears.
    const statusAfter = git(fixture.root, 'status', '--porcelain')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .filter((line) => !line.includes('.specbridge/action-reports'))
      .filter((line) => !line.includes('.github-runtime'));
    expect(statusAfter.join('\n')).toBe(statusBefore.trim());
  });

  it('resolves push events (before...after)', () => {
    const fixture = setupVerifyFixture();
    fixture.write('src/settings/store.ts', 'export {};\n');
    fixture.commit('pushed work');
    const before = git(fixture.root, 'rev-parse', 'HEAD~1').trim();
    const after = fixture.head();

    const run = runBundledAction(fixture.root, {
      eventName: 'push',
      payload: { before, after },
      sha: after,
    });
    expect(run.code).toBe(0);
    expect(outputValue(run.outputs, 'result')).toBe('passed');
  });

  it('workflow_dispatch without refs fails with actionable guidance', () => {
    const fixture = setupVerifyFixture();
    const run = runBundledAction(fixture.root, {
      eventName: 'workflow_dispatch',
      payload: { inputs: {} },
      sha: fixture.head(),
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('base-ref');
  });

  it('missing history yields the fetch-depth guidance', () => {
    const fixture = setupVerifyFixture();
    const run = runBundledAction(fixture.root, {
      eventName: 'pull_request',
      payload: {
        pull_request: {
          base: { sha: 'f'.repeat(40) },
          head: { sha: fixture.head() },
        },
      },
      sha: fixture.head(),
    });
    expect(run.code).toBe(1);
    expect(`${run.stdout}${run.summary}`).toContain('fetch-depth');
    expect(outputValue(run.outputs, 'result')).toBe('failed');
  });

  it('enforces the annotation limit with a summary warning', () => {
    const fixture = setupVerifyFixture();
    fixture.writePolicy({ impactAreas: ['src/settings/**'] });
    fixture.commit('policy');
    for (let index = 0; index < 5; index += 1) {
      fixture.write(`outside/file-${index}.ts`, 'export {};\n');
    }
    fixture.commit('five outside files');
    const base = git(fixture.root, 'rev-parse', 'HEAD~1').trim();

    const run = runBundledAction(fixture.root, {
      eventName: 'pull_request',
      payload: { pull_request: { base: { sha: base }, head: { sha: fixture.head() } } },
      sha: fixture.head(),
      inputs: { mode: 'single', spec: VERIFY_SPEC, 'annotation-limit': '2', 'fail-on': 'never' },
    });
    expect(run.code).toBe(0);
    const annotationLines = run.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith('::warning') || line.startsWith('::error'));
    const limited = annotationLines.filter((line) => line.includes('SBV005'));
    expect(limited).toHaveLength(2);
    expect(run.stdout).toContain('annotation limit');
  });

  it('rejects invalid inputs with a clear failure', () => {
    const fixture = setupVerifyFixture();
    const run = runBundledAction(fixture.root, {
      eventName: 'pull_request',
      payload: { pull_request: { base: { sha: fixture.head() }, head: { sha: fixture.head() } } },
      sha: fixture.head(),
      inputs: { mode: 'nonsense' },
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('single, changed, all');
  });
});
