import { describe, expect, it } from 'vitest';
import { requireWorkspace } from '@specbridge/core';
import {
  downloadRegistryArchive,
  isRegistryError,
  readRegistryCache,
  updateRegistryIndex,
  type RegistryHttpRequest,
} from '@specbridge/registry';
import { installExtensionFromArchiveBytes, createDeterministicZip } from '@specbridge/extensions';
import { freshKiroWorkspace } from '../helpers-templates';
import { analyzerManifest, buildExtensionPackageFiles } from '../helpers-extensions';

const SOURCE = { name: 'community', type: 'https', url: 'https://example.invalid/index.json', enabled: true } as const;

const VALID_INDEX = JSON.stringify({
  schemaVersion: '1.0.0',
  name: 'community',
  updatedAt: '2026-01-01T00:00:00.000Z',
  extensions: [],
});

function fakeHttp(response: Awaited<ReturnType<RegistryHttpRequest>>): RegistryHttpRequest {
  return async () => response;
}

async function expectRegistryCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(isRegistryError(error), String(error)).toBe(true);
    if (isRegistryError(error)) {
      expect(error.registryCode).toBe(code);
    }
    return;
  }
  throw new Error(`expected ${code} but the call succeeded`);
}

describe('registry network operations', () => {
  it('refuses without --network (SBR004) and caches a validated index with it', async () => {
    const workspace = requireWorkspace(freshKiroWorkspace());
    await expectRegistryCode(
      updateRegistryIndex(workspace, SOURCE, { network: false, http: fakeHttp({ ok: true, bodyText: VALID_INDEX }) }),
      'SBR004',
    );
    expect(readRegistryCache(workspace, 'community').cache).toBeUndefined();

    const result = await updateRegistryIndex(workspace, SOURCE, {
      network: true,
      http: fakeHttp({ ok: true, bodyText: VALID_INDEX }),
      clock: () => new Date('2026-01-02T00:00:00.000Z'),
    });
    expect(result.extensionCount).toBe(0);
    expect(readRegistryCache(workspace, 'community').cache?.retrievedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('an invalid update preserves the previously valid cache', async () => {
    const workspace = requireWorkspace(freshKiroWorkspace());
    await updateRegistryIndex(workspace, SOURCE, {
      network: true,
      http: fakeHttp({ ok: true, bodyText: VALID_INDEX }),
    });
    const before = readRegistryCache(workspace, 'community').cache;
    expect(before).toBeDefined();

    await expectRegistryCode(
      updateRegistryIndex(workspace, SOURCE, {
        network: true,
        http: fakeHttp({ ok: true, bodyText: '{"schemaVersion":"9.0.0"}' }),
      }),
      'SBR007',
    );
    expect(readRegistryCache(workspace, 'community').cache).toEqual(before);

    await expectRegistryCode(
      updateRegistryIndex(workspace, SOURCE, {
        network: true,
        http: fakeHttp({ ok: false, kind: 'redirect-rejected', detail: 'https to http downgrade' }),
      }),
      'SBR009',
    );
    await expectRegistryCode(
      updateRegistryIndex(workspace, SOURCE, {
        network: true,
        http: fakeHttp({ ok: false, kind: 'response-too-large' }),
      }),
      'SBR006',
    );
    expect(readRegistryCache(workspace, 'community').cache).toEqual(before);
  });

  it('archive downloads are byte-exact, https-only, and hash-verified end to end', async () => {
    const workspace = requireWorkspace(freshKiroWorkspace());
    const archive = createDeterministicZip(buildExtensionPackageFiles(analyzerManifest()));

    await expectRegistryCode(
      downloadRegistryArchive('http://example.invalid/a.zip', {
        network: true,
        http: fakeHttp({ ok: true, bodyBase64: archive.toString('base64') }),
        maxArchiveBytes: 50 * 1024 * 1024,
      }),
      'SBR013',
    );
    await expectRegistryCode(
      downloadRegistryArchive('https://user:pass@example.invalid/a.zip', {
        network: true,
        http: fakeHttp({ ok: true, bodyBase64: archive.toString('base64') }),
        maxArchiveBytes: 50 * 1024 * 1024,
      }),
      'SBR013',
    );
    await expectRegistryCode(
      downloadRegistryArchive('https://example.invalid/a.zip', {
        network: false,
        http: fakeHttp({ ok: true, bodyBase64: archive.toString('base64') }),
        maxArchiveBytes: 50 * 1024 * 1024,
      }),
      'SBR004',
    );

    const downloaded = await downloadRegistryArchive('https://example.invalid/a.zip', {
      network: true,
      http: fakeHttp({ ok: true, bodyBase64: archive.toString('base64') }),
      maxArchiveBytes: 50 * 1024 * 1024,
    });
    expect(downloaded.equals(archive)).toBe(true);

    // A substituted archive fails the registry-declared hash at install time.
    try {
      installExtensionFromArchiveBytes(downloaded, {
        workspace,
        sourceLabel: 'registry:community',
        expectedArchiveSha256: 'f'.repeat(64),
      });
      throw new Error('expected SBE009');
    } catch (error) {
      expect(error instanceof Error && error.message.includes('SBE009')).toBe(true);
    }
  });
});
