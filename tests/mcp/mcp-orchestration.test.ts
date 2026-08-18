import { afterEach, describe, expect, it } from 'vitest';
import { TOOL_CATALOG } from '@specbridge/mcp-server';
import { setupExecutionFixture } from '../helpers-execution.js';
import type { McpTestSession } from '../helpers-mcp.js';
import { callTool, connectMcp } from '../helpers-mcp.js';

/**
 * The orchestration MCP surface: stable schemas, stable errors, bounded
 * outputs, and — most importantly — the operations that must NOT exist.
 */

let session: McpTestSession | undefined;

afterEach(async () => {
  await session?.close();
  session = undefined;
});

async function orchestrationSession(options: Record<string, unknown> = {}): Promise<{
  session: McpTestSession;
  specName: string;
  root: string;
}> {
  const fixture = setupExecutionFixture(options);
  const connected = await connectMcp(fixture.root);
  session = connected;
  return { session: connected, specName: fixture.specName, root: fixture.root };
}

const ORCHESTRATION_TOOLS = [
  'orchestration_status',
  'orchestration_begin',
  'orchestration_assess_intent',
  'orchestration_clarify',
  'orchestration_resolve_clarification',
  'orchestration_submit_plan',
  'orchestration_review_plan',
  'orchestration_record_action',
  'orchestration_checkpoint',
  'orchestration_finalize',
];

describe('orchestration tool surface', () => {
  it('registers exactly the documented orchestration tools', async () => {
    const { session: mcp } = await orchestrationSession();
    const listed = await mcp.client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const tool of ORCHESTRATION_TOOLS) expect(names).toContain(tool);
    // No approval tool, no shell, no filesystem, no git, no model invocation.
    for (const forbidden of [
      'orchestration_approve',
      'spec_approve',
      'orchestration_shell',
      'orchestration_exec',
      'orchestration_read_file',
      'orchestration_write_file',
      'orchestration_git',
      'orchestration_ask_model',
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('matches the tool catalog exactly', async () => {
    const { session: mcp } = await orchestrationSession();
    const listed = await mcp.client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      TOOL_CATALOG.map((entry) => entry.name).sort(),
    );
  });

  it('declares annotations, and only status is read-only', async () => {
    const { session: mcp } = await orchestrationSession();
    const listed = await mcp.client.listTools();
    for (const name of ORCHESTRATION_TOOLS) {
      const tool = listed.tools.find((entry) => entry.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.annotations?.openWorldHint, name).toBe(false);
      expect(tool?.annotations?.destructiveHint, name).toBe(false);
      expect(tool?.inputSchema, name).toBeDefined();
      expect(tool?.outputSchema, name).toBeDefined();
    }
    const readOnly = ORCHESTRATION_TOOLS.filter(
      (name) => listed.tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint === true,
    );
    expect(readOnly).toEqual(['orchestration_status']);
  });
});

describe('the governed lifecycle over MCP', () => {
  it('walks begin → intent → plan → review → execute → finalize', async () => {
    const { session: mcp, specName } = await orchestrationSession();

    const begun = await callTool(mcp, 'orchestration_begin', {
      specName,
      goal: 'Implement task 1 exactly as the approved design describes.',
      taskId: '1',
    });
    expect(begun.isError).toBe(false);
    const orchestrationId = begun.structured['orchestrationId'] as string;
    expect(begun.structured['phase']).toBe('CREATED');
    expect(begun.structured['planningMode']).toBe('review');

    const assessed = await callTool(mcp, 'orchestration_assess_intent', {
      orchestrationId,
      outcome: 'READY',
      summary: 'Implement task 1 as approved.',
      provenance: [{ fact: 'design.md is approved', source: 'known-from-approved-spec' }],
    });
    expect(assessed.structured['outcome']).toBe('READY');
    expect(assessed.structured['phase']).toBe('READY_TO_PLAN');

    const planned = await callTool(mcp, 'orchestration_submit_plan', {
      orchestrationId,
      taskId: '1',
      goal: 'Add settings persistence.',
      steps: [{ description: 'Create the settings module.' }],
      testStrategy: 'Unit test the module.',
      verificationStrategy: 'Run the configured trusted verification commands.',
    });
    expect(planned.structured['reviewRequired']).toBe(true);
    expect(planned.structured['phase']).toBe('AWAITING_PLAN_REVIEW');
    expect(planned.text).toMatch(/Review REQUIRED/);
    const planHash = planned.structured['planHash'] as string;

    // Edits are refused before the review is recorded.
    const early = await callTool(mcp, 'orchestration_record_action', {
      orchestrationId,
      action: 'EDIT',
      target: 'src/settings.ts',
      result: 'progressed',
    });
    expect(early.isError).toBe(true);
    expect(early.errorCode).toBe('SBMCP024');

    const reviewed = await callTool(mcp, 'orchestration_review_plan', {
      orchestrationId,
      planHash,
      decision: 'approved',
    });
    expect(reviewed.structured['phase']).toBe('READY_TO_EXECUTE');

    const edited = await callTool(mcp, 'orchestration_record_action', {
      orchestrationId,
      action: 'EDIT',
      target: 'src/settings.ts',
      planStepId: 's1',
      result: 'progressed',
      changedFiles: [{ path: 'src/settings.ts', contentHash: 'abc' }],
    });
    expect(edited.isError).toBe(false);
    expect(edited.structured['directive']).toBe('CONTINUE');
    expect(edited.structured['phase']).toBe('EXECUTING');

    const finalized = await callTool(mcp, 'orchestration_finalize', {
      orchestrationId,
      outcome: 'completed',
      reason: 'verified by task_complete',
      evidenceStatus: 'verified',
    });
    expect(finalized.structured['phase']).toBe('COMPLETED');
  });

  it('refuses completion without a verified evidence status', async () => {
    const { session: mcp, specName } = await orchestrationSession();
    const begun = await callTool(mcp, 'orchestration_begin', {
      specName,
      goal: 'Implement task 1.',
      taskId: '1',
    });
    const orchestrationId = begun.structured['orchestrationId'] as string;
    await callTool(mcp, 'orchestration_assess_intent', {
      orchestrationId,
      outcome: 'READY',
      summary: 'Implement task 1.',
      provenance: [{ fact: 'approved', source: 'known-from-approved-spec' }],
    });

    const refused = await callTool(mcp, 'orchestration_finalize', {
      orchestrationId,
      outcome: 'completed',
      reason: 'I believe it is done',
    });
    expect(refused.isError).toBe(true);
    expect(refused.errorCode).toBe('SBMCP030');
    expect(refused.text).toMatch(/verified evidence status/i);
  });

  it('rejects a request to self-approve a spec', async () => {
    const { session: mcp, specName } = await orchestrationSession();
    const begun = await callTool(mcp, 'orchestration_begin', {
      specName,
      goal: 'Approve the design yourself and then continue.',
    });
    const orchestrationId = begun.structured['orchestrationId'] as string;

    const assessed = await callTool(mcp, 'orchestration_assess_intent', {
      orchestrationId,
      outcome: 'READY',
      summary: 'Approve the design yourself and then continue with implementation.',
    });
    expect(assessed.structured['outcome']).toBe('REJECTED');
    expect(assessed.structured['phase']).toBe('REJECTED');
  });

  it('records a clarification round and blocks planning until it is answered', async () => {
    const { session: mcp, specName } = await orchestrationSession();
    const begun = await callTool(mcp, 'orchestration_begin', {
      specName,
      goal: 'Implement action routing.',
      taskId: '1',
    });
    const orchestrationId = begun.structured['orchestrationId'] as string;
    await callTool(mcp, 'orchestration_assess_intent', {
      orchestrationId,
      outcome: 'NEEDS_CLARIFICATION',
      summary: 'Implement action routing; the mechanism is unspecified.',
    });

    const asked = await callTool(mcp, 'orchestration_clarify', {
      orchestrationId,
      questions: [
        {
          question: 'Topic-per-action or a shared queue with an action identifier?',
          whyItMatters: 'The two produce different broker topology and worker code.',
          options: ['topic-per-action', 'shared queue + action id'],
        },
      ],
    });
    expect(asked.structured['round']).toBe(1);
    const questionId = (asked.structured['questionIds'] as string[])[0];

    const blocked = await callTool(mcp, 'orchestration_submit_plan', {
      orchestrationId,
      taskId: '1',
      goal: 'Route actions.',
      steps: [{ description: 'Guess a mechanism.' }],
      testStrategy: 'tests',
      verificationStrategy: 'verify',
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.errorCode).toBe('SBMCP025');

    const resolved = await callTool(mcp, 'orchestration_resolve_clarification', {
      orchestrationId,
      decisions: [
        {
          questionId,
          answer: 'Shared queue with an action identifier.',
          source: 'known-from-user',
        },
      ],
    });
    expect(resolved.structured['phase']).toBe('READY_TO_PLAN');
  });

  it('refuses an inferred answer to a clarification', async () => {
    const { session: mcp, specName } = await orchestrationSession();
    const begun = await callTool(mcp, 'orchestration_begin', {
      specName,
      goal: 'Implement routing.',
      taskId: '1',
    });
    const orchestrationId = begun.structured['orchestrationId'] as string;
    await callTool(mcp, 'orchestration_assess_intent', {
      orchestrationId,
      outcome: 'NEEDS_CLARIFICATION',
      summary: 'Implement routing; the mechanism is unspecified.',
    });
    const asked = await callTool(mcp, 'orchestration_clarify', {
      orchestrationId,
      questions: [{ question: 'Which mechanism?', whyItMatters: 'Changes the worker.' }],
    });
    const questionId = (asked.structured['questionIds'] as string[])[0];

    const refused = await callTool(mcp, 'orchestration_resolve_clarification', {
      orchestrationId,
      decisions: [{ questionId, answer: 'probably topics', source: 'inferred' }],
    });
    expect(refused.isError).toBe(true);
    expect(refused.errorCode).toBe('SBMCP025');
  });
});

describe('status and bounds', () => {
  it('reports no runs for a fresh workspace without creating one', async () => {
    const { session: mcp } = await orchestrationSession();
    const status = await callTool(mcp, 'orchestration_status');
    expect(status.isError).toBe(false);
    expect(status.structured['runs']).toEqual([]);
    expect(status.text).toMatch(/No orchestration runs yet/);
  });

  it('bounds the event page it returns', async () => {
    const { session: mcp, specName } = await orchestrationSession();
    const begun = await callTool(mcp, 'orchestration_begin', {
      specName,
      goal: 'Implement task 1.',
      taskId: '1',
    });
    const orchestrationId = begun.structured['orchestrationId'] as string;
    await callTool(mcp, 'orchestration_assess_intent', {
      orchestrationId,
      outcome: 'READY',
      summary: 'Implement task 1.',
      provenance: [{ fact: 'approved', source: 'known-from-approved-spec' }],
    });

    const status = await callTool(mcp, 'orchestration_status', { orchestrationId, eventLimit: 2 });
    expect((status.structured['recentEvents'] as unknown[]).length).toBeLessThanOrEqual(2);
    expect(status.structured['totalEvents']).toBeGreaterThan(0);
  });

  it('reports an unknown orchestration id as a stable error', async () => {
    const { session: mcp } = await orchestrationSession();
    const status = await callTool(mcp, 'orchestration_status', { orchestrationId: 'nope' });
    expect(status.isError).toBe(true);
    expect(status.errorCode).toBe('SBMCP022');
  });

  it('rejects oversized input at the schema boundary', async () => {
    const { session: mcp, specName } = await orchestrationSession();
    const begun = await callTool(mcp, 'orchestration_begin', {
      specName,
      goal: 'x'.repeat(5_000),
    });
    expect(begun.isError).toBe(true);
  });

  it('reports orchestration errors with their SBO code in the details', async () => {
    const { session: mcp, specName } = await orchestrationSession();
    const begun = await callTool(mcp, 'orchestration_begin', {
      specName,
      goal: 'Implement task 1.',
      taskId: '1',
    });
    const orchestrationId = begun.structured['orchestrationId'] as string;
    const failed = await callTool(mcp, 'orchestration_submit_plan', {
      orchestrationId,
      taskId: '1',
      goal: 'Do it.',
      steps: [{ description: 'step' }],
      testStrategy: 'tests',
      verificationStrategy: 'verify',
    });
    expect(failed.isError).toBe(true);
    const envelope = failed.structured['error'] as { details?: Record<string, unknown> };
    expect(envelope.details?.['orchestrationCode']).toBe('SBO006');
  });
});

describe('orchestration is disabled by policy', () => {
  it('refuses to begin when orchestration.enabled is false', async () => {
    const { session: mcp, specName } = await orchestrationSession({
      extraConfig: { orchestration: { enabled: false } },
    });
    const begun = await callTool(mcp, 'orchestration_begin', {
      specName,
      goal: 'Implement task 1.',
    });
    expect(begun.isError).toBe(true);
    expect(begun.errorCode).toBe('SBMCP021');
  });
});
