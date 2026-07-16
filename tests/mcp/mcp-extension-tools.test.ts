import { describe, expect, it } from 'vitest';
import { callTool, connectMcp } from '../helpers-mcp';
import { fixedClock } from '../helpers';
import { freshKiroWorkspace } from '../helpers-templates';
import { analyzerManifest, installAndEnableTestExtension, installTestExtension } from '../helpers-extensions';

describe('extension_* MCP tools (read-only)', () => {
  it('extension_list paginates installed extensions and never enables anything', async () => {
    const root = freshKiroWorkspace();
    installTestExtension(root, analyzerManifest());
    installTestExtension(root, analyzerManifest({ id: 'second-analyzer' }));
    const session = await connectMcp(root, { clock: fixedClock });
    try {
      const result = await callTool(session, 'extension_list', { limit: 1 });
      expect(result.isError).toBe(false);
      const extensions = result.structured['extensions'] as Array<{ id: string; enabled: boolean }>;
      expect(extensions).toHaveLength(1);
      expect(result.structured['totalCount']).toBe(2);
      expect(result.structured['nextCursor']).toBeTruthy();
      expect(extensions[0]?.enabled).toBe(false);

      const filtered = await callTool(session, 'extension_list', { enabled: true });
      expect((filtered.structured['extensions'] as unknown[]).length).toBe(0);
    } finally {
      await session.close();
    }
  });

  it('extension_show exposes the permission hash and enable command, never secrets', async () => {
    const root = freshKiroWorkspace();
    installTestExtension(root, analyzerManifest());
    const session = await connectMcp(root, { clock: fixedClock });
    try {
      const result = await callTool(session, 'extension_show', { extensionId: 'demo-analyzer' });
      expect(result.isError).toBe(false);
      expect(result.structured['permissionHash']).toMatch(/^[0-9a-f]{64}$/);
      expect(String(result.structured['enableCommand'])).toContain('--accept-permissions');
      expect(result.structured['grantStatus']).toBe('none');
    } finally {
      await session.close();
    }
  });

  it('extension_doctor performs only the bounded handshake for enabled extensions', async () => {
    const root = freshKiroWorkspace();
    await installAndEnableTestExtension(root, analyzerManifest());
    const session = await connectMcp(root, { clock: fixedClock });
    try {
      const result = await callTool(session, 'extension_doctor', { extensionId: 'demo-analyzer' });
      expect(result.isError).toBe(false);
      expect(result.structured['ok']).toBe(true);
      expect((result.structured['handshake'] as { ok: boolean }).ok).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('extension_search and registry tools work offline against the built-in registry', async () => {
    const root = freshKiroWorkspace();
    const session = await connectMcp(root, { clock: fixedClock });
    try {
      const registries = await callTool(session, 'registry_list', {});
      expect(registries.isError).toBe(false);
      const rows = registries.structured['registries'] as Array<{ name: string; type: string }>;
      expect(rows.some((row) => row.type === 'builtin')).toBe(true);

      const search = await callTool(session, 'registry_search', { query: 'example-analyzer' });
      expect(search.isError).toBe(false);
      const results = search.structured['results'] as Array<{ id: string; registryName: string }>;
      expect(results[0]?.id).toBe('example-analyzer');

      const show = await callTool(session, 'registry_show', { extensionId: 'example-analyzer' });
      expect(show.isError).toBe(false);
      const matches = show.structured['matches'] as Array<{ versions: Array<{ sha256: string }> }>;
      expect(matches[0]?.versions[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);

      const combined = await callTool(session, 'extension_search', { query: 'example-verifier' });
      expect(combined.isError).toBe(false);
      const registryHits = combined.structured['registry'] as Array<{ id: string }>;
      expect(registryHits.some((hit) => hit.id === 'example-verifier')).toBe(true);
    } finally {
      await session.close();
    }
  });
});
