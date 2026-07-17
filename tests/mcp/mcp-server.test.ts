import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  MCP_PROTOCOL_BASELINE,
  MCP_SDK_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  PROMPT_CATALOG,
  RESOURCE_CATALOG,
  TOOL_CATALOG,
  decodeCursor,
  encodeCursor,
  paginate,
  resolveProjectRoot,
  runMcpDoctor,
  truncateText,
} from '@specbridge/mcp-server';
import { copyFixtureToTemp, emptyTempDir } from '../helpers.js';
import { connectMcp } from '../helpers-mcp.js';

/**
 * Server identity, protocol negotiation, registry integrity, project-root
 * resolution, and the bounded-output primitives.
 */

describe('server initialization', () => {
  it('reports name and version through MCP initialization', async () => {
    const session = await connectMcp(copyFixtureToTemp('standard-feature'));
    try {
      const serverInfo = session.client.getServerVersion();
      expect(serverInfo?.name).toBe(MCP_SERVER_NAME);
      expect(serverInfo?.version).toBe(MCP_SERVER_VERSION);
      expect(MCP_SERVER_VERSION).toBe('1.0.0');
    } finally {
      await session.close();
    }
  });

  it('negotiates the stable protocol through the SDK', async () => {
    const session = await connectMcp(copyFixtureToTemp('standard-feature'));
    try {
      // A successful initialize + tools/list round trip proves negotiation.
      const tools = await session.client.listTools();
      expect(tools.tools.length).toBe(TOOL_CATALOG.length);
      expect(MCP_PROTOCOL_BASELINE).toBe('2025-11-25');
      expect(MCP_SDK_VERSION).toBe('1.29.0');
    } finally {
      await session.close();
    }
  });

  it('rejects a missing project root with an actionable message', () => {
    const resolution = resolveProjectRoot({ flagValue: 'Z:/definitely/not/here-xyz', env: {} });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.message).toContain('does not exist');
      expect(resolution.remediation.length).toBeGreaterThan(0);
    }
  });

  it('rejects null bytes in the project root', () => {
    const resolution = resolveProjectRoot({ flagValue: 'foo\0bar', env: {} });
    expect(resolution.ok).toBe(false);
  });

  it('resolution honors the documented precedence order', () => {
    const root = emptyTempDir();
    const other = emptyTempDir();
    const viaFlag = resolveProjectRoot({
      flagValue: root,
      env: { SPECBRIDGE_PROJECT_ROOT: other, CLAUDE_PROJECT_DIR: other },
    });
    expect(viaFlag.ok && viaFlag.source).toBe('flag');
    const viaEnv = resolveProjectRoot({ env: { SPECBRIDGE_PROJECT_ROOT: root } });
    expect(viaEnv.ok && viaEnv.source).toBe('SPECBRIDGE_PROJECT_ROOT');
    const viaClaude = resolveProjectRoot({ env: { CLAUDE_PROJECT_DIR: root } });
    expect(viaClaude.ok && viaClaude.source).toBe('CLAUDE_PROJECT_DIR');
    const viaCwd = resolveProjectRoot({ env: {}, cwd: root });
    expect(viaCwd.ok && viaCwd.source).toBe('cwd');
  });
});

describe('tool registry', () => {
  it('tool names are unique and the listing is deterministic', async () => {
    const session = await connectMcp(copyFixtureToTemp('standard-feature'));
    try {
      const first = await session.client.listTools();
      const second = await session.client.listTools();
      const names = first.tools.map((tool) => tool.name);
      expect(new Set(names).size).toBe(names.length);
      expect(second.tools.map((tool) => tool.name)).toEqual(names);
      expect(names.sort()).toEqual(TOOL_CATALOG.map((tool) => tool.name).sort());
    } finally {
      await session.close();
    }
  });

  it('every tool declares input schema, output schema, and annotations', async () => {
    const session = await connectMcp(copyFixtureToTemp('standard-feature'));
    try {
      const { tools } = await session.client.listTools();
      for (const tool of tools) {
        expect(tool.inputSchema, `${tool.name} input schema`).toBeDefined();
        expect(tool.outputSchema, `${tool.name} output schema`).toBeDefined();
        expect(tool.annotations, `${tool.name} annotations`).toBeDefined();
        expect(typeof tool.annotations?.readOnlyHint).toBe('boolean');
        expect(typeof tool.annotations?.destructiveHint).toBe('boolean');
        expect(typeof tool.annotations?.idempotentHint).toBe('boolean');
        expect(typeof tool.annotations?.openWorldHint).toBe('boolean');
        expect(tool.description !== undefined && tool.description.length > 10).toBe(true);
      }
    } finally {
      await session.close();
    }
  });

  it('read-only annotations match the documented catalog', async () => {
    const session = await connectMcp(copyFixtureToTemp('standard-feature'));
    try {
      const { tools } = await session.client.listTools();
      for (const tool of tools) {
        const catalog = TOOL_CATALOG.find((entry) => entry.name === tool.name);
        expect(catalog, `${tool.name} is in the catalog`).toBeDefined();
        expect(tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe(catalog?.readOnly);
      }
    } finally {
      await session.close();
    }
  });

  it('exposes no arbitrary filesystem, shell, git, or approval tool', async () => {
    const session = await connectMcp(copyFixtureToTemp('standard-feature'));
    try {
      const { tools } = await session.client.listTools();
      const names = tools.map((tool) => tool.name.toLowerCase());
      for (const forbidden of [
        'read_file',
        'write_file',
        'fs_read',
        'fs_write',
        'shell',
        'exec',
        'bash',
        'run_command',
        'git',
        'spec_approve',
        'approve_stage',
      ]) {
        expect(names).not.toContain(forbidden);
      }
      // No tool description offers arbitrary command execution.
      for (const tool of tools) {
        expect(tool.description?.toLowerCase()).not.toContain('arbitrary command');
      }
    } finally {
      await session.close();
    }
  });

  it('prompt and resource catalogs have unique names', () => {
    expect(new Set(PROMPT_CATALOG.map((prompt) => prompt.name)).size).toBe(PROMPT_CATALOG.length);
    expect(new Set(RESOURCE_CATALOG.map((resource) => resource.name)).size).toBe(
      RESOURCE_CATALOG.length,
    );
  });
});

describe('mcp doctor', () => {
  it('is read-only and reports a healthy setup on a valid workspace', async () => {
    const root = copyFixtureToTemp('standard-feature');
    const report = await runMcpDoctor({ projectRootFlag: root, env: {} });
    expect(report.healthy).toBe(true);
    expect(report.checks.find((check) => check.name === 'kiro-workspace')?.status).toBe('ok');
    expect(report.checks.find((check) => check.name === 'stdio-cleanliness')?.status).toBe('ok');
    expect(report.protocolBaseline).toBe(MCP_PROTOCOL_BASELINE);
  });

  it('fails clearly outside a valid project root', async () => {
    const report = await runMcpDoctor({ projectRootFlag: 'Z:/no/such/dir-xyz', env: {} });
    expect(report.healthy).toBe(false);
    expect(report.checks.find((check) => check.name === 'project-root')?.status).toBe('fail');
  });

  it('warns (not fails) when .kiro is absent', async () => {
    const report = await runMcpDoctor({ projectRootFlag: emptyTempDir(), env: {} });
    expect(report.checks.find((check) => check.name === 'kiro-workspace')?.status).toBe('warn');
  });
});

describe('bounded output primitives', () => {
  it('cursors are stable, tamper-checked, and listing-scoped', () => {
    const cursor = encodeCursor(50, 'spec_list');
    expect(decodeCursor(cursor, 'spec_list')).toEqual({ offset: 50, token: 'spec_list' });
    expect(() => decodeCursor(cursor, 'run_list')).toThrowError(/different listing/);
    expect(() => decodeCursor('not-base64-json', 'spec_list')).toThrowError(/not valid/);
  });

  it('pagination clamps limits and reports truncation', () => {
    const items = Array.from({ length: 120 }, (_, index) => index);
    const first = paginate(items, { limit: 50, token: 't' });
    expect(first.items.length).toBe(50);
    expect(first.truncated).toBe(true);
    expect(first.totalCount).toBe(120);
    const second = paginate(items, { limit: 500 as never, cursor: first.nextCursor as string, token: 't' });
    // limit above the maximum clamps to 200; the remaining 70 items fit.
    expect(second.items.length).toBe(70);
    expect(second.truncated).toBe(false);
  });

  it('truncateText cuts on UTF-8 boundaries', () => {
    const text = `ascii-${'é'.repeat(10)}`;
    const bounded = truncateText(text, 8);
    expect(bounded.truncated).toBe(true);
    expect(Buffer.byteLength(bounded.text, 'utf8')).toBeLessThanOrEqual(8);
    expect(bounded.text.includes('�')).toBe(false);
    expect(LIMITS.maximumListLimit).toBe(200);
  });
});
