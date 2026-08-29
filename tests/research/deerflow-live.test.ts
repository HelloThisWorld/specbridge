import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { defaultResolvedAgentConfig, researchPolicySchema, resolveWorkspace } from '@specbridge/core';
import { getResearchProviderHealth, listResearchRecords, researchRequestSchema, startResearch } from '@specbridge/orchestration';

const deerFlowUrl = process.env['SPECBRIDGE_TEST_DEERFLOW_URL'];

it.skipIf(deerFlowUrl === undefined)(
  'qualifies an explicitly configured real local DeerFlow without making normal CI depend on it',
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'specbridge-deerflow-live-'));
    mkdirSync(path.join(root, '.kiro'), { recursive: true });
    const workspace = resolveWorkspace(root);
    if (workspace === undefined || deerFlowUrl === undefined) throw new Error('qualification setup failed');
    const config = {
      ...defaultResolvedAgentConfig(),
      research: researchPolicySchema.parse({
        enabled: true,
        providers: { deerflow: { enabled: true, baseUrl: deerFlowUrl, timeoutMs: 600_000 } },
      }),
    };
    const deps = { workspace, config };
    const health = await getResearchProviderHealth(deps);
    expect(health.status).toBe('HEALTHY');

    const quick = await startResearch(
      deps,
      researchRequestSchema.parse({
        researchId: 'live-quick',
        depth: 'QUICK',
        question: 'What endpoint does the current DeerFlow API document for its basic health check?',
        context: {},
        expectedOutput: { questionsToAnswer: ['What is the documented health endpoint?'] },
        sourcePolicy: { preferPrimarySources: true, requireSources: true },
      }),
    );
    expect(quick.ok).toBe(true);
    if (quick.ok) {
      expect(quick.report.findings.length).toBeGreaterThan(0);
      expect(quick.record.providerRefs).toBeDefined();
    }

    if (process.env['SPECBRIDGE_TEST_DEERFLOW_DEEP'] === '1') {
      const deep = await startResearch(
        deps,
        researchRequestSchema.parse({
          researchId: 'live-deep',
          depth: 'DEEP',
          question: 'Compare the current documented DeerFlow stateless and thread-scoped streaming APIs.',
          context: {},
          expectedOutput: { questionsToAnswer: ['When should each API be used?'] },
          sourcePolicy: { preferPrimarySources: true, requireSources: true },
        }),
      );
      expect(deep.ok).toBe(true);
    }
    expect(listResearchRecords(workspace).records.length).toBeGreaterThanOrEqual(1);
  },
  900_000,
);
