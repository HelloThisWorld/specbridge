import { rmSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSpecState } from '@specbridge/core';
import { allDiagnostics, ruleIds, setupVerifyFixture, VERIFY_SPEC } from '../helpers-verify.js';

/**
 * End-to-end rule behavior over real git fixtures. Each scenario builds a
 * fresh temp repository; verification runs the actual engine.
 */

describe('clean verification', () => {
  it('an approved, unchanged spec with a clean tree passes with no findings', async () => {
    const fixture = setupVerifyFixture();
    const result = await fixture.verify();
    expect(result.exitCode).toBe(0);
    expect(result.report.summary.result).toBe('passed');
    expect(allDiagnostics(result)).toHaveLength(0);
    expect(result.report.specResults[0]?.managed).toBe(true);
  });
});

describe('SBV001 — required spec file missing', () => {
  it('flags each missing document of a feature spec', async () => {
    const fixture = setupVerifyFixture({ approve: false });
    rmSync(path.join(fixture.root, '.kiro', 'specs', VERIFY_SPEC, 'design.md'));
    fixture.commit('remove design');
    const result = await fixture.verify();
    const findings = allDiagnostics(result).filter((d) => d.ruleId === 'SBV001');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('error');
    expect(findings[0]?.file?.path).toBe(`.kiro/specs/${VERIFY_SPEC}/design.md`);
    expect(result.exitCode).toBe(1);
  });
});

describe('SBV002/SBV003 — approval drift', () => {
  it('detects a stale requirements approval and the invalidated dependents', async () => {
    const fixture = setupVerifyFixture();
    fixture.write(
      `.kiro/specs/${VERIFY_SPEC}/requirements.md`,
      `${fixture.read(`.kiro/specs/${VERIFY_SPEC}/requirements.md`)}\nNew requirement paragraph.\n`,
    );
    const result = await fixture.verify();
    const ids = ruleIds(result);
    expect(ids).toContain('SBV002');
    expect(ids).toContain('SBV003'); // design + tasks depend on requirements
    expect(result.exitCode).toBe(1);
  });

  it('detects a stale design approval', async () => {
    const fixture = setupVerifyFixture();
    fixture.write(
      `.kiro/specs/${VERIFY_SPEC}/design.md`,
      fixture.read(`.kiro/specs/${VERIFY_SPEC}/design.md`).replace('## Overview', '## Overview (edited)'),
    );
    const result = await fixture.verify();
    const sbv002 = allDiagnostics(result).filter((d) => d.ruleId === 'SBV002');
    expect(sbv002.some((d) => d.message.includes('design'))).toBe(true);
  });

  it('checkbox-only progress does NOT trip SBV002 (hash semantics v2)', async () => {
    const fixture = setupVerifyFixture();
    fixture.checkTask('1');
    const result = await fixture.verify();
    expect(ruleIds(result)).not.toContain('SBV002');
    // The checked task without evidence is still reported, deliberately.
    expect(ruleIds(result)).toContain('SBV004');
  });
});

describe('SBV004 — completed task lacks verified evidence', () => {
  it('warns by default and errors when the policy requires evidence', async () => {
    const fixture = setupVerifyFixture();
    fixture.checkTask('1');
    const asWarning = await fixture.verify();
    const warning = allDiagnostics(asWarning).find((d) => d.ruleId === 'SBV004');
    expect(warning?.severity).toBe('warning');
    expect(warning?.taskId).toBe('1');
    expect(asWarning.exitCode).toBe(0);

    fixture.writePolicy({ requireVerifiedTaskEvidence: true });
    const asError = await fixture.verify();
    expect(allDiagnostics(asError).find((d) => d.ruleId === 'SBV004')?.severity).toBe('error');
    expect(asError.exitCode).toBe(1);
  });

  it('accepts a checked task with valid verified evidence', async () => {
    const fixture = setupVerifyFixture();
    fixture.checkTask('1');
    fixture.writeVerifiedEvidence('1');
    const result = await fixture.verify();
    expect(ruleIds(result)).not.toContain('SBV004');
    expect(result.report.specResults[0]?.evidence.valid).toBe(1);
  });
});

describe('SBV005 — impact areas', () => {
  it('matching files pass; outside files warn in advisory and fail in strict', async () => {
    const fixture = setupVerifyFixture();
    fixture.writePolicy({ impactAreas: ['src/**'] });
    fixture.write('src/inside.ts', 'export {};\n');
    const inside = await fixture.verify();
    expect(ruleIds(inside)).not.toContain('SBV005');

    fixture.write('billing/outside.ts', 'export {};\n');
    const advisory = await fixture.verify();
    const warning = allDiagnostics(advisory).find((d) => d.ruleId === 'SBV005');
    expect(warning?.severity).toBe('warning');
    expect(warning?.file?.path).toBe('billing/outside.ts');
    expect(advisory.exitCode).toBe(0);

    const strict = await fixture.verify({ strict: true });
    expect(allDiagnostics(strict).find((d) => d.ruleId === 'SBV005')?.severity).toBe('error');
    expect(strict.exitCode).toBe(1);
  });

  it('handles renames and deletions of files outside the areas', async () => {
    const fixture = setupVerifyFixture();
    fixture.writePolicy({ impactAreas: ['src/**'] });
    fixture.write('billing/legacy.ts', 'export {};\n');
    fixture.commit('add legacy');
    rmSync(path.join(fixture.root, 'billing', 'legacy.ts'));
    const result = await fixture.verify();
    const finding = allDiagnostics(result).find((d) => d.ruleId === 'SBV005');
    expect(finding?.file?.path).toBe('billing/legacy.ts');
  });
});

describe('SBV006 — protected paths', () => {
  it('flags config.json changes as errors', async () => {
    const fixture = setupVerifyFixture({ config: { verificationCommands: [] } });
    fixture.commit('config baseline');
    fixture.write('.specbridge/config.json', '{"schemaVersion":"1.0.0","defaultRunner":"mock"}\n');
    const result = await fixture.verify();
    const finding = allDiagnostics(result).find(
      (d) => d.ruleId === 'SBV006' && d.file?.path === '.specbridge/config.json',
    );
    expect(finding?.severity).toBe('error');
    expect(result.exitCode).toBe(1);
  });

  it('exempts the verified spec’s own files but flags other specs’ .kiro files', async () => {
    const fixture = setupVerifyFixture();
    // Another spec's file changes while verifying settings-persistence only.
    fixture.write('.kiro/specs/other-spec/requirements.md', '# Requirements Document\n');
    // The verified spec's own requirements change too (spec authoring).
    fixture.write(
      `.kiro/specs/${VERIFY_SPEC}/requirements.md`,
      `${fixture.read(`.kiro/specs/${VERIFY_SPEC}/requirements.md`)}\nEdited.\n`,
    );
    const result = await fixture.verify();
    const findings = allDiagnostics(result).filter((d) => d.ruleId === 'SBV006');
    const otherSpec = findings.find((d) => d.file?.path.startsWith('.kiro/specs/other-spec/'));
    expect(otherSpec?.severity).toBe('error');
    const ownSpec = findings.find((d) =>
      d.file?.path.startsWith(`.kiro/specs/${VERIFY_SPEC}/`),
    );
    expect(ownSpec?.severity).toBe('info'); // sanctioned authoring; SBV002 governs it
    expect(ruleIds(result)).toContain('SBV002');
  });

  it('checkbox-only tasks.md progress is reported as expected progress', async () => {
    const fixture = setupVerifyFixture();
    fixture.checkTask('1');
    const result = await fixture.verify();
    const finding = allDiagnostics(result).find(
      (d) => d.ruleId === 'SBV006' && d.file?.path.endsWith('tasks.md'),
    );
    expect(finding?.severity).toBe('info');
    expect(finding?.message).toContain('checkbox-only');
    expect(ruleIds(result)).not.toContain('SBV023');
  });
});

describe('SBV007/SBV008/SBV009/SBV010 — traceability', () => {
  it('an unreferenced requirement triggers SBV007 (configurable to error)', async () => {
    const fixture = setupVerifyFixture({ approve: false });
    fixture.write(
      `.kiro/specs/${VERIFY_SPEC}/requirements.md`,
      `${fixture.read(`.kiro/specs/${VERIFY_SPEC}/requirements.md`)}
### Requirement 2: Unimplemented extra

#### Acceptance Criteria

1. WHEN nothing references this THEN verification SHALL flag it.
`,
    );
    const result = await fixture.verify();
    const finding = allDiagnostics(result).find((d) => d.ruleId === 'SBV007');
    expect(finding?.severity).toBe('warning');
    expect(finding?.requirementId).toBe('2');

    fixture.writePolicy({ requireRequirementTaskLinks: true });
    const strict = await fixture.verify();
    expect(allDiagnostics(strict).find((d) => d.ruleId === 'SBV007')?.severity).toBe('error');
  });

  it('a linked plan with an unlinked implementation task triggers SBV008 (heuristic warning)', async () => {
    const fixture = setupVerifyFixture({ approve: false });
    fixture.write(
      `.kiro/specs/${VERIFY_SPEC}/tasks.md`,
      `${fixture.read(`.kiro/specs/${VERIFY_SPEC}/tasks.md`)}
- [ ] 5. Implement the audit hook
`,
    );
    const result = await fixture.verify();
    const finding = allDiagnostics(result).find((d) => d.ruleId === 'SBV008');
    expect(finding?.taskId).toBe('5');
    expect(finding?.severity).toBe('warning');
  });

  it('documentation-style tasks are excluded from SBV008', async () => {
    const fixture = setupVerifyFixture({ approve: false });
    fixture.write(
      `.kiro/specs/${VERIFY_SPEC}/tasks.md`,
      `${fixture.read(`.kiro/specs/${VERIFY_SPEC}/tasks.md`)}
- [ ] 5. Update documentation for the release
`,
    );
    const result = await fixture.verify();
    expect(allDiagnostics(result).filter((d) => d.ruleId === 'SBV008')).toHaveLength(0);
  });

  it('a task referencing an unknown requirement triggers SBV009 with the source line', async () => {
    const fixture = setupVerifyFixture({ approve: false });
    fixture.write(
      `.kiro/specs/${VERIFY_SPEC}/tasks.md`,
      fixture
        .read(`.kiro/specs/${VERIFY_SPEC}/tasks.md`)
        .replace('_Requirements: 1.2_', '_Requirements: 7.7_'),
    );
    const result = await fixture.verify();
    const findings = allDiagnostics(result).filter((d) => d.ruleId === 'SBV009');
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]?.severity).toBe('error');
    expect(findings[0]?.file?.line).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
  });

  it('a completed parent with open children triggers SBV010', async () => {
    const fixture = setupVerifyFixture({ approve: false });
    fixture.write(
      `.kiro/specs/${VERIFY_SPEC}/tasks.md`,
      fixture
        .read(`.kiro/specs/${VERIFY_SPEC}/tasks.md`)
        .replace('- [ ] 2. Add automated tests', '- [x] 2. Add automated tests'),
    );
    const result = await fixture.verify();
    const finding = allDiagnostics(result).find((d) => d.ruleId === 'SBV010');
    expect(finding?.taskId).toBe('2');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('2.1');
  });
});

describe('SBV011/SBV015 — evidence freshness', () => {
  it('evidence recorded against an older task plan goes stale after a plan edit (SBV015)', async () => {
    const fixture = setupVerifyFixture();
    fixture.checkTask('1');
    fixture.writeVerifiedEvidence('1');
    fixture.commit('progress with evidence');

    // Edit the plan and re-approve (sanctioned change) — the evidence now
    // describes an older approved plan.
    fixture.write(
      `.kiro/specs/${VERIFY_SPEC}/tasks.md`,
      fixture
        .read(`.kiro/specs/${VERIFY_SPEC}/tasks.md`)
        .replace('3. Verify the full workflow end to end', '3. Verify everything end to end'),
    );
    const { approveAllStages } = await import('../helpers-execution.js');
    approveAllStages(fixture.workspace, VERIFY_SPEC, fixture.clock);

    const result = await fixture.verify();
    const ids = ruleIds(result);
    expect(ids).toContain('SBV015');
    expect(result.report.specResults[0]?.evidence.stale).toBe(1);
    expect(result.exitCode).toBe(1);
  });

  it('renaming the checked task itself makes its evidence stale (SBV011)', async () => {
    const fixture = setupVerifyFixture();
    fixture.checkTask('1');
    fixture.writeVerifiedEvidence('1');
    fixture.write(
      `.kiro/specs/${VERIFY_SPEC}/tasks.md`,
      fixture
        .read(`.kiro/specs/${VERIFY_SPEC}/tasks.md`)
        .replace('1. Implement the settings store', '1. Implement the storage layer'),
    );
    const result = await fixture.verify();
    expect(ruleIds(result)).toContain('SBV011');
    const finding = allDiagnostics(result).find((d) => d.ruleId === 'SBV011');
    expect(finding?.taskId).toBe('1');
  });
});

describe('SBV016 — completion before approval', () => {
  it('flags checked tasks in a managed spec whose plan was never approved', async () => {
    const fixture = setupVerifyFixture();
    // Revoke the tasks approval, then check a box.
    const { analyzeSpec, requireSpec } = await import('@specbridge/compat-kiro');
    const { approveStage } = await import('@specbridge/workflow');
    const spec = analyzeSpec(fixture.workspace, requireSpec(fixture.workspace, VERIFY_SPEC));
    const revoked = approveStage(fixture.workspace, spec, { stage: 'tasks', revoke: true });
    expect(revoked.ok).toBe(true);
    fixture.checkTask('1');
    const result = await fixture.verify();
    const finding = allDiagnostics(result).find((d) => d.ruleId === 'SBV016');
    expect(finding?.severity).toBe('error');
    expect(finding?.taskId).toBe('1');
  });

  it('does not judge unmanaged specs', async () => {
    const fixture = setupVerifyFixture({ approve: false });
    fixture.checkTask('1');
    const result = await fixture.verify();
    expect(ruleIds(result)).not.toContain('SBV016');
    expect(readSpecState(fixture.workspace, VERIFY_SPEC).state).toBeUndefined();
  });
});

describe('SBV017 — test-required tasks', () => {
  it('warns when a test-mentioning task has valid evidence without test signals', async () => {
    const fixture = setupVerifyFixture();
    fixture.checkTask('2.1'); // "Test the successful save path"
    fixture.writeVerifiedEvidence('2.1', {
      verificationCommands: [
        { name: 'build', argv: [process.execPath, '-e', '0'], required: true, exitCode: 0, durationMs: 5, passed: true },
      ],
      changedFiles: [
        { path: 'src/settings.txt', changeType: 'modified', preExisting: true, modifiedDuringRun: true },
      ],
    });
    const warning = await fixture.verify();
    const finding = allDiagnostics(warning).find((d) => d.ruleId === 'SBV017');
    expect(finding?.severity).toBe('warning');
    expect(finding?.taskId).toBe('2.1');

    fixture.writePolicy({ requireTestEvidence: true });
    const strict = await fixture.verify();
    expect(allDiagnostics(strict).find((d) => d.ruleId === 'SBV017')?.severity).toBe('error');
  });

  it('is satisfied by a passing test command or changed test files', async () => {
    const fixture = setupVerifyFixture();
    fixture.checkTask('2.1');
    fixture.writeVerifiedEvidence('2.1', {
      changedFiles: [
        { path: 'tests/settings.test.ts', changeType: 'added', preExisting: false, modifiedDuringRun: true },
      ],
      verificationCommands: [],
    });
    const result = await fixture.verify();
    expect(ruleIds(result)).not.toContain('SBV017');
  });
});

describe('SBV018 — design path references', () => {
  it('warns for explicitly referenced repository paths that do not exist', async () => {
    const fixture = setupVerifyFixture({ approve: false });
    fixture.write(
      `.kiro/specs/${VERIFY_SPEC}/design.md`,
      `${fixture.read(`.kiro/specs/${VERIFY_SPEC}/design.md`)}
The store implementation lives in \`src/settings/store.ts\`.
The existing scratch file is \`src/settings.txt\`.
`,
    );
    const result = await fixture.verify();
    const findings = allDiagnostics(result).filter((d) => d.ruleId === 'SBV018');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('src/settings/store.ts');
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.file?.line).toBeGreaterThan(0);
  });
});

describe('SBV019 — changed files missing from evidence', () => {
  it('warns when valid evidence exists but a changed file is not represented', async () => {
    const fixture = setupVerifyFixture();
    fixture.checkTask('1');
    fixture.writeVerifiedEvidence('1'); // records src/settings.txt only
    fixture.write('src/extra-edit.ts', 'export {};\n');
    const result = await fixture.verify();
    const findings = allDiagnostics(result).filter((d) => d.ruleId === 'SBV019');
    expect(findings.some((d) => d.file?.path === 'src/extra-edit.ts')).toBe(true);
    expect(findings.every((d) => d.severity === 'warning')).toBe(true);
  });
});

describe('SBV020 — invalid policy', () => {
  it('reports the invalid policy and exits 2 while verifying with defaults', async () => {
    const fixture = setupVerifyFixture();
    fixture.write(`.specbridge/policies/${VERIFY_SPEC}.json`, '{ broken json');
    const result = await fixture.verify();
    const finding = allDiagnostics(result).find((d) => d.ruleId === 'SBV020');
    expect(finding?.severity).toBe('error');
    expect(result.exitCode).toBe(2);
  });
});

describe('SBV021 — comparison unavailable', () => {
  it('reports the unresolvable base with fetch guidance and exits 3', async () => {
    const fixture = setupVerifyFixture();
    const result = await fixture.verify({
      comparison: { mode: 'diff', base: 'origin/missing-branch', head: 'HEAD' },
    });
    const finding = allDiagnostics(result).find((d) => d.ruleId === 'SBV021');
    expect(finding?.severity).toBe('error');
    expect(result.report.summary.result).toBe('failed');
    expect(result.exitCode).toBe(3);
  });
});

describe('SBV023 — task plan changed in the comparison', () => {
  it('flags plan-text edits in the diff and accepts checkbox-only diffs', async () => {
    const fixture = setupVerifyFixture();
    fixture.write(
      `.kiro/specs/${VERIFY_SPEC}/tasks.md`,
      fixture
        .read(`.kiro/specs/${VERIFY_SPEC}/tasks.md`)
        .replace('Implement the settings store', 'Implement the settings store DIFFERENTLY'),
    );
    const result = await fixture.verify();
    expect(ruleIds(result)).toContain('SBV023');
    const finding = allDiagnostics(result).find((d) => d.ruleId === 'SBV023');
    expect(finding?.severity).toBe('error');
  });
});

describe('SBV024 — evidence outside the repository', () => {
  it('flags records whose changed files escape the repository', async () => {
    const fixture = setupVerifyFixture();
    fixture.checkTask('1');
    fixture.writeVerifiedEvidence('1', {
      changedFiles: [
        { path: '../outside/file.ts', changeType: 'modified', preExisting: false, modifiedDuringRun: true },
      ],
    });
    const result = await fixture.verify();
    const finding = allDiagnostics(result).find((d) => d.ruleId === 'SBV024');
    expect(finding?.severity).toBe('error');
    expect(finding?.taskId).toBe('1');
    // The record is invalid, so the completed task also lacks usable evidence.
    expect(ruleIds(result)).toContain('SBV004');
  });
});

describe('manual acceptance', () => {
  it('valid manual acceptance satisfies evidence rules and is labelled', async () => {
    const fixture = setupVerifyFixture();
    fixture.checkTask('1');
    fixture.writeVerifiedEvidence('1', {
      status: 'manually-accepted',
      manualAcceptance: {
        actor: 'local-user',
        reason: 'verified by hand in the dev environment',
        acceptedAt: fixture.clock().toISOString(),
      },
      verificationCommands: [],
      verificationSkipped: true,
    });
    const result = await fixture.verify();
    expect(ruleIds(result)).not.toContain('SBV004');
    expect(result.report.specResults[0]?.evidence.manuallyAccepted).toBe(1);
    expect(result.report.specResults[0]?.evidence.valid).toBe(1);
  });
});
