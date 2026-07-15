import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkspace } from '@specbridge/core';
import type { WorkspaceInfo } from '@specbridge/core';
import {
  executeTemplateInstall,
  executeTemplateScaffold,
  executeTemplateUninstall,
  loadTemplateCatalog,
  loadTemplatePack,
  planTemplateApplication,
  executeTemplateApplication,
  planTemplateInstall,
  planTemplateScaffold,
  planTemplateUninstall,
  readTemplatePackDirectory,
  readTemplateRecords,
  resolveTemplate,
} from '@specbridge/templates';
import { fixedClock } from '../helpers';
import { featureManifest, featurePackFiles, freshKiroWorkspace, writePack } from '../helpers-templates';

function workspace(): WorkspaceInfo {
  const info = resolveWorkspace(freshKiroWorkspace());
  if (info === undefined) throw new Error('workspace setup failed');
  return info;
}

function packInWorkspace(info: WorkspaceInfo, dirName = 'my-pack', manifest = featureManifest()): string {
  const dir = path.join(info.rootDir, dirName);
  mkdirSync(dir, { recursive: true });
  writePack(dir, featurePackFiles(manifest));
  return dir;
}

describe('template install', () => {
  it('installs a valid local pack atomically and records it', () => {
    const info = workspace();
    packInWorkspace(info);
    const catalog = loadTemplateCatalog(info);
    const plan = planTemplateInstall(info, catalog, { sourcePath: './my-pack' });
    const result = executeTemplateInstall(info, plan, fixedClock, 'install-1');

    expect(result.installedPath).toBe(path.join(info.sidecarDir, 'templates', 'sample-feature'));
    const installed = loadTemplatePack(readTemplatePackDirectory(result.installedPath));
    expect(installed.valid).toBe(true);

    const catalogAfter = loadTemplateCatalog(info);
    expect(resolveTemplate(catalogAfter, 'project:sample-feature').valid).toBe(true);

    const { records } = readTemplateRecords(info);
    expect(records).toHaveLength(1);
    expect(records[0]?.type).toBe('template-install');
  });

  it('rejects a source path outside the repository with SBT007', () => {
    const info = workspace();
    expect(() =>
      planTemplateInstall(info, loadTemplateCatalog(info), { sourcePath: '../elsewhere' }),
    ).toThrowError(/SBT007/);
  });

  it('rejects an invalid pack before anything is copied', () => {
    const info = workspace();
    const dir = path.join(info.rootDir, 'bad-pack');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'specbridge-template.json'), '{ nope', 'utf8');
    expect(() =>
      planTemplateInstall(info, loadTemplateCatalog(info), { sourcePath: './bad-pack' }),
    ).toThrowError(/SBT004/);
    expect(existsSync(path.join(info.sidecarDir, 'templates'))).toBe(false);
  });

  it('rejects a duplicate installed template with SBT021 and has no --force path', () => {
    const info = workspace();
    packInWorkspace(info);
    const catalog = loadTemplateCatalog(info);
    executeTemplateInstall(info, planTemplateInstall(info, catalog, { sourcePath: './my-pack' }), fixedClock, 'i1');
    expect(() =>
      planTemplateInstall(info, loadTemplateCatalog(info), { sourcePath: './my-pack' }),
    ).toThrowError(/SBT021/);
  });

  it('a failed install leaves no partial pack behind', () => {
    const info = workspace();
    packInWorkspace(info);
    const catalog = loadTemplateCatalog(info);
    const plan = planTemplateInstall(info, catalog, { sourcePath: './my-pack' });
    // Simulate a concurrent install landing first: the target appears
    // between planning and execution.
    const targetDir = plan.targetDir;
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(path.join(targetDir, 'occupied.txt'), 'here first', 'utf8');
    expect(() => executeTemplateInstall(info, plan, fixedClock, 'i2')).toThrowError(/SBT021/);
    // The pre-existing directory is untouched and no temp dirs leak.
    expect(readFileSync(path.join(targetDir, 'occupied.txt'), 'utf8')).toBe('here first');
    expect(existsSync(path.join(info.sidecarDir, 'tmp'))).toBe(false);
  });

  it('warns when installing a pack that shadows a built-in ID', () => {
    const info = workspace();
    packInWorkspace(info, 'shadow-pack', featureManifest({ id: 'rest-api' }));
    const plan = planTemplateInstall(info, loadTemplateCatalog(info), { sourcePath: './shadow-pack' });
    expect(plan.warnings.some((warning) => warning.includes('ambiguous'))).toBe(true);
  });
});

describe('template uninstall', () => {
  function installedWorkspace(): WorkspaceInfo {
    const info = workspace();
    packInWorkspace(info);
    executeTemplateInstall(
      info,
      planTemplateInstall(info, loadTemplateCatalog(info), { sourcePath: './my-pack' }),
      fixedClock,
      'setup-install',
    );
    return info;
  }

  it('uninstalls a project template and records it', () => {
    const info = installedWorkspace();
    const plan = planTemplateUninstall(info, 'project:sample-feature');
    executeTemplateUninstall(info, plan, fixedClock, 'uninstall-1');
    expect(existsSync(plan.dir)).toBe(false);
    const { records } = readTemplateRecords(info);
    expect(records.map((record) => record.type)).toEqual(['template-install', 'template-uninstall']);
  });

  it('rejects built-in uninstall with SBT022', () => {
    const info = workspace();
    expect(() => planTemplateUninstall(info, 'builtin:rest-api')).toThrowError(/SBT022/);
  });

  it('requires a qualified project reference', () => {
    const info = installedWorkspace();
    expect(() => planTemplateUninstall(info, 'sample-feature')).toThrowError(/project:sample-feature/);
  });

  it('does not delete specs generated from the template', () => {
    const info = installedWorkspace();
    const catalog = loadTemplateCatalog(info);
    const applyPlan = planTemplateApplication(
      info,
      catalog,
      { reference: 'project:sample-feature', specName: 'from-template' },
      fixedClock,
    );
    executeTemplateApplication(info, applyPlan, fixedClock, 'apply-before-uninstall');
    executeTemplateUninstall(info, planTemplateUninstall(info, 'project:sample-feature'), fixedClock, 'u1');
    expect(readdirSync(path.join(info.rootDir, '.kiro', 'specs', 'from-template')).sort()).toEqual([
      'design.md',
      'requirements.md',
      'tasks.md',
    ]);
    // Records (including the apply) survive the uninstall.
    const { records } = readTemplateRecords(info);
    expect(records.some((record) => record.type === 'template-apply')).toBe(true);
  });

  it('fails on a template that is not installed with SBT001', () => {
    const info = workspace();
    expect(() => planTemplateUninstall(info, 'project:missing')).toThrowError(/SBT001/);
  });
});

describe('template scaffold', () => {
  it('scaffolds a valid feature pack', () => {
    const info = workspace();
    const plan = planTemplateScaffold({
      templateId: 'my-service-template',
      kind: 'feature',
      outputPath: './my-service-template',
      cwd: info.rootDir,
    });
    const result = executeTemplateScaffold(plan, info, fixedClock, 'scaffold-1');
    expect(result.writtenFiles.length).toBe(5);

    const pack = loadTemplatePack(readTemplatePackDirectory(plan.outputDir), { requireReadme: true });
    expect(pack.valid, JSON.stringify(pack.issues)).toBe(true);
    expect(pack.manifest?.kind).toBe('feature');
    expect(pack.readme).toContain('specbridge template validate');
    expect(pack.readme).toContain('Contribution checklist');

    const { records } = readTemplateRecords(info);
    expect(records[0]?.type).toBe('template-scaffold');
  });

  it('scaffolds a valid bugfix pack that installs and applies', () => {
    const info = workspace();
    const plan = planTemplateScaffold({
      templateId: 'my-bugfix-template',
      kind: 'bugfix',
      outputPath: './my-bugfix-template',
      cwd: info.rootDir,
    });
    executeTemplateScaffold(plan, info, fixedClock, 'scaffold-2');
    expect([...plan.files.keys()]).toContain('files/bugfix.md.template');

    const installPlan = planTemplateInstall(info, loadTemplateCatalog(info), {
      sourcePath: './my-bugfix-template',
    });
    executeTemplateInstall(info, installPlan, fixedClock, 'scaffold-install');
    const applyPlan = planTemplateApplication(
      info,
      loadTemplateCatalog(info),
      { reference: 'project:my-bugfix-template', specName: 'scaffolded-fix' },
      fixedClock,
    );
    executeTemplateApplication(info, applyPlan, fixedClock, 'scaffold-apply');
    expect(readdirSync(path.join(info.rootDir, '.kiro', 'specs', 'scaffolded-fix')).sort()).toEqual([
      'bugfix.md',
      'design.md',
      'tasks.md',
    ]);
  });

  it('rejects an invalid template ID with SBT003', () => {
    expect(() =>
      planTemplateScaffold({ templateId: 'Bad_Name', kind: 'feature', outputPath: './x', cwd: freshKiroWorkspace() }),
    ).toThrowError(/SBT003/);
  });

  it('never overwrites an existing output directory', () => {
    const info = workspace();
    const existing = path.join(info.rootDir, 'taken');
    mkdirSync(existing);
    writeFileSync(path.join(existing, 'keep.txt'), 'mine', 'utf8');
    expect(() =>
      planTemplateScaffold({ templateId: 'taken', kind: 'feature', outputPath: './taken', cwd: info.rootDir }),
    ).toThrowError(/SBT025/);
    expect(readFileSync(path.join(existing, 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('rejects output outside the current directory with SBT007', () => {
    const info = workspace();
    expect(() =>
      planTemplateScaffold({ templateId: 'escapee', kind: 'feature', outputPath: '../escapee', cwd: info.rootDir }),
    ).toThrowError(/SBT007/);
  });

  it('works without a workspace (no record, still valid)', () => {
    const dir = freshKiroWorkspace();
    const plan = planTemplateScaffold({ templateId: 'standalone', kind: 'feature', outputPath: './standalone', cwd: dir });
    const result = executeTemplateScaffold(plan, undefined, fixedClock);
    expect(result.recordId).toBeUndefined();
    expect(existsSync(path.join(dir, 'standalone', 'specbridge-template.json'))).toBe(true);
  });
});
