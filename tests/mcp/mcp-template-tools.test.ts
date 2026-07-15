import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { callTool, connectMcp } from '../helpers-mcp';
import { fixedClock } from '../helpers';
import { freshKiroWorkspace } from '../helpers-templates';

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

describe('template_list / template_search / template_show', () => {
  it('template_list returns bounded, valid summaries', async () => {
    const root = freshKiroWorkspace();
    const session = await connectMcp(root, { clock: fixedClock });
    try {
      const result = await callTool(session, 'template_list', {});
      expect(result.isError).toBe(false);
      const templates = result.structured['templates'] as Array<{ ref: string; valid: boolean }>;
      expect(templates.length).toBe(10);
      expect(templates.every((template) => template.valid)).toBe(true);
      expect(templates.some((template) => template.ref === 'builtin:rest-api')).toBe(true);

      const limited = await callTool(session, 'template_list', { limit: 3 });
      expect((limited.structured['templates'] as unknown[]).length).toBe(3);
      expect(limited.structured['nextCursor']).toBeTruthy();
    } finally {
      await session.close();
    }
  });

  it('template_search ranks deterministically', async () => {
    const root = freshKiroWorkspace();
    const session = await connectMcp(root, { clock: fixedClock });
    try {
      const result = await callTool(session, 'template_search', { query: 'database' });
      expect(result.isError).toBe(false);
      const results = result.structured['results'] as Array<{ ref: string; score: number }>;
      expect(results[0]?.ref).toBe('builtin:database-migration');
      const again = await callTool(session, 'template_search', { query: 'database' });
      expect(again.structured['results']).toEqual(result.structured['results']);
    } finally {
      await session.close();
    }
  });

  it('template_show returns manifest metadata without filesystem paths', async () => {
    const root = freshKiroWorkspace();
    const session = await connectMcp(root, { clock: fixedClock });
    try {
      const result = await callTool(session, 'template_show', { reference: 'rest-api' });
      expect(result.isError).toBe(false);
      const template = result.structured['template'] as { ref: string };
      expect(template.ref).toBe('builtin:rest-api');
      expect(result.structured['variables']).toBeDefined();
      expect(result.structured['readme']).toBeTruthy();
      const raw = JSON.stringify(result.structured);
      expect(raw).not.toContain(root.replace(/\\/g, '\\\\'));
      expect(raw).not.toMatch(/[A-Za-z]:\\\\/);
    } finally {
      await session.close();
    }
  });
});

describe('template_preview', () => {
  it('renders and writes nothing', async () => {
    const root = freshKiroWorkspace();
    const session = await connectMcp(root, { clock: fixedClock });
    try {
      const before = snapshotTree(root);
      const result = await callTool(session, 'template_preview', {
        specName: 'orders-endpoint',
        reference: 'rest-api',
        variables: { resourceName: 'order' },
      });
      expect(result.isError).toBe(false);
      expect(result.structured['candidateHash']).toMatch(/^[0-9a-f]{64}$/);
      const files = result.structured['files'] as Array<{ target: string; content: string }>;
      expect(files.map((file) => file.target)).toEqual(['requirements.md', 'design.md', 'tasks.md']);
      expect(files[0]?.content).toContain('# Requirements Document');
      expect(snapshotTree(root)).toEqual(before);
    } finally {
      await session.close();
    }
  });

  it('reports actionable template errors as SBMCP002 envelopes', async () => {
    const root = freshKiroWorkspace();
    const session = await connectMcp(root, { clock: fixedClock });
    try {
      const missing = await callTool(session, 'template_preview', {
        specName: 'x',
        reference: 'no-such-template',
      });
      expect(missing.isError).toBe(true);
      expect(missing.errorCode).toBe('SBMCP002');
      expect(missing.text).toContain('SBT001');

      const badVariable = await callTool(session, 'template_preview', {
        specName: 'x',
        reference: 'rest-api',
        variables: { mystery: 1 },
      });
      expect(badVariable.isError).toBe(true);
      expect(badVariable.text).toContain('SBT014');
    } finally {
      await session.close();
    }
  });
});

describe('template_apply', () => {
  it('requires the acknowledgement literal', async () => {
    const root = freshKiroWorkspace();
    const session = await connectMcp(root, { clock: fixedClock });
    try {
      const result = await callTool(session, 'template_apply', {
        specName: 'orders-endpoint',
        reference: 'rest-api',
        expectedCandidateHash: 'a'.repeat(64),
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('apply-reviewed-template');
      expect(existsSync(path.join(root, '.kiro', 'specs', 'orders-endpoint'))).toBe(false);
    } finally {
      await session.close();
    }
  });

  it('rejects a candidate hash mismatch without writing', async () => {
    const root = freshKiroWorkspace();
    const session = await connectMcp(root, { clock: fixedClock });
    try {
      const result = await callTool(session, 'template_apply', {
        specName: 'orders-endpoint',
        reference: 'rest-api',
        expectedCandidateHash: 'f'.repeat(64),
        acknowledgement: 'apply-reviewed-template',
      });
      expect(result.isError).toBe(true);
      expect(result.errorCode).toBe('SBMCP002');
      expect(result.text).toContain('SBT023');
      expect(existsSync(path.join(root, '.kiro', 'specs', 'orders-endpoint'))).toBe(false);
    } finally {
      await session.close();
    }
  });

  it('applies the previewed candidate and never overwrites', async () => {
    const root = freshKiroWorkspace();
    const session = await connectMcp(root, { clock: fixedClock });
    try {
      const preview = await callTool(session, 'template_preview', {
        specName: 'orders-endpoint',
        reference: 'rest-api',
        variables: { resourceName: 'order' },
      });
      const candidateHash = preview.structured['candidateHash'] as string;

      const apply = await callTool(session, 'template_apply', {
        specName: 'orders-endpoint',
        reference: 'rest-api',
        variables: { resourceName: 'order' },
        expectedCandidateHash: candidateHash,
        acknowledgement: 'apply-reviewed-template',
      });
      expect(apply.isError).toBe(false);
      expect(apply.structured['applied']).toBe(true);
      expect(apply.structured['recordId']).toBeTruthy();
      expect(apply.structured['initialStatus']).toBe('REQUIREMENTS_DRAFT');

      const specDir = path.join(root, '.kiro', 'specs', 'orders-endpoint');
      expect(readdirSync(specDir).sort()).toEqual(['design.md', 'requirements.md', 'tasks.md']);
      expect(readFileSync(path.join(specDir, 'requirements.md'), 'utf8')).toContain('`order` resource');
      const state = JSON.parse(
        readFileSync(path.join(root, '.specbridge', 'state', 'specs', 'orders-endpoint.json'), 'utf8'),
      ) as { stages: Record<string, { status: string }> };
      for (const stage of Object.values(state.stages)) {
        expect(stage.status).not.toBe('approved');
      }

      // Second apply with a fresh preview against the same name must refuse.
      const retry = await callTool(session, 'template_apply', {
        specName: 'orders-endpoint',
        reference: 'rest-api',
        variables: { resourceName: 'order' },
        expectedCandidateHash: candidateHash,
        acknowledgement: 'apply-reviewed-template',
      });
      expect(retry.isError).toBe(true);
      expect(retry.text).toContain('SBT020');
    } finally {
      await session.close();
    }
  });

  it('exposes no arbitrary path input anywhere in the template tools', async () => {
    const root = freshKiroWorkspace();
    const session = await connectMcp(root, { clock: fixedClock });
    try {
      const tools = await session.client.listTools();
      const templateTools = tools.tools.filter((tool) => tool.name.startsWith('template_'));
      expect(templateTools.map((tool) => tool.name).sort()).toEqual([
        'template_apply',
        'template_list',
        'template_preview',
        'template_search',
        'template_show',
      ]);
      for (const tool of templateTools) {
        const raw = JSON.stringify(tool.inputSchema).toLowerCase();
        expect(raw, tool.name).not.toContain('"path"');
        expect(raw, tool.name).not.toContain('directory');
      }
    } finally {
      await session.close();
    }
  });
});
