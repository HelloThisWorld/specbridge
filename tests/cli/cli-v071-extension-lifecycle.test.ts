import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../packages/cli/src/cli';
import { FIXED_NOW } from '../helpers';
import { freshKiroWorkspace } from '../helpers-templates';

async function cli(cwd: string, ...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    cwd,
    out: (line = '') => stdout.push(`${line}\n`),
    outRaw: (text) => stdout.push(text),
    err: (line = '') => stderr.push(`${line}\n`),
    now: () => FIXED_NOW,
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

describe('extension CLI lifecycle (scaffold → package → install → enable → doctor → uninstall)', () => {
  it('walks the full contributor and user journey for an analyzer', async () => {
    const root = freshKiroWorkspace();
    const scaffoldDir = path.join(root, 'work', 'demo-analyzer');

    const scaffold = await cli(root, 'extension', 'scaffold', 'demo-analyzer', '--kind', 'analyzer', '--output', scaffoldDir);
    expect(scaffold.code, scaffold.stderr).toBe(0);
    expect(existsSync(path.join(scaffoldDir, 'dist', 'extension.cjs'))).toBe(true);

    const validate = await cli(root, 'extension', 'validate', scaffoldDir, '--json');
    expect(validate.code, validate.stdout + validate.stderr).toBe(0);

    const conformance = await cli(root, 'extension', 'conformance', scaffoldDir, '--yes', '--json');
    expect(conformance.code, conformance.stdout + conformance.stderr).toBe(0);
    const conformanceReport = JSON.parse(conformance.stdout) as { data: { passed: boolean } };
    expect(conformanceReport.data.passed).toBe(true);

    const pack = await cli(root, 'extension', 'package', scaffoldDir, '--json');
    expect(pack.code, pack.stdout + pack.stderr).toBe(0);
    const packReport = JSON.parse(pack.stdout) as { data: { archivePath: string; archiveSha256: string } };
    expect(existsSync(packReport.data.archivePath)).toBe(true);

    // Packaging is deterministic: identical input produces identical hashes.
    const packAgain = await cli(root, 'extension', 'package', scaffoldDir, '--dry-run', '--json');
    const packAgainReport = JSON.parse(packAgain.stdout) as { data: { archiveSha256: string } };
    expect(packAgainReport.data.archiveSha256).toBe(packReport.data.archiveSha256);

    const install = await cli(root, 'extension', 'install', packReport.data.archivePath, '--json');
    expect(install.code, install.stdout + install.stderr).toBe(0);
    const installReport = JSON.parse(install.stdout) as { data: { permissionHash: string; dryRun: boolean } };
    expect(installReport.data.permissionHash).toMatch(/^[0-9a-f]{64}$/);

    const list = await cli(root, 'extension', 'list', '--json');
    const listReport = JSON.parse(list.stdout) as { data: { extensions: Array<{ id: string; enabled: boolean }> } };
    expect(listReport.data.extensions[0]?.id).toBe('demo-analyzer');
    expect(listReport.data.extensions[0]?.enabled).toBe(false); // installed disabled

    const show = await cli(root, 'extension', 'show', 'demo-analyzer');
    expect(show.stdout).toContain('permission hash:');
    expect(show.stdout).toContain(installReport.data.permissionHash);

    const enableWithoutHash = await cli(root, 'extension', 'enable', 'demo-analyzer');
    expect(enableWithoutHash.code).toBe(1);
    expect(enableWithoutHash.stdout).toContain('SBE016');

    const enableWrong = await cli(root, 'extension', 'enable', 'demo-analyzer', '--accept-permissions', 'f'.repeat(64));
    expect(enableWrong.code).toBe(2);
    expect(enableWrong.stderr).toContain('SBE017');

    const enable = await cli(root, 'extension', 'enable', 'demo-analyzer', '--accept-permissions', installReport.data.permissionHash);
    expect(enable.code, enable.stderr).toBe(0);

    const doctor = await cli(root, 'extension', 'doctor', 'demo-analyzer', '--json');
    expect(doctor.code, doctor.stdout).toBe(0);
    const doctorReport = JSON.parse(doctor.stdout) as { data: { ok: boolean; results: Array<{ grantStatus: string }> } };
    expect(doctorReport.data.ok).toBe(true);
    expect(doctorReport.data.results[0]?.grantStatus).toBe('current');

    // The scaffolded analyzer actually analyzes.
    const specDir = path.join(root, '.kiro', 'specs', 'demo-spec');
    mkdirSync(specDir, { recursive: true });
    writeFileSync(path.join(specDir, 'requirements.md'), '# Requirements\n\n## 1. R\n\nRetries are TBD.\n', 'utf8');
    const analyze = await cli(root, 'spec', 'analyze', 'demo-spec', '--extension', 'demo-analyzer', '--json');
    const analyzeReport = JSON.parse(analyze.stdout) as {
      data: { extensions: Array<{ diagnostics: Array<{ ruleId: string }> }> };
    };
    expect(
      analyzeReport.data.extensions.flatMap((run) => run.diagnostics).some((d) => d.ruleId === 'demo-analyzer/RULE001'),
    ).toBe(true);

    const disable = await cli(root, 'extension', 'disable', 'demo-analyzer');
    expect(disable.code).toBe(0);
    const uninstall = await cli(root, 'extension', 'uninstall', 'demo-analyzer', '--json');
    expect(uninstall.code, uninstall.stderr).toBe(0);
    const finalList = await cli(root, 'extension', 'list', '--json');
    expect((JSON.parse(finalList.stdout) as { data: { extensions: unknown[] } }).data.extensions).toHaveLength(0);
  });

  it('scaffolds every kind and each validates', async () => {
    const root = freshKiroWorkspace();
    for (const kind of ['template-provider', 'analyzer', 'verifier', 'exporter', 'runner']) {
      const dir = path.join(root, 'work', `demo-${kind}`);
      const scaffold = await cli(root, 'extension', 'scaffold', `demo-${kind}`, '--kind', kind, '--output', dir);
      expect(scaffold.code, `${kind}: ${scaffold.stderr}`).toBe(0);
      const validate = await cli(root, 'extension', 'validate', dir, '--json');
      expect(validate.code, `${kind}: ${validate.stdout}`).toBe(0);
      const pack = await cli(root, 'extension', 'package', dir, '--dry-run', '--json');
      expect(pack.code, `${kind}: ${pack.stdout + pack.stderr}`).toBe(0);
    }
  });
});

describe('registry CLI (offline)', () => {
  it('lists the built-in registry, adds/validates/searches a local-file registry, and stays offline', async () => {
    const root = freshKiroWorkspace();

    const list = await cli(root, 'registry', 'list', '--json');
    expect(list.code).toBe(0);
    const listReport = JSON.parse(list.stdout) as { data: { registries: Array<{ name: string; type: string }> } };
    expect(listReport.data.registries.some((row) => row.type === 'builtin')).toBe(true);

    const index = {
      schemaVersion: '1.0.0',
      name: 'local-examples',
      updatedAt: '2026-01-01T00:00:00.000Z',
      extensions: [
        {
          id: 'security-analyzer',
          displayName: 'Security Analyzer',
          description: 'Adds security-focused diagnostics.',
          kind: 'analyzer',
          latestVersion: '1.0.0',
          versions: [
            {
              version: '1.0.0',
              archiveUrl: 'https://example.invalid/security-analyzer.zip',
              sha256: 'a'.repeat(64),
              manifest: {
                protocolVersion: '1.0.0',
                compatibility: { specbridge: '>=0.7.1 <1.0.0' },
                permissions: {
                  specRead: true,
                  repositoryRead: false,
                  repositoryWrite: false,
                  network: false,
                  childProcess: false,
                  environmentVariables: [],
                },
              },
            },
          ],
          license: 'MIT',
          keywords: ['security'],
        },
      ],
    };
    writeFileSync(path.join(root, 'local-registry.json'), JSON.stringify(index, null, 2), 'utf8');

    const add = await cli(root, 'registry', 'add', 'local-examples', '--file', 'local-registry.json');
    expect(add.code, add.stderr).toBe(0);
    const addAgain = await cli(root, 'registry', 'add', 'local-examples', '--file', 'local-registry.json');
    expect(addAgain.code).toBe(2); // duplicate names never overwrite

    const validate = await cli(root, 'registry', 'validate', 'local-examples', '--json');
    expect(validate.code, validate.stdout).toBe(0);

    const search = await cli(root, 'registry', 'search', 'security', '--json');
    expect(search.code).toBe(0);
    const searchReport = JSON.parse(search.stdout) as { data: { results: Array<{ id: string; score: number }> } };
    expect(searchReport.data.results[0]?.id).toBe('security-analyzer');

    const show = await cli(root, 'registry', 'show', 'security-analyzer');
    expect(show.code).toBe(0);
    expect(show.stdout).toContain('not endorsement');

    // Update without --network is refused for https sources.
    const addHttps = await cli(root, 'registry', 'add', 'community', '--url', 'https://example.invalid/index.json');
    expect(addHttps.code).toBe(0);
    const updateNoNetwork = await cli(root, 'registry', 'update', 'community');
    expect(updateNoNetwork.code).toBe(1);
    expect(updateNoNetwork.stdout).toContain('SBR004');

    // HTTP URLs are rejected outright.
    const addHttp = await cli(root, 'registry', 'add', 'insecure', '--url', 'http://example.invalid/index.json');
    expect(addHttp.code).toBe(2);

    // Credentialed URLs are rejected.
    const addCreds = await cli(root, 'registry', 'add', 'creds', '--url', 'https://user:pass@example.invalid/index.json');
    expect(addCreds.code).toBe(2);

    const remove = await cli(root, 'registry', 'remove', 'local-examples', '--yes');
    expect(remove.code).toBe(0);

    // Registry install requires --network even with a cached/readable index.
    const invalidIndexInstall = await cli(root, 'extension', 'install', 'security-analyzer', '--registry', 'community');
    expect(invalidIndexInstall.code).toBe(2);
  });

  it('reports invalid registry index files with actionable problems', async () => {
    const root = freshKiroWorkspace();
    writeFileSync(path.join(root, 'bad-registry.json'), '{"schemaVersion":"1.0.0"}', 'utf8');
    const validate = await cli(root, 'registry', 'validate', 'bad-registry.json', '--json');
    expect(validate.code).toBe(1);
    const report = JSON.parse(validate.stdout) as { data: { valid: boolean; problems: string[] } };
    expect(report.data.valid).toBe(false);
    expect(report.data.problems.length).toBeGreaterThan(0);
  });
});
