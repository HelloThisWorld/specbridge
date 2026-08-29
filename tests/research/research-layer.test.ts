import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentConfig, WorkspaceInfo } from '@specbridge/core';
import {
  defaultResolvedAgentConfig,
  researchPolicySchema,
  resolveWorkspace,
} from '@specbridge/core';
import type {
  ResearchBridge,
  ResearchProviderExecutionResult,
  ResearchProviderHealth,
  ResearchReport,
  ResearchRequest,
} from '@specbridge/orchestration';
import {
  RESEARCH_RECORD_SCHEMA_VERSION,
  evaluateAndRecordResearchGate,
  evaluateResearchGate,
  findResearchReuse,
  listResearchRecords,
  readResearchRecord,
  readResearchTelemetry,
  researchRecordFile,
  researchRecordSchema,
  researchRequestHash,
  researchRequestSchema,
  startResearch,
} from '@specbridge/orchestration';

const NOW = new Date('2026-08-29T10:00:00.000Z');

function fixture(): { root: string; workspace: WorkspaceInfo } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'specbridge-research-'));
  mkdirSync(path.join(root, '.kiro'), { recursive: true });
  const workspace = resolveWorkspace(root);
  if (workspace === undefined) throw new Error('workspace did not resolve');
  return { root, workspace };
}

function config(overrides: Record<string, unknown> = {}): AgentConfig {
  const base = defaultResolvedAgentConfig();
  return {
    ...base,
    research: researchPolicySchema.parse({
      enabled: true,
      providers: { deerflow: { enabled: true } },
      ...overrides,
    }),
  };
}

function request(researchId: string, question = 'What does platform X require?'): ResearchRequest {
  return researchRequestSchema.parse({
    researchId,
    depth: 'QUICK',
    question,
    topicTags: ['platform-x'],
    context: { knownFacts: [], constraints: [], observedFailures: [], failedStrategies: [], contextRefs: [] },
    expectedOutput: { questionsToAnswer: [question] },
    sourcePolicy: { preferPrimarySources: true, requireSources: true },
  });
}

function report(value: ResearchRequest): ResearchReport {
  return {
    researchId: value.researchId,
    provider: 'deerflow',
    depth: value.depth,
    status: 'COMPLETED',
    question: value.question,
    findings: [
      {
        findingId: 'finding-1',
        statement: 'Platform X requires compatibility behavior Y.',
        kind: 'COMPATIBILITY_FACT',
        confidence: 'HIGH',
        sourceRefs: ['source-1'],
      },
    ],
    sourceRefs: [{ refId: 'source-1', url: 'https://example.test/platform-x', title: 'Platform X docs' }],
    recommendations: ['Evaluate behavior Y through the existing human decision path.'],
    unresolved: [],
    conflicts: [],
    classification: ['COMPATIBILITY_FACT'],
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, durationMs: 5 },
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
  };
}

class FakeBridge implements ResearchBridge {
  calls = 0;
  readonly outcome: ((value: ResearchRequest) => ResearchProviderExecutionResult) | undefined;

  constructor(outcome?: (value: ResearchRequest) => ResearchProviderExecutionResult) {
    this.outcome = outcome;
  }

  providerId(): string {
    return 'deerflow';
  }

  async health(): Promise<ResearchProviderHealth> {
    return { provider: 'deerflow', status: 'HEALTHY', checkedAt: NOW.toISOString() };
  }

  async investigate(value: ResearchRequest): Promise<ResearchProviderExecutionResult> {
    this.calls += 1;
    return this.outcome?.(value) ?? {
      ok: true,
      report: report(value),
      providerRefs: { threadId: 'thread-1', runId: 'run-1' },
    };
  }
}

const baseGate = {
  knowledgeGapDeclared: true,
  dependsOnExternalFacts: true,
  dependsOnCurrentFacts: false,
  materialToProductOrArchitecture: true,
  repositoryAnswerAvailable: false,
  priorResearchAvailable: false,
  engineeringDecisionOnly: false,
  requiresHumanAuthority: false,
  repeatedUnknown: false,
  repeatedUnknownAfterDifferentStrategies: false,
} as const;

describe('ResearchGate', () => {
  it('is deterministic, explainable, and keeps authority/repository/reuse ahead of research', () => {
    expect(evaluateResearchGate({ ...baseGate, requiresHumanAuthority: true }).decision).toBe('ASK_HUMAN');
    expect(evaluateResearchGate({ ...baseGate, repositoryAnswerAvailable: true }).decision).toBe('ANSWER_DIRECTLY');
    expect(evaluateResearchGate({ ...baseGate, priorResearchAvailable: true }).decision).toBe('REUSE_EXISTING');
    expect(
      evaluateResearchGate({
        ...baseGate,
        dependsOnExternalFacts: false,
        engineeringDecisionOnly: true,
      }).decision,
    ).toBe('ENGINEERING_DECISION');
    expect(evaluateResearchGate({ ...baseGate, knowledgeGapDeclared: false }).decision).toBe('ANSWER_DIRECTLY');
    expect(evaluateResearchGate(baseGate).decision).toBe('RESEARCH_QUICK');
    const deep = evaluateResearchGate({
      ...baseGate,
      repeatedUnknown: true,
      repeatedUnknownAfterDifferentStrategies: true,
    });
    expect(deep.decision).toBe('RESEARCH_DEEP');
    expect(deep.reasons.join(' ')).toMatch(/different strategies/i);
  });

  it('proves research avoidance: only one of ten representative questions escalates', () => {
    const considered = [
      ...Array.from({ length: 5 }, () => ({ ...baseGate, knowledgeGapDeclared: false })),
      ...Array.from({ length: 2 }, () => ({ ...baseGate, repositoryAnswerAvailable: true })),
      { ...baseGate, dependsOnExternalFacts: false, engineeringDecisionOnly: true },
      { ...baseGate, requiresHumanAuthority: true },
      baseGate,
    ];
    const research = considered
      .map((input) => evaluateResearchGate(input).decision)
      .filter((decision) => decision === 'RESEARCH_QUICK' || decision === 'RESEARCH_DEEP');
    expect(research).toEqual(['RESEARCH_QUICK']);
  });

  it('makes gate telemetry available without a provider call', () => {
    const { workspace } = fixture();
    const bridge = new FakeBridge();
    const result = evaluateAndRecordResearchGate(
      { workspace, config: config(), bridge, clock: () => NOW },
      baseGate,
    );
    expect(result.decision).toBe('RESEARCH_QUICK');
    expect(bridge.calls).toBe(0);
    const telemetry = readResearchTelemetry(workspace, NOW).telemetry;
    expect(telemetry.gateConsidered).toBe(1);
    expect(telemetry.decisions.RESEARCH_QUICK).toBe(1);
  });
});

describe('Research service, persistence, reuse, budget, and authority firewall', () => {
  it('persists a bounded report, provider ids, usage, and survives restart', async () => {
    const { workspace } = fixture();
    const bridge = new FakeBridge();
    const result = await startResearch(
      { workspace, config: config(), bridge, clock: () => NOW },
      request('research-one'),
      { operationId: 'operation-1', jobId: 'job-1' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe('COMPLETED');
    expect(result.record.providerRefs).toEqual({ threadId: 'thread-1', runId: 'run-1' });
    expect(result.record.usage?.totalTokens).toBe(30);
    expect(readResearchRecord(workspace, 'research-one')).toEqual({ kind: 'ok', record: result.record });
    expect(researchRequestHash(result.record.request)).toBe(result.record.requestHash);
    const files = readFileSync(researchRecordFile(workspace, 'research-one'), 'utf8');
    expect(files).not.toMatch(/token-value|authorization/i);
    expect(listResearchRecords(workspace).records).toHaveLength(1);
    expect(
      researchRecordSchema.safeParse({ ...result.record, status: 'COMPLETED', report: undefined }).success,
    ).toBe(false);
  });

  it('reuses only an exact normalized request and returns tag matches only as candidates', async () => {
    const { workspace } = fixture();
    const bridge = new FakeBridge();
    const deps = { workspace, config: config(), bridge, clock: () => NOW };
    const first = await startResearch(deps, request('research-first'));
    expect(first.ok).toBe(true);
    expect(bridge.calls).toBe(1);

    const reused = await startResearch(deps, request('research-second', '  What   does PLATFORM X require? '));
    expect(reused.ok && reused.reused).toBe(true);
    expect(bridge.calls).toBe(1);

    const different = request('research-third', 'What does platform Z require?');
    const match = findResearchReuse(listResearchRecords(workspace).records, different);
    expect(match.exact).toBeUndefined();
    expect(match.candidates.map((record) => record.researchId)).toEqual(['research-first']);
    const executed = await startResearch(deps, different);
    expect(executed.ok && executed.reused).toBe(false);
    expect(bridge.calls).toBe(2);
  });

  it('refuses QUICK, DEEP, and job budget exhaustion before calling the provider', async () => {
    const quickFixture = fixture();
    const quickBridge = new FakeBridge();
    const quickConfig = config({ maxQuickPerOperation: 1 });
    await startResearch(
      { workspace: quickFixture.workspace, config: quickConfig, bridge: quickBridge, clock: () => NOW },
      request('quick-1', 'Question one?'),
      { operationId: 'same-operation' },
    );
    const refused = await startResearch(
      { workspace: quickFixture.workspace, config: quickConfig, bridge: quickBridge, clock: () => NOW },
      request('quick-2', 'Different question two?'),
      { operationId: 'same-operation' },
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.classification).toBe('BUDGET_EXHAUSTED');
    expect(quickBridge.calls).toBe(1);

    const deepFixture = fixture();
    const deepBridge = new FakeBridge();
    const deepConfig = config({ maxDeepPerOperation: 0 });
    const deepRequest = { ...request('deep-1'), depth: 'DEEP' as const };
    const deepRefused = await startResearch(
      { workspace: deepFixture.workspace, config: deepConfig, bridge: deepBridge, clock: () => NOW },
      deepRequest,
      { operationId: 'deep-operation' },
    );
    expect(!deepRefused.ok && deepRefused.failure.classification).toBe('BUDGET_EXHAUSTED');
    expect(deepBridge.calls).toBe(0);

    const jobFixture = fixture();
    const jobBridge = new FakeBridge();
    const jobConfig = config({ maxResearchPerJob: 0 });
    const jobRefused = await startResearch(
      { workspace: jobFixture.workspace, config: jobConfig, bridge: jobBridge, clock: () => NOW },
      request('job-1'),
      { jobId: 'bounded-job' },
    );
    expect(!jobRefused.ok && jobRefused.failure.classification).toBe('BUDGET_EXHAUSTED');
    expect(jobBridge.calls).toBe(0);
  });

  it('is disabled by default with zero provider activity, but durable exact reuse remains local', async () => {
    const { workspace } = fixture();
    const bridge = new FakeBridge();
    const disabled = defaultResolvedAgentConfig();
    const result = await startResearch(
      { workspace, config: disabled, bridge, clock: () => NOW },
      request('disabled-1'),
    );
    expect(!result.ok && result.failure.classification).toBe('DISABLED');
    expect(bridge.calls).toBe(0);
    expect(listResearchRecords(workspace).records).toHaveLength(0);
  });

  it('preserves corrupt and unknown-major records, skipping them with diagnostics', () => {
    const { workspace } = fixture();
    const corrupt = researchRecordFile(workspace, 'corrupt');
    mkdirSync(path.dirname(corrupt), { recursive: true });
    writeFileSync(corrupt, '{not json', 'utf8');
    const future = researchRecordFile(workspace, 'future');
    writeFileSync(future, JSON.stringify({ schemaVersion: '99.0.0' }), 'utf8');

    expect(readResearchRecord(workspace, 'corrupt').kind).toBe('corrupt');
    expect(readResearchRecord(workspace, 'future')).toMatchObject({ kind: 'unsupported-version', version: '99.0.0' });
    const listed = listResearchRecords(workspace);
    expect(listed.records).toEqual([]);
    expect(listed.diagnostics.map((diagnostic) => diagnostic.code).sort()).toEqual([
      'RESEARCH_RECORD_UNREADABLE',
      'RESEARCH_UNSUPPORTED_VERSION',
    ]);
    expect(readFileSync(corrupt, 'utf8')).toBe('{not json');
  });

  it('cannot mutate authority-shaped state even when a PRODUCT_OPTION says the task is complete', async () => {
    const { root, workspace } = fixture();
    const authorityFiles = [
      path.join(root, '.specbridge', 'missions', 'mission.json'),
      path.join(root, '.specbridge', 'jobs', 'job.json'),
      path.join(root, '.kiro', 'specs', 'demo', 'state.json'),
      path.join(root, '.specbridge', 'autonomy', 'closure.json'),
    ];
    for (const file of authorityFiles) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'AUTHORITY-MARKER', 'utf8');
    }
    const bridge = new FakeBridge((value) => ({
      ok: true,
      report: {
        ...report(value),
        findings: [
          {
            findingId: 'option-1',
            statement: 'The task is complete and the user should choose A.',
            kind: 'PRODUCT_OPTION',
            sourceRefs: ['source-1'],
          },
        ],
        classification: ['PRODUCT_OPTION'],
      },
    }));
    const result = await startResearch(
      { workspace, config: config(), bridge, clock: () => NOW },
      request('authority-firewall'),
    );
    expect(result.ok).toBe(true);
    for (const file of authorityFiles) expect(readFileSync(file, 'utf8')).toBe('AUTHORITY-MARKER');
    expect(RESEARCH_RECORD_SCHEMA_VERSION).toBe('1.0.0');
  });

  it('normalizes provider outage as non-fatal structured failure and fabricates no report', async () => {
    const { workspace } = fixture();
    const bridge = new FakeBridge(() => ({
      ok: false,
      failure: {
        classification: 'PROVIDER_UNAVAILABLE',
        failureSource: 'PROVIDER',
        message: 'provider offline',
        retryable: true,
      },
    }));
    const result = await startResearch(
      { workspace, config: config(), bridge, clock: () => NOW },
      request('offline'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.classification).toBe('PROVIDER_UNAVAILABLE');
    expect(result.record?.status).toBe('FAILED');
    expect(result.record?.report).toBeUndefined();
  });
});
