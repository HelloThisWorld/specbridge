import { describe, expect, it } from 'vitest';
import { testWorkflowState } from '../helpers';
import {
  V1_CONFIG,
  V2_CONFIG,
  cli,
  kiroWorkspace,
  specWorkspace,
  treeHash,
  truncatedStateJson,
  validEvidenceRecord,
  write,
  writeInterruptedMigration,
  writeStaleSpecState,
  writeValidLock,
  writeValidSpecState,
} from './corruption-helpers';

interface ValidateReport {
  schema: string;
  data: {
    healthy: boolean;
    counts: Record<string, number>;
    findings: Array<{
      family: string;
      path: string;
      status: string;
      schemaVersion: string | null;
      problems: string[];
      recovery?: { kind: string; confidence: string; risk: string };
    }>;
  };
}

async function validateJson(root: string, ...extra: string[]): Promise<{ code: number; report: ValidateReport }> {
  const result = await cli(root, 'state', 'validate', '--json', ...extra);
  return { code: result.code, report: JSON.parse(result.stdout) as ValidateReport };
}

function findingAt(report: ValidateReport, relPath: string, family?: string): ValidateReport['data']['findings'][number] | undefined {
  return report.data.findings.find(
    (candidate) => candidate.path === relPath && (family === undefined || candidate.family === family),
  );
}

describe('state validate — healthy workspaces', () => {
  it('exits 0 when every finding is valid', async () => {
    const root = specWorkspace();
    writeValidSpecState(root);
    write(root, '.specbridge/config.json', V2_CONFIG);
    const { code, report } = await validateJson(root);
    expect(code).toBe(0);
    expect(report.schema).toBe('specbridge.state-validate/1');
    expect(report.data.healthy).toBe(true);
    expect(report.data.findings.every((candidate) => candidate.status === 'valid')).toBe(true);
  });

  it('exits 0 with nothing to validate when no sidecar exists', async () => {
    const root = kiroWorkspace();
    const result = await cli(root, 'state', 'validate');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('nothing to validate');
  });

  it('tolerates CRLF-only JSON (still valid)', async () => {
    const root = specWorkspace();
    const state = `${JSON.stringify(testWorkflowState({ specName: 'demo' }), null, 2)}\n`.replace(/\n/g, '\r\n');
    write(root, '.specbridge/state/specs/demo.json', state);
    const { code, report } = await validateJson(root);
    expect(code).toBe(0);
    expect(findingAt(report, '.specbridge/state/specs/demo.json')?.status).toBe('valid');
  });

  it('treats a valid interactive lock as valid and proposes nothing', async () => {
    const root = kiroWorkspace();
    writeValidLock(root);
    const { code, report } = await validateJson(root);
    expect(code).toBe(0);
    const lock = findingAt(report, '.specbridge/locks/interactive-task.lock', 'runs');
    expect(lock?.status).toBe('valid');
    expect(lock?.recovery).toBeUndefined();
    expect(lock?.problems.join(' ')).toContain('never removed automatically');
  });
});

describe('state validate — corruption findings (each exits 1)', () => {
  it('flags a v1 config as migration-required', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/config.json', V1_CONFIG);
    const { code, report } = await validateJson(root);
    expect(code).toBe(1);
    const found = findingAt(report, '.specbridge/config.json', 'config');
    expect(found?.status).toBe('migration-required');
    expect(found?.schemaVersion).toBe('1.0.0');
    expect(found?.recovery).toBeUndefined();
  });

  it('flags a config with an unknown runner profile as invalid without recovery', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/config.json', `${JSON.stringify({ schemaVersion: '2.0.0', defaultRunner: 'nope' })}\n`);
    const { code, report } = await validateJson(root);
    expect(code).toBe(1);
    const found = findingAt(report, '.specbridge/config.json', 'config');
    expect(found?.status).toBe('invalid');
    expect(found?.recovery).toBeUndefined();
    expect(found?.problems.join(' ')).toContain('user-authored');
  });

  it('flags truncated spec-state JSON as invalid with a quarantine proposal', async () => {
    const root = specWorkspace();
    write(root, '.specbridge/state/specs/demo.json', truncatedStateJson());
    const { code, report } = await validateJson(root);
    expect(code).toBe(1);
    const found = findingAt(report, '.specbridge/state/specs/demo.json');
    expect(found?.status).toBe('invalid');
    expect(found?.recovery?.kind).toBe('quarantine-file');
    expect(found?.recovery?.confidence).toBe('manual-review');
  });

  it('flags a partially written state object as invalid', async () => {
    const root = specWorkspace();
    write(root, '.specbridge/state/specs/demo.json', '{"schemaVersion": "1.0.0", "specName"');
    const { code, report } = await validateJson(root);
    expect(code).toBe(1);
    expect(findingAt(report, '.specbridge/state/specs/demo.json')?.status).toBe('invalid');
  });

  it('flags non-JSON state as invalid', async () => {
    const root = specWorkspace();
    write(root, '.specbridge/state/specs/demo.json', 'not json at all');
    const { code, report } = await validateJson(root);
    expect(code).toBe(1);
    expect(findingAt(report, '.specbridge/state/specs/demo.json')?.status).toBe('invalid');
  });

  it('flags an unknown future schemaVersion as incompatible (no quarantine)', async () => {
    const root = specWorkspace();
    write(
      root,
      '.specbridge/state/specs/demo.json',
      `${JSON.stringify({ schemaVersion: '9.0.0', specName: 'demo', futureShape: true })}\n`,
    );
    const { code, report } = await validateJson(root);
    expect(code).toBe(1);
    const found = findingAt(report, '.specbridge/state/specs/demo.json');
    expect(found?.status).toBe('incompatible');
    expect(found?.schemaVersion).toBe('9.0.0');
    expect(found?.recovery).toBeUndefined();
  });

  it('flags a pre-1.0.0 legacy shape as legacy (no quarantine)', async () => {
    const root = specWorkspace();
    write(root, '.specbridge/state/specs/demo.json', `${JSON.stringify({ specName: 'demo', approvals: {} })}\n`);
    const { code, report } = await validateJson(root);
    expect(code).toBe(1);
    const found = findingAt(report, '.specbridge/state/specs/demo.json');
    expect(found?.status).toBe('legacy');
    expect(found?.recovery).toBeUndefined();
  });

  it('flags state without a matching .kiro spec directory as orphaned', async () => {
    const root = kiroWorkspace();
    write(
      root,
      '.specbridge/state/specs/ghost.json',
      `${JSON.stringify(testWorkflowState({ specName: 'ghost' }), null, 2)}\n`,
    );
    const { code, report } = await validateJson(root);
    expect(code).toBe(1);
    const found = findingAt(report, '.specbridge/state/specs/ghost.json');
    expect(found?.status).toBe('orphaned');
    expect(found?.recovery?.kind).toBe('archive-orphan-state');
    expect(found?.recovery?.risk).toBe('low');
  });

  it('flags an approval whose file changed as stale, naming the stage, with no recovery', async () => {
    const root = specWorkspace();
    writeStaleSpecState(root);
    const { code, report } = await validateJson(root);
    expect(code).toBe(1);
    const found = findingAt(report, '.specbridge/state/specs/demo.json');
    expect(found?.status).toBe('stale');
    expect(found?.problems.join(' ')).toContain('requirements');
    expect(found?.problems.join(' ')).toContain('re-approve');
    expect(found?.recovery).toBeUndefined();
  });

  it('flags a UTF-8 BOM state file as invalid (readers reject BOM JSON)', async () => {
    const root = specWorkspace();
    const state = `${JSON.stringify(testWorkflowState({ specName: 'demo' }), null, 2)}\n`.replace(/\n/g, '\r\n');
    write(root, '.specbridge/state/specs/demo.json', String.fromCharCode(0xfeff) + state);
    const { code, report } = await validateJson(root);
    expect(code).toBe(1);
    expect(findingAt(report, '.specbridge/state/specs/demo.json')?.status).toBe('invalid');
  });

  it('flags an unreadable interactive lock as recoverable with a removal proposal', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/locks/interactive-task.lock', '{not json');
    const { code, report } = await validateJson(root);
    expect(code).toBe(1);
    const found = findingAt(report, '.specbridge/locks/interactive-task.lock', 'runs');
    expect(found?.status).toBe('recoverable');
    expect(found?.recovery?.kind).toBe('remove-stale-lock');
  });

  it('flags an invalid run record with a manual-review quarantine proposal', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/runs/run-x/run.json', '{"schemaVersion":"1.0.0"}');
    const { code, report } = await validateJson(root);
    expect(code).toBe(1);
    const found = findingAt(report, '.specbridge/runs/run-x/run.json', 'runs');
    expect(found?.status).toBe('invalid');
    expect(found?.recovery?.kind).toBe('quarantine-file');
    expect(found?.recovery?.confidence).toBe('manual-review');
  });

  it('flags invalid evidence with NO recovery proposal ever', async () => {
    const root = specWorkspace();
    write(root, '.specbridge/evidence/demo/1/run-1.json', '{}');
    write(root, '.specbridge/evidence/demo/2/run-2.json', '{truncated');
    const { code, report } = await validateJson(root);
    expect(code).toBe(1);
    for (const relPath of ['.specbridge/evidence/demo/1/run-1.json', '.specbridge/evidence/demo/2/run-2.json']) {
      const found = findingAt(report, relPath, 'evidence');
      expect(found?.status).toBe('invalid');
      expect(found?.recovery).toBeUndefined();
      expect(found?.problems.join(' ')).toContain('manual review only');
    }
  });

  it('flags evidence whose changed files escape the repository', async () => {
    const root = specWorkspace();
    write(
      root,
      '.specbridge/evidence/demo/1/run-1.json',
      `${JSON.stringify(
        validEvidenceRecord({
          changedFiles: [
            { path: '../outside.txt', changeType: 'modified', preExisting: true, modifiedDuringRun: true },
          ],
        }),
        null,
        2,
      )}\n`,
    );
    const { code, report } = await validateJson(root);
    expect(code).toBe(1);
    const found = findingAt(report, '.specbridge/evidence/demo/1/run-1.json', 'evidence');
    expect(found?.status).toBe('invalid');
    expect(found?.problems.join(' ')).toContain('outside the repository');
    expect(found?.recovery).toBeUndefined();
  });

  it('flags an invalid verification policy as invalid without recovery', async () => {
    const root = specWorkspace();
    write(root, '.specbridge/policies/demo.json', '{bad json');
    const { code, report } = await validateJson(root);
    expect(code).toBe(1);
    const found = findingAt(report, '.specbridge/policies/demo.json', 'policies');
    expect(found?.status).toBe('invalid');
    expect(found?.recovery).toBeUndefined();
  });

  it('flags a bad template record line as invalid without recovery', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/template-records.jsonl', 'not-json\n');
    const { code, report } = await validateJson(root);
    expect(code).toBe(1);
    const found = findingAt(report, '.specbridge/template-records.jsonl', 'templates');
    expect(found?.status).toBe('invalid');
    expect(found?.recovery).toBeUndefined();
  });

  it('flags an invalid installed pack manifest with a quarantine proposal', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/templates/broken/specbridge-template.json', '{bad manifest');
    const { code, report } = await validateJson(root);
    expect(code).toBe(1);
    const found = findingAt(report, '.specbridge/templates/broken/specbridge-template.json', 'templates');
    expect(found?.status).toBe('invalid');
    expect(found?.recovery?.kind).toBe('quarantine-file');
  });

  it('flags invalid extension grants as invalid without recovery (security-relevant)', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/extensions/grants.json', `${JSON.stringify({ schemaVersion: '1.0.0', grants: { x: {} } })}\n`);
    const { code, report } = await validateJson(root);
    expect(code).toBe(1);
    const found = findingAt(report, '.specbridge/extensions/grants.json', 'extensions');
    expect(found?.status).toBe('invalid');
    expect(found?.recovery).toBeUndefined();
    expect(found?.problems.join(' ')).toContain('security-relevant');
  });

  it('flags a corrupt registry cache as recoverable with a certain quarantine proposal', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/registry-cache/examples.json', '{broken');
    const { code, report } = await validateJson(root);
    expect(code).toBe(1);
    const found = findingAt(report, '.specbridge/registry-cache/examples.json', 'registries');
    expect(found?.status).toBe('recoverable');
    expect(found?.recovery?.kind).toBe('quarantine-file');
    expect(found?.recovery?.confidence).toBe('certain');
    expect(found?.recovery?.risk).toBe('low');
  });

  it('reports an interrupted migration whose target is healthy as report-only', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/config.json', V2_CONFIG);
    const planId = writeInterruptedMigration(root);
    const { code, report } = await validateJson(root);
    expect(code).toBe(1);
    const found = findingAt(report, `.specbridge/migrations/${planId}/plan.json`, 'migrations');
    expect(found?.status).toBe('recoverable');
    expect(found?.recovery).toBeUndefined();
    expect(found?.problems.join(' ')).toContain('passes its family validation');
  });

  it('proposes restore-from-migration-backup only when the target fails AND a backup exists', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/config.json', '{broken');
    writeInterruptedMigration(root);
    const { code, report } = await validateJson(root);
    expect(code).toBe(1);
    const found = findingAt(report, '.specbridge/config.json', 'migrations');
    expect(found?.status).toBe('recoverable');
    expect(found?.recovery?.kind).toBe('restore-from-migration-backup');
    expect(found?.recovery?.confidence).toBe('manual-review');
  });

  it('does not propose restore when the backup is missing', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/config.json', '{broken');
    const planId = writeInterruptedMigration(root, { withBackup: false });
    const { code, report } = await validateJson(root);
    expect(code).toBe(1);
    expect(findingAt(report, '.specbridge/config.json', 'migrations')).toBeUndefined();
    const reportOnly = findingAt(report, `.specbridge/migrations/${planId}/plan.json`, 'migrations');
    expect(reportOnly?.recovery).toBeUndefined();
    expect(reportOnly?.problems.join(' ')).toContain('no backup exists');
  });
});

describe('state validate — behavior guarantees', () => {
  it('NEVER writes, even on a heavily corrupted workspace', async () => {
    const root = specWorkspace();
    write(root, '.specbridge/config.json', '{broken');
    write(root, '.specbridge/state/specs/demo.json', 'not json');
    write(root, '.specbridge/registry-cache/examples.json', '{broken');
    write(root, '.specbridge/locks/interactive-task.lock', '{not json');
    write(root, '.specbridge/evidence/demo/1/run-1.json', '{}');
    const before = treeHash(root);
    const result = await cli(root, 'state', 'validate');
    expect(result.code).toBe(1);
    expect(treeHash(root)).toBe(before);
  });

  it('--spec filters to one spec', async () => {
    const root = specWorkspace('good');
    write(root, '.kiro/specs/bad/requirements.md', '# Requirements Document\n');
    writeValidSpecState(root, 'good');
    write(root, '.specbridge/state/specs/bad.json', 'not json');

    const good = await validateJson(root, '--spec', 'good');
    expect(good.code).toBe(0);
    expect(good.report.data.findings.every((candidate) => candidate.path.includes('good'))).toBe(true);

    const bad = await validateJson(root, '--spec', 'bad');
    expect(bad.code).toBe(1);
    expect(findingAt(bad.report, '.specbridge/state/specs/bad.json')?.status).toBe('invalid');
  });

  it('prints a per-family grouping and a status summary', async () => {
    const root = specWorkspace();
    writeStaleSpecState(root);
    write(root, '.specbridge/registry-cache/examples.json', '{broken');
    const result = await cli(root, 'state', 'validate');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('spec-state:');
    expect(result.stdout).toContain('registries:');
    expect(result.stdout).toContain('Summary:');
    expect(result.stdout).toContain('stale: 1');
    expect(result.stdout).toContain('recoverable: 1');
    expect(result.stdout).toContain('state recover --plan');
  });
});
