import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { overnightAutonomyPreset } from '@specbridge/core';
import type { ToolsmithExecutor } from '@specbridge/autonomy';
import {
  applyToolsmithGrant,
  countSelfCreatedTools,
  decideToolsmithRequest,
  listToolsmithRequests,
  preferredScopeFor,
  readToolsmithLedger,
  requestToolsmithCapability,
} from '@specbridge/autonomy';
import { setupAutonomyFixture } from '../helpers-autonomy.js';

/**
 * The Toolsmith.
 *
 * The positive cases are easy and the negative ones are the feature: a
 * broker that grants everything would make "if you need a tool, build it"
 * indistinguishable from "do whatever you like", and the whole point is that
 * the runtime can create TOOLS without ever creating AUTHORITY.
 */

const POLICY = overnightAutonomyPreset();

function brokerContext(overrides: Partial<Parameters<typeof decideToolsmithRequest>[1]> = {}) {
  return {
    policy: POLICY,
    workspaceRoot: path.resolve('/tmp/ws'),
    protectedPaths: ['.kiro/**', '.specbridge/**'],
    grantsUsed: 0,
    ...overrides,
  };
}

describe('toolsmith broker', () => {
  it('grants ordinary project-local tooling', () => {
    const decision = decideToolsmithRequest(
      {
        capability: 'PROJECT_LOCAL_SCRIPT',
        target: 'scripts/seed-kafka.mjs',
        scope: 'PROJECT_LOCAL',
        purpose: 'seed topics before the system scenario',
      },
      brokerContext(),
    );
    expect(decision.granted).toBe(true);
  });

  it('refuses a capability class the policy did not grant', () => {
    const decision = decideToolsmithRequest(
      {
        capability: 'USER_LOCAL_CLI',
        target: '.specbridge/tools/kafkacat',
        scope: 'USER_LOCAL',
        purpose: 'inspect topics',
      },
      brokerContext(),
    );
    expect(decision.granted).toBe(false);
    if (!decision.granted) expect(decision.reason).toBe('CAPABILITY_NOT_ENABLED');
  });

  it('refuses to write control-plane state whatever capability carries it', () => {
    for (const target of [
      '.specbridge/config.json',
      '.specbridge/autonomy/seals/seal-1.json',
      '.claude/settings.json',
      '.kiro/specs/feature/tasks.md',
    ]) {
      const decision = decideToolsmithRequest(
        {
          capability: 'PROJECT_LOCAL_SCRIPT',
          target,
          scope: 'PROJECT_LOCAL',
          purpose: 'adjust configuration so the task can pass',
        },
        brokerContext(),
      );
      expect(decision.granted, target).toBe(false);
      if (!decision.granted) expect(decision.reason).toBe('WOULD_CREATE_AUTHORITY');
    }
  });

  it('refuses a target outside the workspace', () => {
    const decision = decideToolsmithRequest(
      {
        capability: 'PROJECT_LOCAL_SCRIPT',
        target: '../elsewhere/tool.mjs',
        scope: 'PROJECT_LOCAL',
        purpose: 'a tool',
      },
      brokerContext(),
    );
    expect(decision.granted).toBe(false);
    if (!decision.granted) expect(decision.reason).toBe('TARGET_OUTSIDE_WORKSPACE');
  });

  it('redirects an admin-scoped install to a portable route instead of stopping', () => {
    const decision = decideToolsmithRequest(
      {
        capability: 'USER_LOCAL_CLI',
        target: '/usr/local/bin/kcat',
        scope: 'USER_LOCAL',
        purpose: 'inspect topics',
      },
      brokerContext({
        policy: {
          ...POLICY,
          toolsmith: { ...POLICY.toolsmith, capabilities: [...POLICY.toolsmith.capabilities, 'USER_LOCAL_CLI'] },
        },
      }),
    );
    expect(decision.granted).toBe(false);
    if (!decision.granted) {
      expect(decision.reason).toBe('REQUIRES_ADMIN_PRIVILEGE');
      expect(decision.suggestedAlternative).toMatch(/container image|project-local/i);
    }
  });

  it('narrows a mismatched scope rather than installing in the wrong place', () => {
    const decision = decideToolsmithRequest(
      {
        capability: 'CONTAINER_IMAGE',
        target: 'postgres:16',
        scope: 'CONTAINERIZED',
        purpose: 'system scenario database',
      },
      brokerContext(),
    );
    expect(decision.granted).toBe(true);
    if (decision.granted) expect(decision.scope).toBe('CONTAINERIZED');
    expect(preferredScopeFor('PROJECT_DEPENDENCY')).toBe('PROJECT_LOCAL');
  });

  it('enforces the allowed image registry list when one is configured', () => {
    const context = brokerContext({
      policy: {
        ...POLICY,
        toolsmith: { ...POLICY.toolsmith, allowedImageRegistries: ['ghcr.io'] },
      },
    });
    const denied = decideToolsmithRequest(
      { capability: 'CONTAINER_IMAGE', target: 'docker.io/library/postgres:16', scope: 'CONTAINERIZED', purpose: 'db' },
      context,
    );
    expect(denied.granted).toBe(false);
    if (!denied.granted) expect(denied.reason).toBe('REGISTRY_NOT_ALLOWED');

    const allowed = decideToolsmithRequest(
      { capability: 'CONTAINER_IMAGE', target: 'ghcr.io/acme/postgres:16', scope: 'CONTAINERIZED', purpose: 'db' },
      context,
    );
    expect(allowed.granted).toBe(true);
  });

  it('refuses once the grant budget is spent', () => {
    const decision = decideToolsmithRequest(
      { capability: 'PROJECT_LOCAL_SCRIPT', target: 'scripts/x.mjs', scope: 'PROJECT_LOCAL', purpose: 'x' },
      brokerContext({ grantsUsed: POLICY.toolsmith.maxGrantsPerJob }),
    );
    expect(decision.granted).toBe(false);
    if (!decision.granted) expect(decision.reason).toBe('GRANT_BUDGET_EXHAUSTED');
  });

  it('refuses everything when the Toolsmith is disabled', () => {
    const decision = decideToolsmithRequest(
      { capability: 'PROJECT_LOCAL_SCRIPT', target: 'scripts/x.mjs', scope: 'PROJECT_LOCAL', purpose: 'x' },
      brokerContext({ policy: { ...POLICY, toolsmith: { ...POLICY.toolsmith, enabled: false } } }),
    );
    expect(decision.granted).toBe(false);
    if (!decision.granted) expect(decision.reason).toBe('TOOLSMITH_DISABLED');
  });

  it('refuses a download larger than the ceiling', () => {
    const decision = decideToolsmithRequest(
      {
        capability: 'BROWSER_RUNTIME',
        target: 'chromium',
        scope: 'USER_LOCAL',
        purpose: 'browser evidence',
        estimatedBytes: POLICY.toolsmith.maxDownloadBytes + 1,
      },
      brokerContext(),
    );
    expect(decision.granted).toBe(false);
    if (!decision.granted) expect(decision.reason).toBe('DOWNLOAD_TOO_LARGE');
  });
});

describe('toolsmith service', () => {
  it('records a grant, applies it, and counts the tool it created', async () => {
    const fixture = setupAutonomyFixture();
    const { request, decision } = requestToolsmithCapability(fixture.deps, {
      jobId: 'job-1',
      capability: 'PROJECT_LOCAL_SCRIPT',
      target: 'scripts/seed.mjs',
      purpose: 'seed the demo workflow before the system scenario',
    });
    expect(decision.granted).toBe(true);
    expect(request.status).toBe('GRANTED');

    const applied = await applyToolsmithGrant(fixture.deps, {
      jobId: 'job-1',
      requestId: request.requestId,
      content: 'export const seed = () => undefined;\n',
    });
    expect(applied.status).toBe('APPLIED');
    expect(applied.createdPaths).toEqual(['scripts/seed.mjs']);
    expect(readFileSync(path.join(fixture.root, 'scripts', 'seed.mjs'), 'utf8')).toContain('seed');

    const ledger = readToolsmithLedger(fixture.workspace, 'job-1');
    expect(ledger?.granted).toBe(1);
    expect(ledger?.applied).toBe(1);
    expect(countSelfCreatedTools(fixture.workspace, 'job-1')).toBe(1);
  });

  it('records denials as durably as grants', () => {
    const fixture = setupAutonomyFixture();
    const { request } = requestToolsmithCapability(fixture.deps, {
      jobId: 'job-1',
      capability: 'PROJECT_LOCAL_SCRIPT',
      target: '.specbridge/config.json',
      purpose: 'raise a budget so this task can pass',
    });
    expect(request.status).toBe('DENIED');
    expect(request.denialReason).toBe('WOULD_CREATE_AUTHORITY');

    const stored = listToolsmithRequests(fixture.workspace, 'job-1');
    expect(stored.length).toBe(1);
    expect(stored[0]?.denialDetail).toMatch(/never create authority/i);
    expect(readToolsmithLedger(fixture.workspace, 'job-1')?.denied).toBe(1);
  });

  it('refuses to apply a denied request', async () => {
    const fixture = setupAutonomyFixture();
    const { request } = requestToolsmithCapability(fixture.deps, {
      jobId: 'job-1',
      capability: 'PROJECT_LOCAL_SCRIPT',
      target: '../outside.mjs',
      purpose: 'x',
    });
    await expect(
      applyToolsmithGrant(fixture.deps, { jobId: 'job-1', requestId: request.requestId, content: 'x' }),
    ).rejects.toThrowError(/DENIED|GRANTED/);
  });

  it('records a failed executor as FAILED rather than throwing', async () => {
    const fixture = setupAutonomyFixture();
    const { request } = requestToolsmithCapability(fixture.deps, {
      jobId: 'job-1',
      capability: 'PROJECT_DEPENDENCY',
      target: 'vitest',
      purpose: 'test infrastructure',
    });
    const executor: ToolsmithExecutor = {
      label: 'failing',
      async apply() {
        throw new Error('registry unreachable');
      },
    };
    const applied = await applyToolsmithGrant(fixture.deps, {
      jobId: 'job-1',
      requestId: request.requestId,
      executor,
    });
    expect(applied.status).toBe('FAILED');
    expect(applied.outcome).toContain('registry unreachable');
    expect(readToolsmithLedger(fixture.workspace, 'job-1')?.failed).toBe(1);
  });

  it('spends the grant budget across separate requests', () => {
    const fixture = setupAutonomyFixture({ autonomy: { toolsmith: { maxGrantsPerJob: 2 } } });
    for (const name of ['a', 'b']) {
      const result = requestToolsmithCapability(fixture.deps, {
        jobId: 'job-1',
        capability: 'PROJECT_LOCAL_SCRIPT',
        target: `scripts/${name}.mjs`,
        purpose: 'tooling',
      });
      expect(result.decision.granted).toBe(true);
    }
    const third = requestToolsmithCapability(fixture.deps, {
      jobId: 'job-1',
      capability: 'PROJECT_LOCAL_SCRIPT',
      target: 'scripts/c.mjs',
      purpose: 'tooling',
    });
    expect(third.decision.granted).toBe(false);
    if (!third.decision.granted) expect(third.decision.reason).toBe('GRANT_BUDGET_EXHAUSTED');
  });
});
