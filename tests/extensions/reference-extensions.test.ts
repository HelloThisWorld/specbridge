import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildExtensionArchive,
  loadExtensionPackage,
  readExtensionPackageDirectory,
  runExtensionConformance,
  type EnabledExtension,
} from '@specbridge/extensions';
import { parseRegistryIndex } from '@specbridge/registry';

const EXAMPLES_DIR = path.resolve(__dirname, '..', '..', 'examples', 'extensions');
const REGISTRY_INDEX = path.resolve(__dirname, '..', '..', 'registry', 'index.json');

const REFERENCE_IDS = [
  'example-analyzer',
  'example-exporter',
  'example-runner',
  'example-template-provider',
  'example-verifier',
];

function pseudoEnabled(dir: string): EnabledExtension {
  const validation = loadExtensionPackage(readExtensionPackageDirectory(dir), {
    checksums: 'verify-if-present',
  });
  if (validation.manifest === undefined || validation.permissionHash === undefined || validation.manifestSha256 === undefined) {
    throw new Error(`reference extension at ${dir} failed validation`);
  }
  return {
    record: {
      id: validation.manifest.id,
      version: validation.manifest.version,
      kind: validation.manifest.kind,
      displayName: validation.manifest.displayName,
      description: validation.manifest.description,
      source: 'repository',
      installedAt: 'repository',
      manifestSha256: validation.manifestSha256,
      permissionHash: validation.permissionHash,
      ...(validation.manifest.entrypoint === undefined ? {} : { entrypoint: validation.manifest.entrypoint }),
      installRecordId: 'repository',
    },
    manifest: validation.manifest,
    installedDir: dir,
    permissionHash: validation.permissionHash,
    manifestSha256: validation.manifestSha256,
  };
}

describe('reference extensions', () => {
  it('all five kinds exist, validate, and package deterministically', () => {
    expect(readdirSync(EXAMPLES_DIR).sort()).toEqual([...REFERENCE_IDS].sort());
    for (const id of REFERENCE_IDS) {
      const dir = path.join(EXAMPLES_DIR, id);
      const validation = loadExtensionPackage(readExtensionPackageDirectory(dir), {
        checksums: 'verify-if-present',
      });
      expect(validation.manifest?.id, id).toBe(id);
      expect(validation.issues.filter((issue) => issue.severity === 'error'), id).toEqual([]);

      const first = buildExtensionArchive(dir, { dryRun: true });
      const second = buildExtensionArchive(dir, { dryRun: true });
      expect(first.archiveSha256, id).toBe(second.archiveSha256);

      // No reference extension declares network or child-process access.
      expect(validation.manifest?.permissions.network, id).toBe(false);
      expect(validation.manifest?.permissions.childProcess, id).toBe(false);
    }
  });

  it('every executable reference extension passes conformance', async () => {
    for (const id of REFERENCE_IDS) {
      const enabled = pseudoEnabled(path.join(EXAMPLES_DIR, id));
      const result = await runExtensionConformance(enabled, { checksums: 'verify-if-present' });
      expect(result.passed, `${id}: ${JSON.stringify(result.checks.filter((c) => c.status === 'failed'))}`).toBe(true);
    }
  }, 60_000);

  it('the example verifier labels itself heuristic and the analyzer is deterministic', () => {
    const verifier = readFileSync(path.join(EXAMPLES_DIR, 'example-verifier', 'dist', 'extension.cjs'), 'utf8');
    expect(verifier).toContain('heuristic');
    const analyzer = readFileSync(path.join(EXAMPLES_DIR, 'example-analyzer', 'dist', 'extension.cjs'), 'utf8');
    expect(analyzer).toContain('deterministic');
    expect(analyzer).not.toContain('Math.random');
  });

  it('the repository registry index lists exactly the reference extensions and validates', () => {
    const parsed = parseRegistryIndex(readFileSync(REGISTRY_INDEX, 'utf8'));
    expect(parsed.problems).toEqual([]);
    expect(parsed.index?.extensions.map((entry) => entry.id).sort()).toEqual([...REFERENCE_IDS].sort());
    // Registry hashes match the deterministic archives built from source.
    for (const entry of parsed.index?.extensions ?? []) {
      const built = buildExtensionArchive(path.join(EXAMPLES_DIR, entry.id), { dryRun: true });
      expect(entry.versions[0]?.sha256, entry.id).toBe(built.archiveSha256);
    }
  });
});
