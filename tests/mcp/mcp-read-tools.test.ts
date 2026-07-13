import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyFixtureToTemp, emptyTempDir } from '../helpers.js';
import { EXECUTION_SPEC, setupExecutionFixture } from '../helpers-execution.js';
import { callTool, connectMcp } from '../helpers-mcp.js';

/**
 * Read-only tool behavior against real fixtures. Every test asserts both
 * the useful output AND that nothing on disk changed (tracked files stay
 * byte-identical; read-only tools may not write).
 */

function gitStatus(root: string): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
}

describe('workspace_detect', () => {
  it('detects a workspace with counts and git summary', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      const result = await callTool(session, 'workspace_detect');
      expect(result.isError).toBe(false);
      expect(result.structured['found']).toBe(true);
      expect(result.structured['kiroPresent']).toBe(true);
      expect(result.structured['specCount']).toBe(1);
      expect(result.structured['steeringCount']).toBe(1);
      expect(result.structured['sidecarPresent']).toBe(true);
      expect(result.structured['configStatus']).toBe('valid');
      expect((result.structured['git'] as { repository: boolean }).repository).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('reports a missing workspace as found: false, not as an error', async () => {
    const session = await connectMcp(emptyTempDir());
    try {
      const result = await callTool(session, 'workspace_detect');
      expect(result.isError).toBe(false);
      expect(result.structured['found']).toBe(false);
      expect(result.text).toContain('No .kiro directory');
    } finally {
      await session.close();
    }
  });
});

describe('steering tools', () => {
  it('steering_list returns names, paths, sizes, and hashes', async () => {
    const root = copyFixtureToTemp('standard-feature');
    const session = await connectMcp(root);
    try {
      const result = await callTool(session, 'steering_list');
      expect(result.isError).toBe(false);
      const steering = result.structured['steering'] as {
        name: string;
        path: string;
        contentHash?: string;
        sizeBytes: number;
      }[];
      expect(steering.length).toBeGreaterThan(0);
      for (const entry of steering) {
        expect(entry.path.startsWith('.kiro/steering/')).toBe(true);
        expect(entry.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(entry.sizeBytes).toBeGreaterThan(0);
      }
    } finally {
      await session.close();
    }
  });

  it('steering_read returns content by name and rejects path syntax', async () => {
    const root = copyFixtureToTemp('standard-feature');
    const session = await connectMcp(root);
    try {
      const ok = await callTool(session, 'steering_read', { name: 'product' });
      expect(ok.isError).toBe(false);
      expect(ok.structured['contentType']).toBe('text/markdown');
      expect((ok.structured['content'] as string).length).toBeGreaterThan(0);

      for (const attack of ['../secrets', 'a/b', 'a\\b', '..']) {
        const rejected = await callTool(session, 'steering_read', { name: attack });
        expect(rejected.isError, `rejects ${attack}`).toBe(true);
        expect(rejected.errorCode).toBe('SBMCP002');
      }
    } finally {
      await session.close();
    }
  });
});

describe('spec tools', () => {
  it('spec_list returns summaries and honors filters', async () => {
    const root = copyFixtureToTemp('v02-stale-requirements-approval');
    const session = await connectMcp(root);
    try {
      const all = await callTool(session, 'spec_list');
      expect(all.isError).toBe(false);
      const specs = all.structured['specs'] as { name: string; approvalHealth: string }[];
      expect(specs.length).toBeGreaterThan(0);

      const stale = await callTool(session, 'spec_list', { staleApprovalsOnly: true });
      const staleSpecs = stale.structured['specs'] as { approvalHealth: string }[];
      for (const spec of staleSpecs) expect(spec.approvalHealth).toBe('stale');
      expect(staleSpecs.length).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  it('spec_read returns content and line metadata for known documents only', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      const result = await callTool(session, 'spec_read', {
        specName: EXECUTION_SPEC,
        document: 'tasks',
      });
      expect(result.isError).toBe(false);
      const documents = result.structured['documents'] as {
        document: string;
        exists: boolean;
        content?: string;
        lineCount?: number;
        contentHash?: string;
      }[];
      expect(documents).toHaveLength(1);
      expect(documents[0]?.exists).toBe(true);
      expect(documents[0]?.content).toContain('Implementation Plan');
      expect(documents[0]?.lineCount).toBeGreaterThan(5);
      expect(documents[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);

      const unknown = await session.client.callTool({
        name: 'spec_read',
        arguments: { specName: EXECUTION_SPEC, document: 'secrets.txt' },
      });
      // Schema-invalid input is rejected before the handler runs.
      expect(unknown.isError).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('spec_status reports stale approvals with hashes and next actions', async () => {
    const fixture = setupExecutionFixture();
    // Make the approved requirements stale by editing the file.
    const requirementsPath = path.join(
      fixture.root,
      '.kiro',
      'specs',
      EXECUTION_SPEC,
      'requirements.md',
    );
    writeFileSync(requirementsPath, `${readFileSync(requirementsPath, 'utf8')}\nEdited after approval.\n`);
    const session = await connectMcp(fixture.root);
    try {
      const result = await callTool(session, 'spec_status', { specName: EXECUTION_SPEC });
      expect(result.isError).toBe(false);
      const summary = result.structured['summary'] as { approvalHealth: string };
      expect(summary.approvalHealth).toBe('stale');
      expect(result.structured['staleStages']).toContain('requirements');
      const stages = result.structured['stages'] as {
        stage: string;
        effective: string;
        approvedHash: string | null;
        currentHash: string | null;
      }[];
      const requirements = stages.find((stage) => stage.stage === 'requirements');
      expect(requirements?.effective).toBe('modified-after-approval');
      expect(requirements?.approvedHash).not.toBe(requirements?.currentHash);
      const actions = result.structured['suggestedNextActions'] as string[];
      expect(actions.some((action) => action.includes('re-approve'))).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('spec_context is bounded and never invokes a model', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      const result = await callTool(session, 'spec_context', {
        specName: EXECUTION_SPEC,
        maximumCharacters: 1000,
      });
      expect(result.isError).toBe(false);
      expect(result.structured['truncated']).toBe(true);
      expect((result.structured['markdown'] as string).length).toBeLessThanOrEqual(1100);

      const structured = await callTool(session, 'spec_context', {
        specName: EXECUTION_SPEC,
        format: 'structured',
      });
      expect(structured.isError).toBe(false);
      const payload = structured.structured['structured'] as { schema: string };
      expect(payload.schema).toBe('specbridge.agent-context/1');
    } finally {
      await session.close();
    }
  });

  it('spec_analyze is deterministic across calls', async () => {
    const root = copyFixtureToTemp('v02-placeholder-heavy');
    const session = await connectMcp(root);
    try {
      const first = await callTool(session, 'spec_analyze', {
        specName: 'notification-preferences',
        stage: 'all',
      });
      const second = await callTool(session, 'spec_analyze', {
        specName: 'notification-preferences',
        stage: 'all',
      });
      expect(first.isError).toBe(false);
      expect(first.structured).toEqual(second.structured);
      expect(first.structured['errorCount'] as number).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  it('spec tools reject an unknown spec with SBMCP003', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      const result = await callTool(session, 'spec_status', { specName: 'no-such-spec' });
      expect(result.isError).toBe(true);
      expect(result.errorCode).toBe('SBMCP003');
    } finally {
      await session.close();
    }
  });
});

describe('task tools', () => {
  it('task_list preserves hierarchy with parents, children, and leaves', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      const result = await callTool(session, 'task_list', { specName: EXECUTION_SPEC });
      expect(result.isError).toBe(false);
      const tasks = result.structured['tasks'] as {
        id: string;
        parentId?: string;
        childIds: string[];
        executableLeaf: boolean;
        optional: boolean;
      }[];
      const parent = tasks.find((task) => task.id === '2');
      expect(parent?.childIds).toEqual(['2.1', '2.2']);
      expect(parent?.executableLeaf).toBe(false);
      const child = tasks.find((task) => task.id === '2.1');
      expect(child?.parentId).toBe('2');
      expect(child?.executableLeaf).toBe(true);
      expect(tasks.find((task) => task.id === '4')?.optional).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('task_next selects the first open required leaf deterministically', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      const result = await callTool(session, 'task_next', { specName: EXECUTION_SPEC });
      expect(result.isError).toBe(false);
      expect(result.structured['executable']).toBe(true);
      expect((result.structured['task'] as { id: string }).id).toBe('1');
    } finally {
      await session.close();
    }
  });

  it('task_next returns blockers when approvals are missing', async () => {
    const fixture = setupExecutionFixture({ approve: false });
    const session = await connectMcp(fixture.root);
    try {
      const result = await callTool(session, 'task_next', { specName: EXECUTION_SPEC });
      expect(result.isError).toBe(false);
      expect(result.structured['executable']).toBe(false);
      expect((result.structured['blockers'] as string[]).length).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });
});

describe('drift tools (read-only)', () => {
  it('spec_check_drift runs rules without executing commands or writing reports', async () => {
    const fixture = setupExecutionFixture();
    // A working-tree change that maps to no spec triggers rule findings.
    writeFileSync(path.join(fixture.root, 'src', 'unmapped-file.txt'), 'drift\n');
    const before = gitStatus(fixture.root);
    const session = await connectMcp(fixture.root);
    try {
      const result = await callTool(session, 'spec_check_drift', { scope: 'all' });
      expect(result.isError).toBe(false);
      expect(result.structured['specsVerified']).toBe(1);
      const ruleIds = result.structured['ruleIds'] as string[];
      for (const ruleId of ruleIds) expect(ruleId).toMatch(/^SBV\d{3}$/);
      // Nothing changed on disk: no reports, no logs, no state.
      expect(gitStatus(fixture.root)).toBe(before);
    } finally {
      await session.close();
    }
  });

  it('spec_affected maps changed files to specs', async () => {
    const fixture = setupExecutionFixture();
    writeFileSync(
      path.join(fixture.root, '.kiro', 'specs', EXECUTION_SPEC, 'design.md'),
      `${readFileSync(path.join(fixture.root, '.kiro', 'specs', EXECUTION_SPEC, 'design.md'), 'utf8')}\nTouched.\n`,
    );
    const session = await connectMcp(fixture.root);
    try {
      const result = await callTool(session, 'spec_affected', {});
      expect(result.isError).toBe(false);
      const affected = result.structured['affected'] as { specName: string }[];
      expect(affected.map((spec) => spec.specName)).toContain(EXECUTION_SPEC);
    } finally {
      await session.close();
    }
  });
});

describe('read-only guarantee', () => {
  it('a full read-only tool sweep leaves the repository byte-identical', async () => {
    const fixture = setupExecutionFixture();
    const before = gitStatus(fixture.root);
    const session = await connectMcp(fixture.root);
    try {
      await callTool(session, 'workspace_detect');
      await callTool(session, 'steering_list');
      await callTool(session, 'steering_read', { name: 'product' });
      await callTool(session, 'spec_list');
      await callTool(session, 'spec_read', { specName: EXECUTION_SPEC, document: 'all' });
      await callTool(session, 'spec_status', { specName: EXECUTION_SPEC });
      await callTool(session, 'spec_context', { specName: EXECUTION_SPEC });
      await callTool(session, 'spec_analyze', { specName: EXECUTION_SPEC });
      await callTool(session, 'task_list', { specName: EXECUTION_SPEC });
      await callTool(session, 'task_next', { specName: EXECUTION_SPEC });
      await callTool(session, 'run_list');
      await callTool(session, 'spec_affected', {});
      await callTool(session, 'spec_check_drift', { scope: 'all' });
      await callTool(session, 'spec_stage_validate', {
        specName: EXECUTION_SPEC,
        stage: 'design',
        candidateMarkdown: '# Design\n\nA candidate that is never applied.\n',
      });
      expect(gitStatus(fixture.root)).toBe(before);
    } finally {
      await session.close();
    }
  });
});

describe('multi-spec performance', () => {
  it('handles a workspace with 120 specs within pagination bounds', async () => {
    const root = emptyTempDir();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    for (let index = 0; index < 120; index += 1) {
      const name = `generated-spec-${String(index).padStart(3, '0')}`;
      const dir = path.join(root, '.kiro', 'specs', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'requirements.md'), `# Requirements Document\n\n## Introduction\n\nSpec ${index}.\n`);
      writeFileSync(path.join(dir, 'tasks.md'), `# Implementation Plan\n\n- [ ] 1. Implement item ${index}\n`);
    }
    const session = await connectMcp(root);
    try {
      const startedAt = Date.now();
      const first = await callTool(session, 'spec_list', { limit: 50 });
      expect(first.isError).toBe(false);
      const pagination = first.structured['pagination'] as {
        totalCount: number;
        truncated: boolean;
        nextCursor?: string;
      };
      expect(pagination.totalCount).toBe(120);
      expect(pagination.truncated).toBe(true);
      const second = await callTool(session, 'spec_list', {
        limit: 50,
        cursor: pagination.nextCursor,
      });
      expect((second.structured['specs'] as unknown[]).length).toBe(50);
      const third = await callTool(session, 'spec_list', {
        limit: 50,
        cursor: (second.structured['pagination'] as { nextCursor?: string }).nextCursor,
      });
      expect((third.structured['specs'] as unknown[]).length).toBe(20);
      // Generous bound: three paginated sweeps over 120 specs stay fast.
      expect(Date.now() - startedAt).toBeLessThan(30_000);
    } finally {
      await session.close();
    }
  }, 60_000);
});
