import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveWorkspace } from '@specbridge/core';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import { analyzeSpecStage } from '@specbridge/workflow';
import type { TemplateCatalog } from '@specbridge/templates';
import {
  BUILTIN_TEMPLATE_PACKS,
  checkPackRendering,
  executeTemplateApplication,
  loadTemplatePack,
  planTemplateApplication,
  readTemplatePackDirectory,
} from '@specbridge/templates';
import { fixedClock } from '../helpers';
import { freshKiroWorkspace } from '../helpers-templates';

/**
 * Validates every built-in template pack FROM DISK
 * (packages/templates/builtins/<id>/) — the contributor-facing source of
 * truth — and checks the committed generated module matches it. A new
 * built-in template only needs pack files plus this suite passing; no
 * TypeScript required.
 */

const builtinsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'packages',
  'templates',
  'builtins',
);

const packIds = readdirSync(builtinsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort((a, b) => a.localeCompare(b, 'en'));

function diskCatalog(): TemplateCatalog {
  return {
    entries: packIds.map((id) => {
      const pack = loadTemplatePack(readTemplatePackDirectory(path.join(builtinsDir, id)), {
        requireReadme: true,
      });
      return { source: 'builtin' as const, id, ref: `builtin:${id}`, pack, valid: pack.valid };
    }),
    diagnostics: [],
  };
}

describe('built-in template packs (from disk)', () => {
  it('finds at least the two reference packs', () => {
    expect(packIds).toContain('rest-api');
    expect(packIds).toContain('bugfix-regression');
  });

  for (const id of packIds) {
    describe(id, () => {
      const packDir = path.join(builtinsDir, id);

      it('has a valid manifest, README, and declared files', () => {
        const pack = loadTemplatePack(readTemplatePackDirectory(packDir), { requireReadme: true });
        expect(pack.issues.filter((issue) => issue.severity === 'error'), JSON.stringify(pack.issues, null, 2)).toEqual([]);
        expect(pack.manifest?.id).toBe(id);
        expect(pack.readme).toBeDefined();
        expect(pack.manifest?.license).toBe('MIT');
        expect(pack.manifest?.compatibility.specbridge).toBe('>=0.7.0 <1.0.0');
      });

      it('render-checks cleanly with sample values', () => {
        const pack = loadTemplatePack(readTemplatePackDirectory(packDir), { requireReadme: true });
        const issues = checkPackRendering(pack, fixedClock);
        expect(issues.filter((issue) => issue.severity === 'error'), JSON.stringify(issues, null, 2)).toEqual([]);
      });

      it('applies into a fresh workspace and passes deterministic spec analysis', () => {
        const root = freshKiroWorkspace();
        const info = resolveWorkspace(root);
        if (info === undefined) throw new Error('workspace setup failed');
        const plan = planTemplateApplication(
          info,
          diskCatalog(),
          { reference: `builtin:${id}`, specName: `${id}-e2e` },
          fixedClock,
        );
        executeTemplateApplication(info, plan, fixedClock, `disk-${id}`);

        const refreshed = resolveWorkspace(root);
        if (refreshed === undefined) throw new Error('workspace vanished');
        const analysis = analyzeSpec(refreshed, requireSpec(refreshed, `${id}-e2e`));
        expect(
          analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
          JSON.stringify(analysis.diagnostics, null, 2),
        ).toEqual([]);
        expect(analysis.classification.completeness).toBe('complete');
        for (const stage of plan.specPlan.files.map((file) => file.stage)) {
          const stageAnalysis = analyzeSpecStage(analysis, stage, { placeholderSeverity: 'warning', missingFileSeverity: 'error' });
          expect(
            stageAnalysis.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
            `${stage}: ${JSON.stringify(stageAnalysis.diagnostics, null, 2)}`,
          ).toEqual([]);
        }
      });

      it('contains no vendor lock-in, employer terms, or absolute paths', () => {
        const data = readTemplatePackDirectory(packDir);
        for (const [name, content] of data.files) {
          const label = `${id}/${name}`;
          expect(content, label).not.toMatch(/[A-Za-z]:\\/);
          expect(content, label).not.toMatch(/\/(home|Users)\/[a-z]/);
          expect(content, label).not.toMatch(/\r\n/);
        }
      });
    });
  }

  it('generated module matches the packs on disk (run pnpm generate:builtin-templates after edits)', () => {
    const diskIds = packIds;
    const generatedIds = BUILTIN_TEMPLATE_PACKS.map((pack) => pack.id);
    expect(generatedIds).toEqual(diskIds);
    for (const generated of BUILTIN_TEMPLATE_PACKS) {
      const disk = readTemplatePackDirectory(path.join(builtinsDir, generated.id));
      const diskFiles = Object.fromEntries([...disk.files.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')));
      const generatedFiles = Object.fromEntries(
        Object.entries(generated.files).sort(([a], [b]) => a.localeCompare(b, 'en')),
      );
      expect(generatedFiles, generated.id).toEqual(diskFiles);
    }
  });
});
