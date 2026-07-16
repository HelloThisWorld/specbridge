import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createExtensionVerifierHook,
  describeEnablement,
  enableExtension,
  installExtensionFromDirectory,
} from '@specbridge/extensions';
import { setupVerifyFixture } from '../helpers-verify';
import {
  buildExtensionPackageFiles,
  PLAIN_VERIFIER_ENTRYPOINT,
  verifierManifest,
  writePackageDir,
} from '../helpers-extensions';

async function installVerifier(fixtureWorkspace: Parameters<typeof installExtensionFromDirectory>[1]['workspace']): Promise<void> {
  const dir = writePackageDir(
    buildExtensionPackageFiles(verifierManifest(), {
      'dist/extension.cjs': PLAIN_VERIFIER_ENTRYPOINT,
    }),
  );
  installExtensionFromDirectory(dir, {
    workspace: fixtureWorkspace,
    sourceLabel: `local-directory:${dir}`,
  });
  const preview = describeEnablement(fixtureWorkspace, 'demo-verifier');
  await enableExtension({
    workspace: fixtureWorkspace,
    id: 'demo-verifier',
    acceptPermissions: preview.permissionHash,
  });
}

describe('extension verifiers in the verification gate', () => {
  it('required extension failure fails the gate via SBV026; results land in the report', async () => {
    const fixture = setupVerifyFixture();
    await installVerifier(fixture.workspace);
    fixture.writePolicy({
      extensionVerifiers: [
        { extension: 'demo-verifier', required: true, configuration: { status: 'failed' } },
      ],
    });
    fixture.write('src/feature.ts', 'export const changed = true;\n');

    const tasksPath = path.join(fixture.root, '.kiro', 'specs', fixture.specName, 'tasks.md');
    const tasksBefore = readFileSync(tasksPath, 'utf8');

    const result = await fixture.verify({
      extensionVerifiers: createExtensionVerifierHook(fixture.workspace),
    });

    expect(result.report.summary.result).toBe('failed');
    const rollups = result.report.specResults
      .flatMap((spec) => spec.diagnostics)
      .filter((diagnostic) => diagnostic.ruleId === 'SBV026');
    expect(rollups).toHaveLength(1);
    expect(rollups[0]?.severity).toBe('error');

    const entries = result.report.extensionVerifiers ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe('failed');
    expect(entries[0]?.diagnostics[0]?.ruleId).toBe('demo-verifier/TESTS_MISSING');
    expect(entries[0]?.diagnostics[0]?.confidence).toBe('heuristic');

    // The extension verifier can never mark tasks complete.
    expect(readFileSync(tasksPath, 'utf8')).toBe(tasksBefore);
  });

  it('optional extension failure warns without failing the gate', async () => {
    const fixture = setupVerifyFixture();
    await installVerifier(fixture.workspace);
    fixture.writePolicy({
      extensionVerifiers: [
        { extension: 'demo-verifier', required: false, configuration: { status: 'failed' } },
      ],
    });

    const result = await fixture.verify({
      extensionVerifiers: createExtensionVerifierHook(fixture.workspace),
    });
    expect(result.report.summary.result).toBe('passed');
    const rollups = result.report.specResults
      .flatMap((spec) => spec.diagnostics)
      .filter((diagnostic) => diagnostic.ruleId === 'SBV026');
    expect(rollups[0]?.severity).toBe('warning');
  });

  it('a passing extension verifier adds no SBV026 diagnostics', async () => {
    const fixture = setupVerifyFixture();
    await installVerifier(fixture.workspace);
    fixture.writePolicy({
      extensionVerifiers: [{ extension: 'demo-verifier', required: true, configuration: {} }],
    });
    const result = await fixture.verify({
      extensionVerifiers: createExtensionVerifierHook(fixture.workspace),
    });
    expect(result.report.summary.result).toBe('passed');
    expect((result.report.extensionVerifiers ?? [])[0]?.status).toBe('passed');
    expect(
      result.report.specResults.flatMap((spec) => spec.diagnostics).some((d) => d.ruleId === 'SBV026'),
    ).toBe(false);
  });

  it('a missing or crashing required extension fails clearly and never crashes SpecBridge', async () => {
    const fixture = setupVerifyFixture();
    fixture.writePolicy({
      extensionVerifiers: [{ extension: 'ghost-verifier', required: true, configuration: {} }],
    });
    const missing = await fixture.verify({
      extensionVerifiers: createExtensionVerifierHook(fixture.workspace),
    });
    expect(missing.report.summary.result).toBe('failed');
    expect((missing.report.extensionVerifiers ?? [])[0]?.status).toBe('error');
    expect((missing.report.extensionVerifiers ?? [])[0]?.summary).toContain('SBE001');

    // A crashing extension process degrades to a status:error entry.
    await installVerifier(fixture.workspace);
    const installedEntrypoint = path.join(
      fixture.workspace.sidecarDir,
      'extensions',
      'installed',
      'demo-verifier',
      '1.0.0',
      'dist',
      'extension.cjs',
    );
    writeFileSync(installedEntrypoint, 'process.exit(7);\n', 'utf8');
    fixture.writePolicy({
      extensionVerifiers: [{ extension: 'demo-verifier', required: true, configuration: {} }],
    });
    const crashed = await fixture.verify({
      extensionVerifiers: createExtensionVerifierHook(fixture.workspace),
    });
    expect(crashed.report.summary.result).toBe('failed');
    expect((crashed.report.extensionVerifiers ?? [])[0]?.status).toBe('error');
  });
});
