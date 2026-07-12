import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { verificationReportSchema } from '@specbridge/core';
import { resolveAffectedSpecs, resolveComparison } from '@specbridge/drift';
import { failingCommand, passingCommand } from '../helpers-execution.js';
import { allDiagnostics, ruleIds, setupVerifyFixture, VERIFY_SPEC } from '../helpers-verify.js';

/**
 * Orchestration-level behavior: trusted command execution and reuse,
 * affected-spec resolution, exit codes, and the read-only guarantee.
 */

function timeoutCommand(name = 'slow'): Record<string, unknown> {
  return {
    name,
    argv: [process.execPath, '-e', 'setTimeout(() => {}, 30_000)'],
    timeoutMs: 1_000,
    required: true,
  };
}

function spawnFailCommand(name = 'ghost'): Record<string, unknown> {
  return {
    name,
    argv: ['definitely-not-a-real-executable-specbridge'],
    timeoutMs: 5_000,
    required: true,
  };
}

describe('trusted verification commands', () => {
  it('policy-required commands run by default and pass (SBV012 stays quiet)', async () => {
    const fixture = setupVerifyFixture({ config: { verificationCommands: [passingCommand('test')] } });
    fixture.writePolicy({ requiredVerificationCommands: ['test'] });
    const result = await fixture.verify();
    expect(ruleIds(result)).not.toContain('SBV012');
    const command = result.report.verificationCommands.find((c) => c.name === 'test');
    expect(command?.disposition).toBe('executed');
    expect(command?.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    // Command logs and report.json are stored under the artifacts directory.
    expect(result.artifactsDir).toBeDefined();
    const commandLogs = readdirSync(path.join(result.artifactsDir as string, 'commands'));
    expect(commandLogs).toContain('test.stdout.log');
    expect(readFileSync(path.join(result.artifactsDir as string, 'report.json'), 'utf8')).toContain(
      '"schemaVersion"',
    );
  });

  it('a failing required command triggers SBV012 and fails verification', async () => {
    const fixture = setupVerifyFixture({ config: { verificationCommands: [failingCommand('test')] } });
    fixture.writePolicy({ requiredVerificationCommands: ['test'] });
    const result = await fixture.verify();
    const finding = allDiagnostics(result).find((d) => d.ruleId === 'SBV012');
    expect(finding?.severity).toBe('error');
    expect(result.exitCode).toBe(1);
  });

  it('a failing optional command warns without failing (--run-verification)', async () => {
    const fixture = setupVerifyFixture({
      config: { verificationCommands: [passingCommand('test'), failingCommand('lint', false)] },
    });
    const result = await fixture.verify({ runVerification: true });
    expect(ruleIds(result)).not.toContain('SBV012');
    const lint = result.report.verificationCommands.find((c) => c.name === 'lint');
    expect(lint?.passed).toBe(false);
    expect(lint?.required).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it('a missing required command name triggers SBV013', async () => {
    const fixture = setupVerifyFixture({ config: { verificationCommands: [passingCommand('test')] } });
    fixture.writePolicy({ requiredVerificationCommands: ['typecheck'] });
    const result = await fixture.verify();
    const finding = allDiagnostics(result).find((d) => d.ruleId === 'SBV013');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('typecheck');
    expect(result.exitCode).toBe(1);
  });

  it('a required command timeout triggers SBV025 and exit code 5', async () => {
    const fixture = setupVerifyFixture({ config: { verificationCommands: [timeoutCommand('slow')] } });
    fixture.writePolicy({ requiredVerificationCommands: ['slow'] });
    const result = await fixture.verify();
    const finding = allDiagnostics(result).find((d) => d.ruleId === 'SBV025');
    expect(finding?.severity).toBe('error');
    expect(result.exitCode).toBe(5);
  });

  it('a required command that cannot start exits with code 4', async () => {
    const fixture = setupVerifyFixture({ config: { verificationCommands: [spawnFailCommand('ghost')] } });
    fixture.writePolicy({ requiredVerificationCommands: ['ghost'] });
    const result = await fixture.verify();
    expect(ruleIds(result)).toContain('SBV012');
    expect(result.exitCode).toBe(4);
  });

  it('--no-run-verification reuses passing results from fresh evidence at HEAD', async () => {
    const fixture = setupVerifyFixture({ config: { verificationCommands: [passingCommand('test')] } });
    fixture.checkTask('1');
    fixture.writeVerifiedEvidence('1'); // records a passing "test" at current HEAD
    fixture.commit('progress'); // moves HEAD → evidence no longer reusable
    fixture.writeVerifiedEvidence('2.1'); // fresh evidence at the new HEAD
    fixture.writePolicy({ requiredVerificationCommands: ['test'] });

    const result = await fixture.verify({ runVerification: false });
    const command = result.report.verificationCommands.find((c) => c.name === 'test');
    expect(command?.disposition).toBe('reused-evidence');
    expect(command?.passed).toBe(true);
    expect(ruleIds(result)).not.toContain('SBV012');
  });

  it('--no-run-verification without reusable evidence fails the required command honestly', async () => {
    const fixture = setupVerifyFixture({ config: { verificationCommands: [passingCommand('test')] } });
    fixture.writePolicy({ requiredVerificationCommands: ['test'] });
    const result = await fixture.verify({ runVerification: false });
    const command = result.report.verificationCommands.find((c) => c.name === 'test');
    expect(command?.disposition).toBe('not-run');
    expect(command?.passed).toBe(false);
    const finding = allDiagnostics(result).find((d) => d.ruleId === 'SBV012');
    expect(finding?.message).toContain('did not run');
    expect(result.exitCode).toBe(1);
  });
});

describe('affected-spec resolution', () => {
  it('maps changed files through every documented signal deterministically', async () => {
    const fixture = setupVerifyFixture();
    // Second spec with an impact area overlapping the first's.
    fixture.write(
      '.kiro/specs/email-delivery/requirements.md',
      '# Requirements Document\n\n### Requirement 1: Deliver email\n\n#### Acceptance Criteria\n\n1. WHEN sending THEN the system SHALL deliver.\n',
    );
    fixture.write('.kiro/specs/email-delivery/design.md', '# Design Document\n\nSee `src/shared/logger.ts`.\n');
    fixture.write('.kiro/specs/email-delivery/tasks.md', '# Implementation Plan\n\n- [ ] 1. Send email\n  - _Requirements: 1.1_\n');
    fixture.write(
      '.specbridge/policies/email-delivery.json',
      JSON.stringify({ schemaVersion: '1.0.0', specName: 'email-delivery', impactAreas: ['src/shared/**'] }),
    );
    fixture.writePolicy({ impactAreas: ['src/shared/**', 'src/settings/**'] });
    fixture.commit('two specs');

    fixture.write('src/shared/logger.ts', 'export const log = 1;\n'); // both specs
    fixture.write(`.kiro/specs/${VERIFY_SPEC}/notes.md`, 'note\n'); // spec files signal
    fixture.write('src/orphan/widget.ts', 'export {};\n'); // unmapped

    const comparison = await resolveComparison(fixture.root, { mode: 'working-tree' });
    expect(comparison.ok).toBe(true);
    const affected = resolveAffectedSpecs(fixture.workspace, comparison.changedFiles);

    expect(affected.affected.map((spec) => spec.specName)).toEqual([
      'email-delivery',
      VERIFY_SPEC,
    ]);
    const emailMatches = affected.affected[0]?.matches ?? [];
    expect(emailMatches.some((match) => match.via.some((via) => via.includes('impact area')))).toBe(true);
    expect(
      affected.affected[1]?.matches.some((match) => match.via.includes('spec files')),
    ).toBe(true);
    expect(affected.unmapped.map((file) => file.path)).toEqual(['src/orphan/widget.ts']);
    expect(affected.ambiguous[0]?.path).toBe('src/shared/logger.ts');
    expect(affected.ambiguous[0]?.specs.map((spec) => spec.name)).toEqual([
      'email-delivery',
      VERIFY_SPEC,
    ]);
  });

  it('evidence maps changed files to their spec', async () => {
    const fixture = setupVerifyFixture();
    fixture.writeVerifiedEvidence('1', {
      changedFiles: [
        { path: 'src/evidence-owned.ts', changeType: 'added', preExisting: false, modifiedDuringRun: true },
      ],
    });
    fixture.write('src/evidence-owned.ts', 'export {};\n');
    const comparison = await resolveComparison(fixture.root, { mode: 'working-tree' });
    const affected = resolveAffectedSpecs(fixture.workspace, comparison.changedFiles);
    const spec = affected.affected.find((entry) => entry.specName === VERIFY_SPEC);
    expect(spec?.matches.some((match) => match.via.includes('task evidence'))).toBe(true);
  });

  it('changed-mode verification emits SBV014 and SBV022 for unmapped and shared files', async () => {
    const fixture = setupVerifyFixture();
    fixture.writePolicy({ impactAreas: ['src/settings/**'] });
    fixture.write('src/orphan/widget.ts', 'export {};\n');
    fixture.write('src/settings/store.ts', 'export {};\n');
    const result = await fixture.verify({ selection: { mode: 'changed' } });
    const unmapped = allDiagnostics(result).filter((d) => d.ruleId === 'SBV014');
    expect(unmapped.some((d) => d.file?.path === 'src/orphan/widget.ts')).toBe(true);
    expect(result.report.selection.specs).toEqual([VERIFY_SPEC]);
    expect(result.report.specResults[0]?.matchedBy.length).toBeGreaterThan(0);
  });

  it('--all verifies every spec with deterministic ordering', async () => {
    const fixture = setupVerifyFixture();
    fixture.write(
      '.kiro/specs/aaa-first/requirements.md',
      '# Requirements Document\n\n### Requirement 1: Sort first\n\n#### Acceptance Criteria\n\n1. WHEN listed THEN it SHALL sort first.\n',
    );
    fixture.write('.kiro/specs/aaa-first/design.md', '# Design Document\n');
    fixture.write('.kiro/specs/aaa-first/tasks.md', '# Implementation Plan\n\n- [ ] 1. Do it\n  - _Requirements: 1.1_\n');
    fixture.commit('another spec');
    const result = await fixture.verify({ selection: { mode: 'all' } });
    expect(result.report.selection.specs).toEqual(['aaa-first', VERIFY_SPEC]);
  });
});

describe('report integrity and the read-only guarantee', () => {
  it('reports validate against the versioned schema and sort diagnostics deterministically', async () => {
    const fixture = setupVerifyFixture();
    fixture.writePolicy({ impactAreas: ['src/settings/**'] });
    fixture.checkTask('1');
    fixture.write('outside/a.ts', 'export {};\n');
    fixture.write('outside/b.ts', 'export {};\n');
    const result = await fixture.verify();
    expect(() => verificationReportSchema.parse(result.report)).not.toThrow();
    const diagnostics = result.report.specResults[0]?.diagnostics ?? [];
    const severityRank = { error: 0, warning: 1, info: 2 } as const;
    for (let i = 1; i < diagnostics.length; i += 1) {
      const previous = diagnostics[i - 1]!;
      const current = diagnostics[i]!;
      expect(severityRank[previous.severity]).toBeLessThanOrEqual(severityRank[current.severity]);
    }
    // Two identical runs produce identical diagnostics (id and timestamp injected).
    const again = await fixture.verify();
    expect(JSON.stringify(again.report.specResults[0]?.diagnostics)).toBe(
      JSON.stringify(result.report.specResults[0]?.diagnostics),
    );
  });

  it('verification without command runs writes nothing at all', async () => {
    const fixture = setupVerifyFixture();
    fixture.checkTask('1');
    fixture.writeVerifiedEvidence('1');
    fixture.writePolicy({ impactAreas: ['src/**'] });

    const snapshot = hashTree(fixture.root);
    const result = await fixture.verify();
    expect(result.artifactsDir).toBeUndefined();
    expect(hashTree(fixture.root)).toEqual(snapshot);
  });

  it('command execution writes only under the reports directory', async () => {
    const fixture = setupVerifyFixture({ config: { verificationCommands: [passingCommand('test')] } });
    fixture.writePolicy({ requiredVerificationCommands: ['test'] });
    const before = hashTree(fixture.root, ['.specbridge/reports']);
    const result = await fixture.verify();
    expect(result.artifactsDir).toBeDefined();
    expect(path.relative(fixture.root, result.artifactsDir as string).split(path.sep)[0]).toBe(
      '.specbridge',
    );
    const after = hashTree(fixture.root, ['.specbridge/reports']);
    expect(after).toEqual(before);
  });
});

/** SHA-256 of every file under root (sorted map), skipping .git and excluded prefixes. */
function hashTree(root: string, excludePrefixes: string[] = []): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (relative === '.git' || relative.startsWith('.git/')) continue;
      if (excludePrefixes.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        const stats = statSync(absolute);
        result[relative] = `${stats.size}:${createHash('sha256').update(readFileSync(absolute)).digest('hex')}`;
      }
    }
  };
  walk(root);
  return result;
}
