import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyFixtureToTemp } from '../helpers.js';
import { EXECUTION_SPEC, setupExecutionFixture } from '../helpers-execution.js';
import { callTool, connectMcp, resourceText } from '../helpers-mcp.js';

/** MCP resources (bounded, redacted, UTF-8 safe) and workflow prompts. */

describe('resources', () => {
  it('the workspace resource returns the detection summary as JSON', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      const result = await session.client.readResource({ uri: 'specbridge://workspace' });
      const content = result.contents[0] as { mimeType?: string } | undefined;
      expect(content?.mimeType).toBe('application/json');
      const parsed = JSON.parse(resourceText(result)) as { found: boolean; specCount: number };
      expect(parsed.found).toBe(true);
      expect(parsed.specCount).toBe(1);
    } finally {
      await session.close();
    }
  });

  it('steering and spec resources return markdown and preserve UTF-8', async () => {
    const root = copyFixtureToTemp('utf8-content');
    const session = await connectMcp(root);
    try {
      const listed = await session.client.listResources();
      expect(listed.resources.length).toBeGreaterThan(0);

      const specs = listed.resources.filter((resource) => resource.uri.startsWith('specbridge://specs/'));
      expect(specs.length).toBeGreaterThan(0);
      const document = specs.find((resource) => resource.uri.endsWith('/requirements'));
      expect(document).toBeDefined();
      const read = await session.client.readResource({ uri: document?.uri as string });
      const text = resourceText(read);
      // The fixture contains non-ASCII content; it must survive intact.
      expect(/[^ -~\s]/u.test(text)).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('spec status resource returns JSON state', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      const read = await session.client.readResource({
        uri: `specbridge://specs/${EXECUTION_SPEC}/status`,
      });
      const parsed = JSON.parse(resourceText(read)) as {
        summary: { approvalHealth: string };
        stages: unknown[];
      };
      expect(parsed.summary.approvalHealth).toBe('ok');
      expect(parsed.stages.length).toBe(3);
    } finally {
      await session.close();
    }
  });

  it('the run resource exists, redacts raw output, and rejects forged ids', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      const begin = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      const runId = begin.structured['runId'] as string;
      writeFileSync(path.join(fixture.root, 'src', 'feature.txt'), 'work\n');
      await callTool(session, 'task_complete', { runId, summary: 'done' });

      const read = await session.client.readResource({ uri: `specbridge://runs/${runId}` });
      const parsed = JSON.parse(resourceText(read)) as {
        summary: { runType: string };
        artifacts: string[];
      };
      expect(parsed.summary.runType).toBe('interactive-execution');
      expect(parsed.artifacts).not.toContain('prompt.md');
      expect(parsed.artifacts).not.toContain('raw-stdout.log');
      expect(JSON.stringify(parsed)).not.toContain('rawStdout');

      await expect(
        session.client.readResource({ uri: 'specbridge://runs/no-such-run' }),
      ).rejects.toThrow(/not found/i);
    } finally {
      await session.close();
    }
  });

  it('path syntax inside resource URIs is rejected', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      for (const uri of [
        'specbridge://steering/..%2F..%2Fsecrets',
        'specbridge://runs/..%2E',
        `specbridge://specs/${EXECUTION_SPEC}/..%2Fother`,
      ]) {
        await expect(session.client.readResource({ uri }), uri).rejects.toThrow();
      }
    } finally {
      await session.close();
    }
  });

  it('the verification rules resource lists the stable rule registry', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      const read = await session.client.readResource({ uri: 'specbridge://verification/rules' });
      const parsed = JSON.parse(resourceText(read)) as { rules: { id: string }[] };
      expect(parsed.rules.length).toBe(25);
      expect(parsed.rules[0]?.id).toMatch(/^SBV\d{3}$/);
    } finally {
      await session.close();
    }
  });
});

describe('prompts', () => {
  it('prompt names are unique and arguments validate', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      const { prompts } = await session.client.listPrompts();
      const names = prompts.map((prompt) => prompt.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names.sort()).toEqual([
        'specbridge-author-stage',
        'specbridge-implement-task',
        'specbridge-status',
        'specbridge-verify',
      ]);
      // Required arguments are enforced.
      await expect(
        session.client.getPrompt({ name: 'specbridge-author-stage', arguments: {} }),
      ).rejects.toThrow();
    } finally {
      await session.close();
    }
  });

  it('the implement prompt walks task_begin → task_complete and forbids nesting', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      const prompt = await session.client.getPrompt({
        name: 'specbridge-implement-task',
        arguments: { specName: EXECUTION_SPEC, taskId: '1' },
      });
      const text = prompt.messages[0]?.content.type === 'text' ? prompt.messages[0].content.text : '';
      expect(text).toContain('task_begin');
      expect(text).toContain('task_complete');
      expect(text).toContain('task_abort');
      expect(text.toLowerCase()).toContain('never launch another agent process');
      expect(text).toContain('claims, not proof');
    } finally {
      await session.close();
    }
  });

  it('the author prompt uses validate/apply and keeps approval human', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      const prompt = await session.client.getPrompt({
        name: 'specbridge-author-stage',
        arguments: { specName: EXECUTION_SPEC, stage: 'design' },
      });
      const text = prompt.messages[0]?.content.type === 'text' ? prompt.messages[0].content.text : '';
      expect(text).toContain('spec_stage_validate');
      expect(text).toContain('spec_stage_apply');
      expect(text).toContain('NOT approved');
      expect(text).toContain('human action');
    } finally {
      await session.close();
    }
  });

  it('no prompt contains a permission bypass or approval tool claim', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      const { prompts } = await session.client.listPrompts();
      for (const meta of prompts) {
        const args: Record<string, string> = {};
        for (const argument of meta.arguments ?? []) {
          if (argument.required === true) args[argument.name] = 'placeholder';
        }
        const prompt = await session.client.getPrompt({ name: meta.name, arguments: args });
        const text = prompt.messages
          .map((message) => (message.content.type === 'text' ? message.content.text : ''))
          .join('\n')
          .toLowerCase();
        expect(text).not.toContain('bypasspermissions');
        expect(text).not.toContain('dangerously-skip-permissions');
        expect(text).not.toContain('approve_stage');
        expect(text).not.toMatch(/call.*spec_approve/);
      }
    } finally {
      await session.close();
    }
  });
});
