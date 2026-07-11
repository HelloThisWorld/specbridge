import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../packages/cli/src/cli';
import { FIXED_NOW, copyFixtureToTemp, emptyTempDir, fixturePath } from '../helpers.js';

/**
 * End-to-end CLI tests for the v0.2 authoring and approval workflow.
 * Everything runs in-process against temp copies of fixtures.
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

function freshKiroDir(): string {
  const root = emptyTempDir();
  mkdirSync(path.join(root, '.kiro'));
  return root;
}

const VALID_REQUIREMENTS = `# Requirements Document

## Introduction

CLI end-to-end test content.

## Requirements

### Requirement 1: Behavior

**User Story:** As a user, I want predictable behavior, so that approvals mean something.

#### Acceptance Criteria

1. WHEN the action runs, THE SYSTEM SHALL produce the documented result.
2. IF the backend fails, THEN THE SYSTEM SHALL return an actionable error.

## Out of Scope

- Everything else.

## Non-Functional Requirements

- Security: authenticated users only.
`;

describe('spec new (CLI)', () => {
  it('creates a spec and prints the created files', async () => {
    const root = freshKiroDir();
    const result = await cli(
      root,
      'spec',
      'new',
      'notification-preferences',
      '--description',
      'Allow users to choose email and push notification preferences.',
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Created spec: notification-preferences');
    expect(existsSync(path.join(root, '.kiro', 'specs', 'notification-preferences', 'requirements.md'))).toBe(true);
    expect(existsSync(path.join(root, '.specbridge', 'state', 'specs', 'notification-preferences.json'))).toBe(true);
  });

  it('emits a deterministic JSON plan with --dry-run --json and writes nothing (test 8)', async () => {
    const root = freshKiroDir();
    const result = await cli(root, 'spec', 'new', 'payment-retry', '--mode', 'quick', '--dry-run', '--json');
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      schema: string;
      data: {
        dryRun: boolean;
        created: boolean;
        files: { fileName: string; content: string }[];
        state: { status: string; createdAt: string };
      };
    };
    expect(report.schema).toBe('specbridge.spec-new/1');
    expect(report.data.dryRun).toBe(true);
    expect(report.data.created).toBe(false);
    expect(report.data.files.map((f) => f.fileName).sort()).toEqual(['design.md', 'requirements.md', 'tasks.md']);
    expect(report.data.state.status).toBe('READY_FOR_REVIEW');
    expect(report.data.state.createdAt).toBe(FIXED_NOW.toISOString());
    expect(existsSync(path.join(root, '.kiro', 'specs'))).toBe(false);
    expect(existsSync(path.join(root, '.specbridge'))).toBe(false);
  });

  it('rejects invalid names with exit 2 and reasons', async () => {
    const root = freshKiroDir();
    const result = await cli(root, 'spec', 'new', 'Payment_Retry');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('lowercase');
    expect(result.stderr).toContain('underscores');
  });

  it('rejects an existing spec with exit 2 and file listing', async () => {
    const root = copyFixtureToTemp('v02-existing-kiro-no-state');
    const result = await cli(root, 'spec', 'new', 'user-authentication');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('already exists');
    expect(result.stderr).toContain('requirements.md');
  });

  it('rejects unknown --type and --mode values', async () => {
    const root = freshKiroDir();
    expect((await cli(root, 'spec', 'new', 'x-spec', '--type', 'epic')).code).toBe(2);
    expect((await cli(root, 'spec', 'new', 'x-spec', '--mode', 'yolo')).code).toBe(2);
  });
});

describe('spec analyze (CLI)', () => {
  it('exits 0 on a valid stage', async () => {
    const root = copyFixtureToTemp('v02-requirements-first');
    const result = await cli(root, 'spec', 'analyze', 'notification-preferences', '--stage', 'requirements');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Result: OK');
  });

  it('exits 1 on placeholder-heavy content with error findings', async () => {
    const root = copyFixtureToTemp('v02-placeholder-heavy');
    const result = await cli(root, 'spec', 'analyze', 'notification-preferences', '--stage', 'requirements');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Placeholder content');
    expect(result.stdout).toContain('Result: FAIL');
  });

  it('strict mode turns warnings into failure (test 50)', async () => {
    const root = copyFixtureToTemp('v02-invalid-ears');
    const relaxed = await cli(root, 'spec', 'analyze', 'session-timeout', '--stage', 'requirements');
    expect(relaxed.code).toBe(0);
    const strict = await cli(root, 'spec', 'analyze', 'session-timeout', '--stage', 'requirements', '--strict');
    expect(strict.code).toBe(1);
    expect(strict.stdout).toContain('strict mode');
  });

  it('produces machine-readable JSON with per-stage findings', async () => {
    const root = copyFixtureToTemp('v02-invalid-ears');
    const result = await cli(root, 'spec', 'analyze', 'session-timeout', '--json');
    const report = JSON.parse(result.stdout) as {
      schema: string;
      data: { stages: { stage: string; diagnostics: { code: string }[] }[]; failed: boolean };
    };
    expect(report.schema).toBe('specbridge.spec-analyze/1');
    const requirements = report.data.stages.find((s) => s.stage === 'requirements');
    expect(requirements?.diagnostics.some((d) => d.code === 'REQUIREMENTS_EARS_MALFORMED')).toBe(true);
  });

  it('rejects stages that do not apply to the spec type', async () => {
    const root = copyFixtureToTemp('v02-bugfix-spec');
    const result = await cli(root, 'spec', 'analyze', 'login-timeout-fix', '--stage', 'requirements');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('does not apply');
  });
});

describe('spec approve and status (CLI)', () => {
  it('walks a full requirements-first workflow with stale detection', async () => {
    const root = freshKiroDir();
    await cli(root, 'spec', 'new', 'demo-spec');
    const requirementsPath = path.join(root, '.kiro', 'specs', 'demo-spec', 'requirements.md');

    // Placeholders block the first approval attempt (exit 1).
    const blocked = await cli(root, 'spec', 'approve', 'demo-spec', '--stage', 'requirements');
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain('Cannot approve requirements');

    writeFileSync(requirementsPath, VALID_REQUIREMENTS);
    const approved = await cli(root, 'spec', 'approve', 'demo-spec', '--stage', 'requirements');
    expect(approved.code).toBe(0);
    expect(approved.stdout).toContain('requirements approved');
    expect(approved.stdout).toContain('Status: DESIGN_DRAFT');

    // Approving out of order names the missing prerequisite (exit 1).
    const tasksTooEarly = await cli(root, 'spec', 'approve', 'demo-spec', '--stage', 'tasks');
    expect(tasksTooEarly.code).toBe(1);
    expect(tasksTooEarly.stderr).toContain('design');
    expect(tasksTooEarly.stderr).toContain('spec approve demo-spec --stage design');

    // Status shows the healthy approval.
    const status = await cli(root, 'spec', 'status', 'demo-spec');
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('Status: DESIGN_DRAFT');
    expect(status.stdout).toContain('Content unchanged since approval');

    // One byte changes -> stale.
    writeFileSync(requirementsPath, `${VALID_REQUIREMENTS}x`);
    const stale = await cli(root, 'spec', 'status', 'demo-spec');
    expect(stale.stdout).toContain('Status: STALE_APPROVAL');
    expect(stale.stdout).toContain('Modified after approval');
    expect(stale.stdout).toContain('Approved hash:');
    expect(stale.stdout).toContain('Current hash:');

    // Read-only commands must not repair the state silently.
    const stateBytes = readFileSync(
      path.join(root, '.specbridge', 'state', 'specs', 'demo-spec.json'),
    );
    await cli(root, 'spec', 'list');
    await cli(root, 'doctor');
    expect(
      readFileSync(path.join(root, '.specbridge', 'state', 'specs', 'demo-spec.json')).equals(stateBytes),
    ).toBe(true);

    // Reapproval repairs it.
    const reapproved = await cli(root, 'spec', 'approve', 'demo-spec', '--stage', 'requirements');
    expect(reapproved.code).toBe(0);
    const healthy = await cli(root, 'spec', 'status', 'demo-spec');
    expect(healthy.stdout).toContain('Status: DESIGN_DRAFT');
  });

  it('revoke reports invalidated dependents', async () => {
    const root = copyFixtureToTemp('v02-bugfix-spec');
    const revoked = await cli(root, 'spec', 'approve', 'login-timeout-fix', '--stage', 'bugfix', '--revoke');
    expect(revoked.code).toBe(0);
    expect(revoked.stdout).toContain('bugfix approval revoked');
    const status = await cli(root, 'spec', 'status', 'login-timeout-fix');
    expect(status.stdout).toContain('Status: BUGFIX_DRAFT');
  });

  it('reports unmanaged specs with a suggested first approval', async () => {
    const root = copyFixtureToTemp('v02-existing-kiro-no-state');
    const result = await cli(root, 'spec', 'status', 'user-authentication');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Approval state: unmanaged');
    expect(result.stdout).toContain('spec approve user-authentication --stage requirements');
  });

  it('initializes state on the first approval of an existing Kiro spec', async () => {
    const root = copyFixtureToTemp('v02-existing-kiro-no-state');
    const result = await cli(root, 'spec', 'approve', 'user-authentication', '--stage', 'requirements');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Sidecar state initialized');
    const status = await cli(root, 'spec', 'status', 'user-authentication');
    expect(status.stdout).toContain('Origin: initialized from an existing Kiro workspace');
  });

  it('emits versioned JSON from spec status', async () => {
    const root = copyFixtureToTemp('v02-stale-requirements-approval');
    const result = await cli(root, 'spec', 'status', 'payment-retry', '--json');
    const report = JSON.parse(result.stdout) as {
      schema: string;
      data: {
        approvalHealth: string;
        effectiveStatus: string;
        stages: { stage: string; effective: string }[];
      };
    };
    expect(report.schema).toBe('specbridge.spec-status/1');
    expect(report.data.approvalHealth).toBe('stale');
    expect(report.data.effectiveStatus).toBe('STALE_APPROVAL');
    expect(report.data.stages.find((s) => s.stage === 'requirements')?.effective).toBe(
      'modified-after-approval',
    );
    expect(report.data.stages.find((s) => s.stage === 'design')?.effective).toBe('stale-prerequisite');
  });

  it('rejects unknown stages and inapplicable stages with exit 2', async () => {
    const root = copyFixtureToTemp('v02-bugfix-spec');
    expect((await cli(root, 'spec', 'approve', 'login-timeout-fix', '--stage', 'nope')).code).toBe(2);
    expect(
      (await cli(root, 'spec', 'approve', 'login-timeout-fix', '--stage', 'requirements')).code,
    ).toBe(2);
  });
});

describe('spec list / show / doctor extensions (CLI)', () => {
  it('spec list shows MODE and STATUS columns including STALE_APPROVAL', async () => {
    const root = copyFixtureToTemp('v02-stale-requirements-approval');
    const result = await cli(root, 'spec', 'list');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('MODE');
    expect(result.stdout).toContain('STATUS');
    expect(result.stdout).toContain('requirements-first');
    expect(result.stdout).toContain('STALE_APPROVAL');
  });

  it('spec list marks unmanaged specs', async () => {
    const root = copyFixtureToTemp('v02-existing-kiro-no-state');
    const result = await cli(root, 'spec', 'list');
    expect(result.stdout).toContain('unmanaged');
    const json = await cli(root, 'spec', 'list', '--json');
    const report = JSON.parse(json.stdout) as {
      data: { specs: { name: string; approvalHealth: string; managed: boolean }[] };
    };
    expect(report.data.specs.every((s) => s.approvalHealth === 'unmanaged' && !s.managed)).toBe(true);
  });

  it('spec show --state prints the sidecar state JSON', async () => {
    const root = copyFixtureToTemp('v02-requirements-first');
    const result = await cli(root, 'spec', 'show', 'notification-preferences', '--state');
    expect(result.code).toBe(0);
    const state = JSON.parse(result.stdout) as { schemaVersion: string; specName: string };
    expect(state.schemaVersion).toBe('1.0.0');
    expect(state.specName).toBe('notification-preferences');
  });

  it('spec show --analysis and --status print focused sections', async () => {
    const root = copyFixtureToTemp('v02-requirements-first');
    const analysis = await cli(root, 'spec', 'show', 'notification-preferences', '--analysis');
    expect(analysis.code).toBe(0);
    expect(analysis.stdout).toContain('errors');

    const status = await cli(root, 'spec', 'show', 'notification-preferences', '--status');
    expect(status.stdout).toContain('DESIGN_DRAFT');
  });

  it('doctor reports invalid, orphan, and unmanaged sidecar state without repairing anything', async () => {
    const root = copyFixtureToTemp('v02-invalid-sidecar');
    const result = await cli(root, 'doctor');
    expect(result.stdout).toContain('Sidecar state (.specbridge)');
    expect(result.stdout).toContain('sidecar state is invalid');
    // Nothing was repaired or deleted.
    expect(readFileSync(path.join(root, '.specbridge', 'state', 'specs', 'broken-state.json'), 'utf8')).toBe(
      '{ this is not json\n',
    );

    const orphanRoot = copyFixtureToTemp('v02-orphan-sidecar');
    const orphan = await cli(orphanRoot, 'doctor');
    expect(orphan.stdout).toContain('ghost-spec');
    expect(orphan.stdout).toContain('no matching .kiro/specs');
    expect(orphan.stdout).toContain('unmanaged');
    expect(existsSync(path.join(orphanRoot, '.specbridge', 'state', 'specs', 'ghost-spec.json'))).toBe(true);
  });

  it('doctor JSON includes the sidecar audit block', async () => {
    const root = copyFixtureToTemp('v02-stale-requirements-approval');
    const result = await cli(root, 'doctor', '--json');
    const report = JSON.parse(result.stdout) as {
      data: { sidecar: { staleSpecs: string[]; unmanagedSpecs: string[] } };
    };
    expect(report.data.sidecar.staleSpecs).toEqual(['payment-retry']);
  });

  it('empty workspaces stay healthy and support spec new (fixture v02-empty-workspace)', async () => {
    const root = copyFixtureToTemp('v02-empty-workspace');
    const doctor = await cli(root, 'doctor');
    expect(doctor.code).toBe(0);
    const created = await cli(root, 'spec', 'new', 'first-spec');
    expect(created.code).toBe(0);
    const list = await cli(root, 'spec', 'list');
    expect(list.stdout).toContain('first-spec');
  });
});

describe('v0.1 regression guarantees (tests 51-55)', () => {
  it('manually edited specs remain byte-identical through v0.2 commands (tests 53, 54)', async () => {
    const root = copyFixtureToTemp('v02-manually-edited');
    const specDir = path.join(root, '.kiro', 'specs', 'search-filters');
    const before = new Map(
      ['requirements.md', 'notes.md'].map((f) => [f, readFileSync(path.join(specDir, f))]),
    );

    await cli(root, 'spec', 'list');
    await cli(root, 'spec', 'show', 'search-filters');
    await cli(root, 'spec', 'analyze', 'search-filters');
    await cli(root, 'spec', 'status', 'search-filters');
    await cli(root, 'doctor');

    for (const [file, bytes] of before) {
      expect(readFileSync(path.join(specDir, file)).equals(bytes)).toBe(true);
    }
    // Read-only commands never create sidecar state either.
    expect(existsSync(path.join(root, '.specbridge'))).toBe(false);
  });

  it('compat check still proves byte-identical round trips on v0.2 fixtures (test 52)', async () => {
    for (const fixture of ['v02-manually-edited', 'v02-requirements-first', 'v02-bugfix-spec']) {
      const result = await cli(fixturePath(fixture), 'compat', 'check');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('byte-identical');
    }
  });

  it('approval hashing works with Windows-style paths (test 55)', async () => {
    // This suite runs on every OS in CI; on Windows the stage file paths in
    // sidecar state use forward slashes while the filesystem uses backslashes.
    const root = copyFixtureToTemp('v02-requirements-first');
    const status = await cli(root, 'spec', 'status', 'notification-preferences');
    expect(status.stdout).toContain('Content unchanged since approval');
  });
});
