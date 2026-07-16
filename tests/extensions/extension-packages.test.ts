import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { requireWorkspace } from '@specbridge/core';
import {
  computeExtensionChecksums,
  crc32,
  createDeterministicZip,
  describeEnablement,
  disableExtension,
  enableExtension,
  extractZipArchive,
  installExtensionFromArchiveBytes,
  installExtensionFromDirectory,
  isExtensionError,
  listInstalledExtensions,
  loadExtensionPackage,
  readExtensionPackageDirectory,
  readExtensionState,
  requireEnabledExtension,
  uninstallExtension,
} from '@specbridge/extensions';
import { freshKiroWorkspace, tryCreateSymlink } from '../helpers-templates';
import {
  analyzerManifest,
  buildExtensionPackageFiles,
  installTestExtension,
  templateProviderManifest,
  writePackageDir,
} from '../helpers-extensions';

function expectExtensionCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(isExtensionError(error), String(error)).toBe(true);
    if (isExtensionError(error)) {
      expect(error.extensionCode).toBe(code);
    }
    return;
  }
  throw new Error(`expected ${code} but nothing was thrown`);
}

describe('extension package validation', () => {
  it('accepts a fully valid analyzer package directory', () => {
    const dir = writePackageDir(buildExtensionPackageFiles(analyzerManifest()));
    const files = readExtensionPackageDirectory(dir);
    const validation = loadExtensionPackage(files);
    expect(validation.valid, JSON.stringify(validation.issues)).toBe(true);
    expect(validation.permissionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails when checksums.json is missing (SBE009)', () => {
    const files = buildExtensionPackageFiles(analyzerManifest());
    files.delete('checksums.json');
    const validation = loadExtensionPackage(files);
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((issue) => issue.code === 'SBE009')).toBe(true);
  });

  it('fails on checksum mismatch and undeclared files', () => {
    const tampered = buildExtensionPackageFiles(analyzerManifest());
    tampered.set('dist/extension.cjs', Buffer.from('tampered', 'utf8'));
    const mismatch = loadExtensionPackage(tampered);
    expect(mismatch.issues.some((issue) => issue.code === 'SBE009')).toBe(true);

    const withUndeclared = buildExtensionPackageFiles(analyzerManifest());
    withUndeclared.set('extra.txt', Buffer.from('surprise', 'utf8'));
    const undeclared = loadExtensionPackage(withUndeclared);
    expect(undeclared.issues.some((issue) => issue.code === 'SBE008' && issue.message.includes('not declared'))).toBe(true);
  });

  it('rejects forbidden package contents (SBE010)', () => {
    const files = buildExtensionPackageFiles(analyzerManifest(), {
      'dist/extension.cjs.map': '{}',
    });
    const validation = loadExtensionPackage(files);
    expect(validation.issues.some((issue) => issue.code === 'SBE010')).toBe(true);

    const dir = writePackageDir(buildExtensionPackageFiles(analyzerManifest()));
    writeFileSync(path.join(dir, 'node_modules'), '');
    // A node_modules *file* is caught by the forbidden-name rule at load time.
    const loaded = loadExtensionPackage(readExtensionPackageDirectory(dir));
    expect(loaded.issues.some((issue) => issue.code === 'SBE010')).toBe(true);
  });

  it('rejects lifecycle scripts in a bundled package.json (SBE010)', () => {
    const files = buildExtensionPackageFiles(analyzerManifest(), {
      'package.json': JSON.stringify({ name: 'x', scripts: { postinstall: 'evil' } }),
    });
    const validation = loadExtensionPackage(files);
    expect(
      validation.issues.some((issue) => issue.code === 'SBE010' && issue.message.includes('postinstall')),
    ).toBe(true);
  });

  it('fails when the declared entrypoint file is missing (SBE012)', () => {
    const files = buildExtensionPackageFiles(analyzerManifest());
    files.delete('dist/extension.cjs');
    const checksums = computeExtensionChecksums(files);
    files.set('checksums.json', Buffer.from(JSON.stringify(checksums), 'utf8'));
    const validation = loadExtensionPackage(files);
    expect(validation.issues.some((issue) => issue.code === 'SBE012')).toBe(true);
  });

  it('rejects symlinks inside a package directory (SBE011)', () => {
    const dir = writePackageDir(buildExtensionPackageFiles(analyzerManifest()));
    const created = tryCreateSymlink(path.join(dir, 'README.md'), path.join(dir, 'link.md'));
    if (!created) {
      return; // symlinks unavailable on this Windows configuration
    }
    expectExtensionCode(() => readExtensionPackageDirectory(dir), 'SBE011');
  });

  it('validates data-only template-provider packages through the template system', () => {
    const provider = templateProviderManifest();
    const good = buildExtensionPackageFiles(provider, {
      'templates/mini-pack/specbridge-template.json': JSON.stringify({
        schemaVersion: '1.0.0',
        id: 'mini-pack',
        version: '1.0.0',
        displayName: 'Mini Pack',
        description: 'A tiny valid template pack used to test provider validation.',
        kind: 'feature',
        supportedModes: ['quick'],
        defaultMode: 'quick',
        tags: ['test'],
        files: [
          {
            source: 'files/requirements.md.template',
            target: 'requirements.md',
            stage: 'requirements',
            required: true,
          },
          { source: 'files/design.md.template', target: 'design.md', stage: 'design', required: true },
          { source: 'files/tasks.md.template', target: 'tasks.md', stage: 'tasks', required: true },
        ],
        variables: [],
        compatibility: { specbridge: '>=0.7.0 <1.0.0', kiroLayout: '1' },
        license: 'MIT',
      }),
      'templates/mini-pack/README.md': '# Mini Pack\n',
      'templates/mini-pack/files/requirements.md.template': '# Requirements for {{specName}}\n',
      'templates/mini-pack/files/design.md.template': '# Design for {{specName}}\n',
      'templates/mini-pack/files/tasks.md.template': '# Tasks\n\n- [ ] 1. Implement {{specName}}\n',
    });
    const validation = loadExtensionPackage(good);
    expect(validation.valid, JSON.stringify(validation.issues)).toBe(true);

    const empty = loadExtensionPackage(buildExtensionPackageFiles(provider));
    expect(empty.issues.some((issue) => issue.message.includes('at least one template pack'))).toBe(true);
  });
});

describe('deterministic archives', () => {
  it('creates byte-identical archives for identical inputs and round-trips', () => {
    const files = buildExtensionPackageFiles(analyzerManifest());
    const a = createDeterministicZip(files);
    const b = createDeterministicZip(files);
    expect(a.equals(b)).toBe(true);

    const extracted = extractZipArchive(a);
    expect([...extracted.keys()].sort()).toEqual([...files.keys()].sort());
    for (const [name, content] of files) {
      expect(extracted.get(name)?.equals(content), name).toBe(true);
    }
  });

  it('rejects traversal entry names patched into an archive', () => {
    const files = new Map<string, Buffer>([
      ['aaa/evil.txt', Buffer.from('x', 'utf8')],
      ['keep.txt', Buffer.from('y', 'utf8')],
    ]);
    const archive = createDeterministicZip(files);
    // Same byte length, hostile content: "aaa/evil.txt" -> "../evil2.txt".
    const patched = Buffer.from(
      archive.toString('latin1').split('aaa/evil.txt').join('../evil2.txt'),
      'latin1',
    );
    expectExtensionCode(() => extractZipArchive(patched), 'SBE008');
  });

  it('fails CRC verification when content bytes are corrupted (SBE009)', () => {
    const files = new Map<string, Buffer>([['data.txt', Buffer.from('hello world', 'utf8')]]);
    const archive = createDeterministicZip(files);
    const index = archive.indexOf(Buffer.from('hello world', 'utf8'));
    const corrupted = Buffer.from(archive);
    corrupted[index] = corrupted[index]! ^ 0xff;
    expectExtensionCode(() => extractZipArchive(corrupted), 'SBE009');
  });

  it('rejects deflate entries that lie about their decompressed size (zip bomb)', () => {
    // Hand-build a one-entry deflate zip whose declared uncompressed size is
    // far smaller than the real inflated size.
    const realContent = Buffer.alloc(1024 * 1024, 0x61);
    const compressed = deflateRawSync(realContent);
    const name = Buffer.from('bomb.txt', 'utf8');
    const declaredUncompressed = 10; // lie
    const checksum = crc32(realContent);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declaredUncompressed, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredUncompressed, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);

    const centralStart = 30 + name.length + compressed.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(46 + name.length, 12);
    eocd.writeUInt32LE(centralStart, 16);

    const archive = Buffer.concat([local, name, compressed, central, name, eocd]);
    expectExtensionCode(() => extractZipArchive(archive), 'SBE008');
  });
});

describe('install, enable, disable, uninstall', () => {
  it('installs from a directory: disabled, recorded, revalidated, no code executed', () => {
    const root = freshKiroWorkspace();
    const manifest = analyzerManifest();
    const marker = path.join(root, 'executed.marker');
    const workspace = installTestExtension(root, manifest, {
      'dist/extension.cjs': `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`,
    });

    expect(existsSync(marker)).toBe(false); // install never executes code
    const { state } = readExtensionState(workspace);
    expect(state.installed).toHaveLength(1);
    expect(state.enabled).toEqual({});
    const installedDir = path.join(workspace.sidecarDir, 'extensions', 'installed', manifest.id, '1.0.0');
    expect(existsSync(path.join(installedDir, 'specbridge-extension.json'))).toBe(true);
    const records = readFileSync(path.join(workspace.sidecarDir, 'extensions', 'records.jsonl'), 'utf8');
    expect(records).toContain('"type":"install"');
  });

  it('rejects installing the same version twice (SBE013) and supports side-by-side versions', () => {
    const root = freshKiroWorkspace();
    const manifest = analyzerManifest();
    const workspace = installTestExtension(root, manifest);
    const dir = writePackageDir(buildExtensionPackageFiles(manifest));
    expectExtensionCode(
      () => installExtensionFromDirectory(dir, { workspace, sourceLabel: 'local-directory:x' }),
      'SBE013',
    );

    installTestExtension(root, analyzerManifest({ version: '1.1.0' }));
    const { state } = readExtensionState(workspace);
    expect(state.installed.map((record) => record.version).sort()).toEqual(['1.0.0', '1.1.0']);
    expect(state.enabled).toEqual({}); // a new version never auto-enables
  });

  it('dry-run and failed installs leave no partial state', () => {
    const root = freshKiroWorkspace();
    const workspace = requireWorkspace(root);
    const manifest = analyzerManifest();
    const dir = writePackageDir(buildExtensionPackageFiles(manifest));
    const result = installExtensionFromDirectory(dir, {
      workspace,
      sourceLabel: 'local-directory:x',
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(existsSync(path.join(workspace.sidecarDir, 'extensions'))).toBe(false);

    const broken = buildExtensionPackageFiles(manifest);
    broken.delete('LICENSE');
    const brokenDir = writePackageDir(broken);
    expectExtensionCode(
      () => installExtensionFromDirectory(brokenDir, { workspace, sourceLabel: 'local-directory:x' }),
      'SBE008',
    );
    expect(existsSync(path.join(workspace.sidecarDir, 'extensions', 'installed'))).toBe(false);
  });

  it('installs from archives and verifies the expected archive hash', () => {
    const root = freshKiroWorkspace();
    const workspace = requireWorkspace(root);
    const manifest = analyzerManifest();
    const archive = createDeterministicZip(buildExtensionPackageFiles(manifest));

    expectExtensionCode(
      () =>
        installExtensionFromArchiveBytes(archive, {
          workspace,
          sourceLabel: 'archive:test',
          expectedArchiveSha256: 'f'.repeat(64),
        }),
      'SBE009',
    );

    const result = installExtensionFromArchiveBytes(archive, {
      workspace,
      sourceLabel: 'archive:test',
    });
    expect(result.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readExtensionState(workspace).state.installed).toHaveLength(1);
  });

  it('enable requires the exact permission hash; disable stops invocation', async () => {
    const root = freshKiroWorkspace();
    const manifest = analyzerManifest();
    const workspace = installTestExtension(root, manifest);

    await expect(
      enableExtension({ workspace, id: manifest.id, acceptPermissions: 'a'.repeat(64) }),
    ).rejects.toMatchObject({ extensionCode: 'SBE017' });

    const preview = describeEnablement(workspace, manifest.id);
    expect(preview.grantStatus).toBe('none');
    const enabled = await enableExtension({
      workspace,
      id: manifest.id,
      acceptPermissions: preview.permissionHash,
    });
    expect(enabled.permissionHash).toBe(preview.permissionHash);
    expect(requireEnabledExtension(workspace, manifest.id).manifest.id).toBe(manifest.id);

    const catalog = listInstalledExtensions(workspace);
    expect(catalog.entries[0]?.enabled).toBe(true);
    expect(catalog.entries[0]?.permissionsAccepted).toBe(true);
    expect(catalog.entries[0]?.compatibility).toBe('compatible');

    disableExtension({ workspace, id: manifest.id });
    expectExtensionCode(() => requireEnabledExtension(workspace, manifest.id), 'SBE015');
  });

  it('detects stale grants after a manifest change (SBE018)', async () => {
    const root = freshKiroWorkspace();
    const manifest = analyzerManifest();
    const workspace = installTestExtension(root, manifest);
    const preview = describeEnablement(workspace, manifest.id);
    await enableExtension({ workspace, id: manifest.id, acceptPermissions: preview.permissionHash });

    // Tamper with the installed manifest but keep checksums internally
    // consistent, simulating a manifest replaced after acceptance.
    const installedDir = path.join(workspace.sidecarDir, 'extensions', 'installed', manifest.id, '1.0.0');
    const files = readExtensionPackageDirectory(installedDir);
    const escalated = analyzerManifest({
      permissions: { ...manifest.permissions, network: true },
    });
    files.set('specbridge-extension.json', Buffer.from(JSON.stringify(escalated, null, 2), 'utf8'));
    files.delete('checksums.json');
    const checksums = computeExtensionChecksums(files);
    files.set('checksums.json', Buffer.from(JSON.stringify(checksums), 'utf8'));
    for (const [name, content] of files) {
      writeFileSync(path.join(installedDir, ...name.split('/')), content);
    }

    expectExtensionCode(() => requireEnabledExtension(workspace, manifest.id), 'SBE018');
  });

  it('uninstall requires disabled state, blocks profile references, and is recoverable', async () => {
    const root = freshKiroWorkspace();
    const manifest = analyzerManifest();
    const workspace = installTestExtension(root, manifest);
    const preview = describeEnablement(workspace, manifest.id);
    await enableExtension({ workspace, id: manifest.id, acceptPermissions: preview.permissionHash });

    expectExtensionCode(() => uninstallExtension({ workspace, id: manifest.id }), 'SBE028');
    disableExtension({ workspace, id: manifest.id });
    expectExtensionCode(
      () => uninstallExtension({ workspace, id: manifest.id, referencingProfiles: ['custom'] }),
      'SBE029',
    );

    const result = uninstallExtension({ workspace, id: manifest.id });
    expect(result.dryRun).toBe(false);
    expect(existsSync(result.removedPath)).toBe(false);
    expect(result.trashPath !== undefined && existsSync(result.trashPath)).toBe(true);
    expect(readExtensionState(workspace).state.installed).toHaveLength(0);

    const records = readFileSync(path.join(workspace.sidecarDir, 'extensions', 'records.jsonl'), 'utf8');
    expect(records).toContain('"type":"uninstall"');
    expect(records).toContain('"type":"install"');

    const trashRoot = path.join(workspace.sidecarDir, 'extensions', 'trash');
    expect(readdirSync(trashRoot)).toHaveLength(1);
  });
});
