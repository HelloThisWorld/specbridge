import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../packages/cli/src/cli';
import { setupVerifyFixture, VERIFY_SPEC } from '../helpers-verify.js';
import { FIXED_NOW } from '../helpers.js';

/**
 * End-to-end CLI tests for the v0.4 verification commands. Everything runs
 * in-process against temp git fixtures.
 */

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(cwd: string, ...argv: string[]): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    cwd,
    out: (line) => stdout.push(`${line}\n`),
    outRaw: (text) => stdout.push(text),
    err: (line) => stderr.push(`${line}\n`),
    now: () => FIXED_NOW,
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

describe('spec verify — selection and comparison options', () => {
  it('verifies a named spec against the working tree by default', async () => {
    const fixture = setupVerifyFixture();
    const result = await cli(fixture.root, 'spec', 'verify', VERIFY_SPEC);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Spec Drift Verification');
    expect(result.stdout).toContain('working tree vs HEAD');
    expect(result.stdout).toContain('PASSED');
  });

  it('rejects combined selection modes and missing selection', async () => {
    const fixture = setupVerifyFixture();
    const combined = await cli(fixture.root, 'spec', 'verify', VERIFY_SPEC, '--all');
    expect(combined.code).toBe(2);
    expect(combined.stderr).toContain('mutually exclusive');

    const none = await cli(fixture.root, 'spec', 'verify');
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('--changed');
  });

  it('rejects combined comparison modes', async () => {
    const fixture = setupVerifyFixture();
    const result = await cli(
      fixture.root,
      'spec',
      'verify',
      VERIFY_SPEC,
      '--working-tree',
      '--staged',
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('mutually exclusive');
  });

  it('supports --staged and --diff explicitly', async () => {
    const fixture = setupVerifyFixture();
    fixture.write('src/staged.ts', 'export {};\n');
    const { git } = await import('../helpers-execution.js');
    git(fixture.root, 'add', 'src/staged.ts');

    const staged = await cli(fixture.root, 'spec', 'verify', VERIFY_SPEC, '--staged');
    expect(staged.code).toBe(0);
    expect(staged.stdout).toContain('staged changes vs HEAD');

    const diff = await cli(fixture.root, 'spec', 'verify', VERIFY_SPEC, '--diff', 'HEAD...HEAD');
    expect(diff.code).toBe(0);
    expect(diff.stdout).toContain('HEAD...HEAD');
  });

  it('fails clearly on invalid git refs', async () => {
    const fixture = setupVerifyFixture();
    const hostile = await cli(fixture.root, 'spec', 'verify', VERIFY_SPEC, '--diff', '--evil...HEAD');
    expect(hostile.code).toBe(2);

    const missing = await cli(
      fixture.root,
      'spec',
      'verify',
      VERIFY_SPEC,
      '--diff',
      'origin/nope...HEAD',
    );
    expect(missing.code).toBe(3);
    expect(missing.stdout).toContain('SBV021');
  });

  it('--changed and --all selections work end to end', async () => {
    const fixture = setupVerifyFixture();
    fixture.writePolicy({ impactAreas: ['src/settings/**'] });
    fixture.write('src/settings/store.ts', 'export {};\n');
    const changed = await cli(fixture.root, 'spec', 'verify', '--changed');
    expect(changed.code).toBe(0);
    expect(changed.stdout).toContain(VERIFY_SPEC);

    const all = await cli(fixture.root, 'spec', 'verify', '--all');
    expect(all.code).toBe(0);
  });
});

describe('spec verify — output formats and thresholds', () => {
  it('--json emits a schema-valid report on stdout with no progress noise', async () => {
    const fixture = setupVerifyFixture();
    const result = await cli(fixture.root, 'spec', 'verify', VERIFY_SPEC, '--json');
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { schemaVersion: string; summary: { result: string } };
    expect(parsed.schemaVersion).toBe('1.0.0');
    expect(parsed.summary.result).toBe('passed');
  });

  it('--format markdown and html write self-contained reports via --output', async () => {
    const fixture = setupVerifyFixture();
    const markdown = await cli(
      fixture.root,
      'spec',
      'verify',
      VERIFY_SPEC,
      '--format',
      'markdown',
      '--output',
      'report.md',
    );
    expect(markdown.code).toBe(0);
    const markdownContent = readFileSync(path.join(fixture.root, 'report.md'), 'utf8');
    expect(markdownContent).toContain('# SpecBridge Verification');
    expect(markdownContent).toContain('**Result:**');

    const html = await cli(
      fixture.root,
      'spec',
      'verify',
      VERIFY_SPEC,
      '--format',
      'html',
      '--output',
      'report.html',
    );
    expect(html.code).toBe(0);
    const htmlContent = readFileSync(path.join(fixture.root, 'report.html'), 'utf8');
    expect(htmlContent).toContain('<!doctype html>');
    expect(htmlContent).not.toContain('<script');
    expect(htmlContent).not.toMatch(/src\s*=\s*["']https?:/);
    expect(htmlContent).not.toMatch(/href\s*=\s*["']https?:/);
  });

  it('--fail-on controls the exit threshold', async () => {
    const fixture = setupVerifyFixture();
    fixture.writePolicy({ impactAreas: ['src/settings/**'] });
    fixture.write('elsewhere/file.ts', 'export {};\n'); // SBV005 warning
    expect((await cli(fixture.root, 'spec', 'verify', VERIFY_SPEC)).code).toBe(0);
    expect(
      (await cli(fixture.root, 'spec', 'verify', VERIFY_SPEC, '--fail-on', 'warning')).code,
    ).toBe(1);
    expect(
      (await cli(fixture.root, 'spec', 'verify', VERIFY_SPEC, '--fail-on', 'never')).code,
    ).toBe(0);
    expect(
      (await cli(fixture.root, 'spec', 'verify', VERIFY_SPEC, '--fail-on', 'nonsense')).code,
    ).toBe(2);
  });

  it('verification through the CLI is read-only for spec, state, and evidence files', async () => {
    const fixture = setupVerifyFixture();
    fixture.checkTask('1');
    fixture.writeVerifiedEvidence('1');
    const watched = [
      `.kiro/specs/${VERIFY_SPEC}/requirements.md`,
      `.kiro/specs/${VERIFY_SPEC}/design.md`,
      `.kiro/specs/${VERIFY_SPEC}/tasks.md`,
      `.specbridge/state/specs/${VERIFY_SPEC}.json`,
    ];
    const before = watched.map((relative) => fixture.read(relative));
    const result = await cli(fixture.root, 'spec', 'verify', VERIFY_SPEC);
    expect(result.code).toBe(0);
    expect(watched.map((relative) => fixture.read(relative))).toEqual(before);
  });
});

describe('spec affected', () => {
  it('lists affected specs with match reasons and unmapped warnings', async () => {
    const fixture = setupVerifyFixture();
    fixture.writePolicy({ impactAreas: ['src/settings/**'] });
    fixture.write('src/settings/store.ts', 'export {};\n');
    fixture.write('src/common/logger.ts', 'export {};\n');
    const result = await cli(fixture.root, 'spec', 'affected', '--working-tree');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(VERIFY_SPEC);
    expect(result.stdout).toContain('impact area src/settings/**');
    expect(result.stdout).toContain('src/common/logger.ts does not map to any spec');
  });

  it('--json emits machine-readable results and never runs commands', async () => {
    const fixture = setupVerifyFixture({ config: { verificationCommands: [] } });
    fixture.commit('baseline'); // config committed
    fixture.write('src/anything.ts', 'export {};\n');
    const result = await cli(fixture.root, 'spec', 'affected', '--working-tree', '--json');
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      schema: string;
      data: { unmapped: string[]; affected: unknown[] };
    };
    expect(parsed.schema).toBe('specbridge.spec-affected/1');
    expect(parsed.data.unmapped).toContain('src/anything.ts');
    expect(existsSync(path.join(fixture.root, '.specbridge', 'reports'))).toBe(false);
  });
});

describe('spec policy', () => {
  it('init proposes areas from design paths and evidence, and never overwrites', async () => {
    const fixture = setupVerifyFixture();
    fixture.write(
      `.kiro/specs/${VERIFY_SPEC}/design.md`,
      `${fixture.read(`.kiro/specs/${VERIFY_SPEC}/design.md`)}\nThe store lives in \`src/settings/store.ts\`.\n`,
    );
    fixture.writeVerifiedEvidence('1', {
      changedFiles: [
        { path: 'tests/settings.test.ts', changeType: 'added', preExisting: false, modifiedDuringRun: true },
      ],
    });

    const dryRun = await cli(fixture.root, 'spec', 'policy', 'init', VERIFY_SPEC, '--mode', 'strict', '--dry-run');
    expect(dryRun.code).toBe(0);
    expect(dryRun.stdout).toContain('dry run');
    expect(existsSync(path.join(fixture.root, '.specbridge', 'policies', `${VERIFY_SPEC}.json`))).toBe(false);

    const real = await cli(fixture.root, 'spec', 'policy', 'init', VERIFY_SPEC, '--mode', 'strict');
    expect(real.code).toBe(0);
    const written = JSON.parse(
      readFileSync(path.join(fixture.root, '.specbridge', 'policies', `${VERIFY_SPEC}.json`), 'utf8'),
    ) as { mode: string; impactAreas: string[] };
    expect(written.mode).toBe('strict');
    expect(written.impactAreas).toContain('src/settings/**');
    expect(written.impactAreas).toContain('tests/**');

    const again = await cli(fixture.root, 'spec', 'policy', 'init', VERIFY_SPEC);
    expect(again.code).toBe(2);
    expect(again.stderr).toContain('never overwrites');
  });

  it('show and validate report the effective policy and its problems', async () => {
    const fixture = setupVerifyFixture();
    const missing = await cli(fixture.root, 'spec', 'policy', 'validate', VERIFY_SPEC);
    expect(missing.code).toBe(2);

    fixture.writePolicy({ mode: 'strict', impactAreas: ['src/**'], requiredVerificationCommands: ['test'] });
    const show = await cli(fixture.root, 'spec', 'policy', 'show', VERIFY_SPEC);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain('Mode: strict');
    expect(show.stdout).toContain('.git/**');

    // "test" is not configured — validate flags it.
    const invalid = await cli(fixture.root, 'spec', 'policy', 'validate', VERIFY_SPEC);
    expect(invalid.code).toBe(1);
    expect(invalid.stdout).toContain('SBV013');

    fixture.writePolicy({ mode: 'strict', impactAreas: ['src/**'] });
    const valid = await cli(fixture.root, 'spec', 'policy', 'validate', VERIFY_SPEC);
    expect(valid.code).toBe(0);
    expect(valid.stdout).toContain('valid');
  });
});

describe('verify rules inspection', () => {
  it('lists all 25 rules and explains one', async () => {
    const fixture = setupVerifyFixture();
    const rules = await cli(fixture.root, 'verify', 'rules');
    expect(rules.code).toBe(0);
    expect(rules.stdout).toContain('SBV001');
    expect(rules.stdout).toContain('SBV025');

    const explain = await cli(fixture.root, 'verify', 'explain', 'SBV005');
    expect(explain.code).toBe(0);
    expect(explain.stdout).toContain('warning in advisory mode, error in strict mode');
    expect(explain.stdout).toContain('Triggered when');

    const unknown = await cli(fixture.root, 'verify', 'explain', 'SBV999');
    expect(unknown.code).toBe(2);
  });
});
