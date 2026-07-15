import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../packages/cli/src/cli';
import { FIXED_NOW } from '../helpers';
import { featureManifest, featurePackFiles, freshKiroWorkspace, writePack } from '../helpers-templates';

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

function snapshotTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const p = path.join(dir, entry.name);
      out.push(path.relative(root, p));
      if (entry.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}

describe('template list/search/show', () => {
  it('lists built-in templates', async () => {
    const root = freshKiroWorkspace();
    const result = await cli(root, 'template', 'list');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('builtin:rest-api');
    expect(result.stdout).toContain('builtin:bugfix-regression');
  });

  it('lists as JSON with a versioned schema', async () => {
    const root = freshKiroWorkspace();
    const result = await cli(root, 'template', 'list', '--json');
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      schema: string;
      data: { templates: Array<{ ref: string; valid: boolean; kind: string | null }> };
    };
    expect(report.schema).toBe('specbridge.template-list/1');
    expect(report.data.templates.length).toBeGreaterThanOrEqual(2);
    expect(report.data.templates.every((template) => template.valid)).toBe(true);
  });

  it('filters by kind and tag', async () => {
    const root = freshKiroWorkspace();
    const bugfix = await cli(root, 'template', 'list', '--kind', 'bugfix', '--json');
    const parsed = JSON.parse(bugfix.stdout) as { data: { templates: Array<{ kind: string }> } };
    expect(parsed.data.templates.length).toBeGreaterThanOrEqual(1);
    expect(parsed.data.templates.every((template) => template.kind === 'bugfix')).toBe(true);

    const tagged = await cli(root, 'template', 'list', '--tag', 'http', '--json');
    const taggedParsed = JSON.parse(tagged.stdout) as { data: { templates: Array<{ ref: string }> } };
    expect(taggedParsed.data.templates.some((template) => template.ref === 'builtin:rest-api')).toBe(true);
  });

  it('searches deterministically and ranks exact ID first', async () => {
    const root = freshKiroWorkspace();
    const result = await cli(root, 'template', 'search', 'rest-api', '--json');
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as { data: { results: Array<{ ref: string; score: number }> } };
    expect(report.data.results[0]?.ref).toBe('builtin:rest-api');
    expect(report.data.results[0]?.score).toBeGreaterThan(0);
  });

  it('shows a template with variables and usage', async () => {
    const root = freshKiroWorkspace();
    const result = await cli(root, 'template', 'show', 'rest-api');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('builtin:rest-api');
    expect(result.stdout).toContain('--var resourceName=<string>');
    expect(result.stdout).toContain('template apply rest-api');
  });

  it('works outside a Kiro workspace for read-only discovery', async () => {
    const root = path.join(freshKiroWorkspace(), 'plain');
    mkdirSync(root, { recursive: true });
    const result = await cli(root, 'template', 'list');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('builtin:rest-api');
  });
});

describe('template validate', () => {
  it('validates a built-in template', async () => {
    const root = freshKiroWorkspace();
    const result = await cli(root, 'template', 'validate', 'builtin:rest-api');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('valid');
  });

  it('validates a local pack path and reports categorized issues', async () => {
    const root = freshKiroWorkspace();
    const packDir = path.join(root, 'my-pack');
    mkdirSync(packDir, { recursive: true });
    writePack(packDir, featurePackFiles(featureManifest({ id: 'my-pack', tags: ['Bad Tag'] })));
    const result = await cli(root, 'template', 'validate', './my-pack', '--json');
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as {
      data: { valid: boolean; issues: Array<{ code: string; category: string }> };
    };
    expect(report.data.valid).toBe(false);
    expect(report.data.issues.some((issue) => issue.code === 'SBT004' && issue.category === 'manifest')).toBe(true);
  });

  it('fails --strict on warnings', async () => {
    const root = freshKiroWorkspace();
    const packDir = path.join(root, 'warn-pack');
    mkdirSync(packDir, { recursive: true });
    const files = featurePackFiles(featureManifest({ id: 'warn-pack' }));
    delete (files as Record<string, string>)['README.md'];
    writePack(packDir, files);
    const lax = await cli(root, 'template', 'validate', './warn-pack');
    expect(lax.code).toBe(0);
    const strict = await cli(root, 'template', 'validate', './warn-pack', '--strict');
    expect(strict.code).toBe(1);
  });
});

describe('template preview and apply', () => {
  it('preview renders content and writes nothing', async () => {
    const root = freshKiroWorkspace();
    const before = snapshotTree(root);
    const result = await cli(
      root,
      'template',
      'preview',
      'rest-api',
      '--name',
      'orders-endpoint',
      '--var',
      'resourceName=order',
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('nothing was written');
    expect(result.stdout).toContain('# Requirements Document');
    expect(result.stdout).toContain('Candidate:');
    expect(snapshotTree(root)).toEqual(before);
  });

  it('apply creates the spec with unapproved sidecar state', async () => {
    const root = freshKiroWorkspace();
    const result = await cli(
      root,
      'template',
      'apply',
      'rest-api',
      '--name',
      'orders-endpoint',
      '--var',
      'resourceName=order',
      '--json',
    );
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      schema: string;
      data: { created: boolean; recordId: string; state: { stages: Record<string, { status: string }> } };
    };
    expect(report.schema).toBe('specbridge.template-apply/1');
    expect(report.data.created).toBe(true);
    expect(report.data.recordId).toBeTruthy();
    const specDir = path.join(root, '.kiro', 'specs', 'orders-endpoint');
    expect(readdirSync(specDir).sort()).toEqual(['design.md', 'requirements.md', 'tasks.md']);
    expect(readFileSync(path.join(specDir, 'requirements.md'), 'utf8')).toContain('`order` resource');
    const state = JSON.parse(
      readFileSync(path.join(root, '.specbridge', 'state', 'specs', 'orders-endpoint.json'), 'utf8'),
    ) as { stages: Record<string, { status: string }> };
    for (const stage of Object.values(state.stages)) {
      expect(stage.status).not.toBe('approved');
    }
  });

  it('apply --dry-run writes nothing', async () => {
    const root = freshKiroWorkspace();
    const before = snapshotTree(root);
    const result = await cli(root, 'template', 'apply', 'rest-api', '--name', 'dry-spec', '--dry-run');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Dry run');
    expect(snapshotTree(root)).toEqual(before);
  });

  it('refuses to overwrite an existing spec with an actionable error', async () => {
    const root = freshKiroWorkspace();
    await cli(root, 'template', 'apply', 'rest-api', '--name', 'taken');
    const contentBefore = readFileSync(path.join(root, '.kiro', 'specs', 'taken', 'requirements.md'), 'utf8');
    const result = await cli(root, 'template', 'apply', 'rest-api', '--name', 'taken');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('SBT020');
    expect(result.stderr).toContain('never overwrites');
    expect(readFileSync(path.join(root, '.kiro', 'specs', 'taken', 'requirements.md'), 'utf8')).toBe(contentBefore);
  });

  it('accepts --var title= / description= as aliases for the dedicated options', async () => {
    const root = freshKiroWorkspace();
    const result = await cli(
      root,
      'template',
      'apply',
      'database-migration',
      '--name',
      'add-payment-status-index',
      '--var',
      'title=Add payment status index',
      '--var',
      'tableName=payments',
      '--json',
    );
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as { data: { title: string } };
    expect(report.data.title).toBe('Add payment status index');

    const both = await cli(
      root,
      'template',
      'preview',
      'rest-api',
      '--name',
      'x',
      '--title',
      'One',
      '--var',
      'title=Two',
    );
    expect(both.code).toBe(2);
    expect(both.stderr).toContain('Use one of them');
  });

  it('reports actionable errors for unknown templates and bad variables', async () => {
    const root = freshKiroWorkspace();
    const missing = await cli(root, 'template', 'apply', 'nope-template', '--name', 'x');
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('SBT001');
    expect(missing.stderr).toContain('template list');

    const badVar = await cli(root, 'template', 'apply', 'rest-api', '--name', 'x', '--var', 'mystery=1');
    expect(badVar.code).toBe(2);
    expect(badVar.stderr).toContain('SBT014');

    const badShape = await cli(root, 'template', 'apply', 'rest-api', '--name', 'x', '--var', 'noequals');
    expect(badShape.code).toBe(2);
    expect(badShape.stderr).toContain('--var key=value');
  });
});

describe('spec new --template', () => {
  it('creates a spec through the same template service', async () => {
    const root = freshKiroWorkspace();
    const result = await cli(
      root,
      'spec',
      'new',
      'orders-endpoint',
      '--template',
      'rest-api',
      '--var',
      'resourceName=order',
      '--json',
    );
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      schema: string;
      data: { template: { ref: string; candidateHash: string } | null; created: boolean };
    };
    expect(report.schema).toBe('specbridge.spec-new/1');
    expect(report.data.template?.ref).toBe('builtin:rest-api');
    expect(report.data.created).toBe(true);
    // The same append-only template record is written as for template apply.
    const records = readFileSync(path.join(root, '.specbridge', 'template-records.jsonl'), 'utf8');
    expect(records).toContain('"type":"template-apply"');
    expect(records).toContain('builtin:rest-api');
  });

  it('rejects conflicting --type and unsupported combinations with actionable errors', async () => {
    const root = freshKiroWorkspace();
    const conflict = await cli(root, 'spec', 'new', 'x', '--template', 'rest-api', '--type', 'bugfix');
    expect(conflict.code).toBe(2);
    expect(conflict.stderr).toContain('conflicts with template');

    const fromFile = await cli(root, 'spec', 'new', 'x', '--template', 'rest-api', '--from-file', 'desc.md');
    expect(fromFile.code).toBe(2);
    expect(fromFile.stderr).toContain('--from-file cannot be combined');

    const varsWithoutTemplate = await cli(root, 'spec', 'new', 'x', '--var', 'a=1');
    expect(varsWithoutTemplate.code).toBe(2);
    expect(varsWithoutTemplate.stderr).toContain('--var requires --template');
  });

  it('leaves non-template spec new behavior unchanged', async () => {
    const root = freshKiroWorkspace();
    const result = await cli(root, 'spec', 'new', 'plain-spec', '--json');
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as { data: { template: unknown; created: boolean } };
    expect(report.data.template).toBeNull();
    expect(report.data.created).toBe(true);
    expect(existsSync(path.join(root, '.specbridge', 'template-records.jsonl'))).toBe(false);
  });
});

describe('template install/uninstall/scaffold via CLI', () => {
  it('runs the full scaffold -> validate -> install -> show -> uninstall loop', async () => {
    const root = freshKiroWorkspace();

    const scaffold = await cli(root, 'template', 'scaffold', 'custom-api', '--kind', 'feature', '--output', './custom-api');
    expect(scaffold.code).toBe(0);
    expect(existsSync(path.join(root, 'custom-api', 'specbridge-template.json'))).toBe(true);

    const validate = await cli(root, 'template', 'validate', './custom-api');
    expect(validate.code).toBe(0);

    const install = await cli(root, 'template', 'install', './custom-api');
    expect(install.code).toBe(0);
    expect(existsSync(path.join(root, '.specbridge', 'templates', 'custom-api'))).toBe(true);

    const show = await cli(root, 'template', 'show', 'project:custom-api');
    expect(show.code).toBe(0);
    expect(show.stdout).toContain('project:custom-api');

    const dryUninstall = await cli(root, 'template', 'uninstall', 'project:custom-api', '--dry-run');
    expect(dryUninstall.code).toBe(0);
    expect(existsSync(path.join(root, '.specbridge', 'templates', 'custom-api'))).toBe(true);

    const uninstall = await cli(root, 'template', 'uninstall', 'project:custom-api');
    expect(uninstall.code).toBe(0);
    expect(existsSync(path.join(root, '.specbridge', 'templates', 'custom-api'))).toBe(false);
  });

  it('rejects built-in uninstall', async () => {
    const root = freshKiroWorkspace();
    const result = await cli(root, 'template', 'uninstall', 'builtin:rest-api');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('SBT022');
  });

  it('scaffold --dry-run writes nothing', async () => {
    const root = freshKiroWorkspace();
    const before = snapshotTree(root);
    const result = await cli(root, 'template', 'scaffold', 'dry-pack', '--dry-run');
    expect(result.code).toBe(0);
    expect(snapshotTree(root)).toEqual(before);
  });
});
