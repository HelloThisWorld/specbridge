import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSpecState, resolveWorkspace } from '@specbridge/core';
import type { WorkspaceInfo } from '@specbridge/core';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import { analyzeSpecStage } from '@specbridge/workflow';
import {
  BUILTIN_TEMPLATE_PACKS,
  executeTemplateApplication,
  loadTemplateCatalog,
  planTemplateApplication,
  readTemplateRecords,
} from '@specbridge/templates';
import { fixedClock } from '../helpers';
import { freshKiroWorkspace } from '../helpers-templates';

function workspace(): WorkspaceInfo {
  const info = resolveWorkspace(freshKiroWorkspace());
  if (info === undefined) throw new Error('workspace setup failed');
  return info;
}

function snapshotTree(root: string): string[] {
  if (!existsSync(root)) return [];
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

describe('template preview (planTemplateApplication)', () => {
  it('renders without writing anything', () => {
    const info = workspace();
    const before = snapshotTree(info.rootDir);
    const catalog = loadTemplateCatalog(info);
    const plan = planTemplateApplication(
      info,
      catalog,
      { reference: 'rest-api', specName: 'orders-endpoint', variables: { resourceName: 'order' } },
      fixedClock,
    );
    expect(plan.specPlan.files).toHaveLength(3);
    expect(plan.specPlan.files.map((file) => file.fileName)).toEqual(['requirements.md', 'design.md', 'tasks.md']);
    expect(plan.candidateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshotTree(info.rootDir)).toEqual(before);
  });

  it('substitutes variables into the rendered content', () => {
    const info = workspace();
    const catalog = loadTemplateCatalog(info);
    const plan = planTemplateApplication(
      info,
      catalog,
      {
        reference: 'rest-api',
        specName: 'orders-endpoint',
        title: 'Orders endpoint',
        variables: { resourceName: 'order', basePath: '/api/v1/orders' },
      },
      fixedClock,
    );
    const requirements = plan.specPlan.files.find((file) => file.fileName === 'requirements.md');
    expect(requirements?.content).toContain('**Orders endpoint**');
    expect(requirements?.content).toContain('`/api/v1/orders`');
    expect(requirements?.content).toContain('`order` resource');
    expect(requirements?.content).not.toContain('{{');
  });

  it('produces a deterministic candidate hash', () => {
    const info = workspace();
    const catalog = loadTemplateCatalog(info);
    const request = { reference: 'rest-api', specName: 'orders-endpoint', variables: { resourceName: 'order' } };
    const first = planTemplateApplication(info, catalog, request, fixedClock);
    const second = planTemplateApplication(info, catalog, request, fixedClock);
    expect(first.candidateHash).toBe(second.candidateHash);
    const changed = planTemplateApplication(
      info,
      catalog,
      { ...request, variables: { resourceName: 'invoice' } },
      fixedClock,
    );
    expect(changed.candidateHash).not.toBe(first.candidateHash);
  });

  it('rejects an unsupported workflow mode with the supported list', () => {
    const info = workspace();
    const catalog = loadTemplateCatalog(info);
    expect(() =>
      planTemplateApplication(
        info,
        catalog,
        { reference: 'bugfix-regression', specName: 'fix-me', mode: 'design-first' },
        fixedClock,
      ),
    ).toThrowError(/Supported modes/);
  });

  it('fails fast when the spec already exists (SBT020)', () => {
    const info = workspace();
    const catalog = loadTemplateCatalog(info);
    const plan = planTemplateApplication(info, catalog, { reference: 'rest-api', specName: 'dup' }, fixedClock);
    executeTemplateApplication(info, plan, fixedClock, 'record-1');
    expect(() =>
      planTemplateApplication(info, catalog, { reference: 'rest-api', specName: 'dup' }, fixedClock),
    ).toThrowError(/SBT020/);
  });
});

describe('template apply (executeTemplateApplication)', () => {
  it('creates a Kiro-compatible spec atomically with unapproved sidecar state', () => {
    const info = workspace();
    const catalog = loadTemplateCatalog(info);
    const plan = planTemplateApplication(
      info,
      catalog,
      { reference: 'rest-api', specName: 'orders-endpoint', variables: { resourceName: 'order' } },
      fixedClock,
    );
    const result = executeTemplateApplication(info, plan, fixedClock, 'record-apply-1');

    const specDir = path.join(info.rootDir, '.kiro', 'specs', 'orders-endpoint');
    expect(readdirSync(specDir).sort()).toEqual(['design.md', 'requirements.md', 'tasks.md']);
    for (const file of result.creation.writtenFiles) {
      expect(existsSync(file)).toBe(true);
    }
    // No template metadata leaks into .kiro files.
    for (const name of readdirSync(specDir)) {
      const content = readFileSync(path.join(specDir, name), 'utf8');
      expect(content).not.toContain('specbridge-template');
      expect(content).not.toContain('template-records');
      expect(content).not.toMatch(/^---/m);
    }

    const stateRead = readSpecState(info, 'orders-endpoint');
    expect(stateRead.state).toBeDefined();
    expect(stateRead.state?.specType).toBe('feature');
    for (const stage of ['requirements', 'design', 'tasks'] as const) {
      expect(stateRead.state?.stages[stage]?.status).not.toBe('approved');
      expect(stateRead.state?.stages[stage]?.approvedHash).toBeNull();
    }
  });

  it('appends an append-only apply record with hashes and variable names, never values', () => {
    const info = workspace();
    const catalog = loadTemplateCatalog(info);
    const plan = planTemplateApplication(
      info,
      catalog,
      {
        reference: 'rest-api',
        specName: 'orders-endpoint',
        variables: { resourceName: 'super-secret-value' },
      },
      fixedClock,
    );
    executeTemplateApplication(info, plan, fixedClock, 'record-apply-2');

    const { records } = readTemplateRecords(info);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record?.type).toBe('template-apply');
    if (record?.type !== 'template-apply') throw new Error('unexpected record type');
    expect(record.templateRef).toBe('builtin:rest-api');
    expect(record.specName).toBe('orders-endpoint');
    expect(record.variableNames).toContain('resourceName');
    expect(record.renderedFiles).toHaveLength(3);
    const raw = readFileSync(path.join(info.sidecarDir, 'template-records.jsonl'), 'utf8');
    expect(raw).not.toContain('super-secret-value');

    // Records accumulate; nothing is rewritten.
    const planB = planTemplateApplication(info, catalog, { reference: 'bugfix-regression', specName: 'second' }, fixedClock);
    executeTemplateApplication(info, planB, fixedClock, 'record-apply-3');
    const after = readTemplateRecords(info);
    expect(after.records.map((r) => r.recordId)).toEqual(['record-apply-2', 'record-apply-3']);
  });

  it('never overwrites an existing spec, even at execute time', () => {
    const info = workspace();
    const catalog = loadTemplateCatalog(info);
    const planA = planTemplateApplication(info, catalog, { reference: 'rest-api', specName: 'race' }, fixedClock);
    const planB = planTemplateApplication(info, catalog, { reference: 'rest-api', specName: 'race' }, fixedClock);
    executeTemplateApplication(info, planA, fixedClock, 'race-1');
    expect(() => executeTemplateApplication(info, planB, fixedClock, 'race-2')).toThrowError(/SBT020/);
    // The survivor is intact.
    expect(readdirSync(path.join(info.rootDir, '.kiro', 'specs', 'race')).sort()).toEqual([
      'design.md',
      'requirements.md',
      'tasks.md',
    ]);
  });

  it('bugfix templates create the bugfix file set', () => {
    const info = workspace();
    const catalog = loadTemplateCatalog(info);
    const plan = planTemplateApplication(
      info,
      catalog,
      { reference: 'bugfix-regression', specName: 'fix-rounding', variables: { severity: 'high' } },
      fixedClock,
    );
    executeTemplateApplication(info, plan, fixedClock, 'bugfix-1');
    const specDir = path.join(info.rootDir, '.kiro', 'specs', 'fix-rounding');
    expect(readdirSync(specDir).sort()).toEqual(['bugfix.md', 'design.md', 'tasks.md']);
    expect(readFileSync(path.join(specDir, 'bugfix.md'), 'utf8')).toContain('Severity: high');
    const stateRead = readSpecState(info, 'fix-rounding');
    expect(stateRead.state?.specType).toBe('bugfix');
  });
});

describe('built-in templates end to end', () => {
  it('every built-in applies cleanly and passes deterministic spec analysis', () => {
    for (const packData of BUILTIN_TEMPLATE_PACKS) {
      const info = workspace();
      const catalog = loadTemplateCatalog(info);
      const specName = `${packData.id}-check`;
      const plan = planTemplateApplication(
        info,
        catalog,
        { reference: `builtin:${packData.id}`, specName },
        fixedClock,
      );
      executeTemplateApplication(info, plan, fixedClock, `builtin-${packData.id}`);

      // Re-resolve: `.kiro/specs/` did not exist when `info` was captured.
      const refreshed = resolveWorkspace(info.rootDir);
      if (refreshed === undefined) throw new Error('workspace vanished');
      const folder = requireSpec(refreshed, specName);
      const analysis = analyzeSpec(refreshed, folder);
      const errors = analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
      expect(errors, `${packData.id}: ${JSON.stringify(errors)}`).toEqual([]);
      expect(analysis.classification.completeness).toBe('complete');

      // Stage-level analyzers must not produce error-severity findings for
      // fresh template output (placeholders are warnings on a draft).
      for (const stage of plan.specPlan.files.map((file) => file.stage)) {
        const stageAnalysis = analyzeSpecStage(analysis, stage, { placeholderSeverity: 'warning', missingFileSeverity: 'error' });
        const stageErrors = stageAnalysis.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
        expect(stageErrors, `${packData.id}/${stage}: ${JSON.stringify(stageErrors)}`).toEqual([]);
      }
    }
  });

  it('built-ins contain no accidental unresolved placeholders after rendering', () => {
    for (const packData of BUILTIN_TEMPLATE_PACKS) {
      const info = workspace();
      const catalog = loadTemplateCatalog(info);
      const plan = planTemplateApplication(
        info,
        catalog,
        { reference: `builtin:${packData.id}`, specName: 'placeholder-check' },
        fixedClock,
      );
      for (const file of plan.specPlan.files) {
        expect(file.content, `${packData.id}/${file.fileName}`).not.toMatch(/\{\{[a-z][a-zA-Z0-9]*\}\}/);
      }
    }
  });

  it('built-ins contain no employer-specific terms or absolute local paths', () => {
    for (const packData of BUILTIN_TEMPLATE_PACKS) {
      for (const [name, content] of Object.entries(packData.files)) {
        const label = `${packData.id}/${name}`;
        expect(content, label).not.toMatch(/[A-Za-z]:\\/);
        expect(content, label).not.toMatch(/\/(home|Users)\/[a-z]/);
        expect(content.toLowerCase(), label).not.toContain('acme corp');
        expect(content.toLowerCase(), label).not.toContain('internal use only');
      }
    }
  });
});
