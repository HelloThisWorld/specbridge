import { mkdirSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentConfig, WorkspaceInfo } from '@specbridge/core';
import { defaultResolvedAgentConfig, researchPolicySchema, resolveWorkspace } from '@specbridge/core';
import type {
  ResearchBridge,
  ResearchProviderExecutionResult,
  ResearchProviderHealth,
  ResearchReport,
  ResearchRequest,
} from '@specbridge/orchestration';
import {
  considerLifecycleResearch,
  evaluateRuntimeResearchTrigger,
  listResearchUseRecords,
  prepareDecisionBrief,
  readResearchTelemetry,
  researchRequestSchema,
} from '@specbridge/orchestration';

const NOW = new Date('2026-08-29T12:00:00.000Z');
const gate = {
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

function fixture(): { workspace: WorkspaceInfo; root: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'specbridge-lifecycle-research-'));
  mkdirSync(path.join(root, '.kiro'), { recursive: true });
  const workspace = resolveWorkspace(root);
  if (workspace === undefined) throw new Error('workspace did not resolve');
  return { workspace, root };
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

function request(
  researchId: string,
  question = 'What compatibility behavior does Platform X currently require?',
  currentFactSensitive = false,
  depth: 'QUICK' | 'DEEP' = 'QUICK',
): ResearchRequest {
  return researchRequestSchema.parse({
    researchId,
    depth,
    question,
    topicTags: ['platform-x', 'compatibility'],
    context: {
      knownFacts: ['The product is an MVP.'],
      observedFailures: [],
      failedStrategies: [],
      constraints: ['Do not invent a compatibility promise.'],
      contextRefs: ['snapshot:current'],
    },
    expectedOutput: { questionsToAnswer: [question] },
    sourcePolicy: { preferPrimarySources: true, requireSources: true },
    freshness: {
      currentFactSensitive,
      ...(currentFactSensitive ? { subjectVersion: '2026-api' } : {}),
    },
  });
}

function report(value: ResearchRequest): ResearchReport {
  return {
    researchId: value.researchId,
    provider: 'deerflow',
    depth: value.depth,
    status: 'COMPLETED',
    question: value.question,
    findings: [{
      findingId: 'fact-1',
      statement: 'Platform X exposes three compatibility levels.',
      kind: 'COMPATIBILITY_FACT',
      confidence: 'HIGH',
      sourceRefs: ['source-1'],
    }, {
      findingId: 'option-1',
      statement: 'Partial behavioral compatibility is one product option.',
      kind: 'PRODUCT_OPTION',
      confidence: 'MEDIUM',
      sourceRefs: ['source-1'],
    }],
    sourceRefs: [{ refId: 'source-1', url: 'https://example.test/platform-x', title: 'Platform X documentation' }],
    recommendations: ['Consider partial compatibility for the MVP.'],
    unresolved: [],
    conflicts: [],
    classification: ['COMPATIBILITY_FACT', 'PRODUCT_OPTION'],
    usage: { totalTokens: 42, durationMs: 7 },
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
  };
}

class FakeBridge implements ResearchBridge {
  calls = 0;
  constructor(private readonly outcome?: (value: ResearchRequest) => ResearchProviderExecutionResult) {}
  providerId(): string { return 'deerflow'; }
  async health(): Promise<ResearchProviderHealth> {
    return { provider: 'deerflow', status: 'HEALTHY', checkedAt: NOW.toISOString() };
  }
  async investigate(value: ResearchRequest): Promise<ResearchProviderExecutionResult> {
    this.calls += 1;
    return this.outcome?.(value) ?? { ok: true, report: report(value) };
  }
}

function lifecycleInput(
  phase: 'CONVERSATION' | 'SPEC_DRAFT' | 'INTAKE_DECISION' | 'RUNTIME_INVESTIGATION',
  classification: 'KNOWN_BY_MODEL' | 'KNOWN_BY_REPOSITORY' | 'KNOWN_BY_PRIOR_RESEARCH' | 'ENGINEERING_DECISION' | 'EXTERNAL_KNOWLEDGE_GAP' | 'PRODUCT_AUTHORITY' | 'UNRESOLVED',
  researchRequest: ResearchRequest,
) {
  return {
    phase,
    classification,
    reason: 'Compatibility behavior is material to the public product contract.',
    gate,
    request: researchRequest,
    operationId: 'conversation-1',
    refreshCurrentFacts: false,
  } as const;
}

describe('research-augmented lifecycle routing', () => {
  it('answers stable knowledge and repository facts without provider activity, including user unfamiliarity', async () => {
    const { workspace } = fixture();
    const bridge = new FakeBridge();
    const deps = { workspace, config: config(), bridge, clock: () => NOW };
    const model = await considerLifecycleResearch(deps, lifecycleInput('CONVERSATION', 'KNOWN_BY_MODEL', request('model')));
    const repository = await considerLifecycleResearch(deps, lifecycleInput('CONVERSATION', 'KNOWN_BY_REPOSITORY', request('repo')));
    // "I do not know" is represented as user context, not as a knowledge-gap signal.
    const unfamiliar = await considerLifecycleResearch(deps, {
      ...lifecycleInput('CONVERSATION', 'KNOWN_BY_MODEL', request('unfamiliar')),
      reason: 'The user said they are unfamiliar with this domain.',
    });
    expect(model.gate.decision).toBe('ANSWER_DIRECTLY');
    expect(repository.gate.decision).toBe('ANSWER_DIRECTLY');
    expect(unfamiliar.gate.decision).toBe('ANSWER_DIRECTLY');
    expect(bridge.calls).toBe(0);
  });

  it('uses one shared store across conversation, draft, and intake with exact reuse provenance', async () => {
    const { workspace } = fixture();
    const bridge = new FakeBridge();
    const deps = { workspace, config: config(), bridge, clock: () => NOW };
    const first = await considerLifecycleResearch(deps, lifecycleInput('CONVERSATION', 'EXTERNAL_KNOWLEDGE_GAP', request('conversation')));
    const second = await considerLifecycleResearch(deps, lifecycleInput('SPEC_DRAFT', 'EXTERNAL_KNOWLEDGE_GAP', request('draft')));
    const third = await considerLifecycleResearch(deps, {
      ...lifecycleInput('INTAKE_DECISION', 'EXTERNAL_KNOWLEDGE_GAP', request('intake')),
      usedBy: 'question-compatibility',
    });
    expect(first.execution?.ok).toBe(true);
    expect(second.execution?.ok && second.execution.reused).toBe(true);
    expect(third.execution?.ok && third.execution.reused).toBe(true);
    expect(bridge.calls).toBe(1);
    expect(listResearchUseRecords(workspace).map((use) => [use.phase, use.useKind, use.authority])).toEqual(
      expect.arrayContaining([
        ['CONVERSATION', 'NEW', 'EVIDENCE_ONLY'],
        ['SPEC_DRAFT', 'REUSED', 'EVIDENCE_ONLY'],
        ['INTAKE_DECISION', 'REUSED', 'EVIDENCE_ONLY'],
      ]),
    );
  });

  it('keeps pure preferences and engineering choices off the provider path', async () => {
    const { workspace } = fixture();
    const bridge = new FakeBridge();
    const deps = { workspace, config: config(), bridge, clock: () => NOW };
    const preference = await considerLifecycleResearch(
      deps,
      lifecycleInput(
        'INTAKE_DECISION',
        'PRODUCT_AUTHORITY',
        request('preference', 'Should deleted records remain visible?'),
      ),
    );
    const implementation = await considerLifecycleResearch(
      deps,
      lifecycleInput(
        'SPEC_DRAFT',
        'ENGINEERING_DECISION',
        request('implementation', 'Which internal data structure should the worker use?'),
      ),
    );
    expect(preference.gate.decision).toBe('ASK_HUMAN');
    expect(implementation.gate.decision).toBe('ENGINEERING_DECISION');
    expect(bridge.calls).toBe(0);
  });

  it('rejects a DEEP request that was authorized only as QUICK', async () => {
    const { workspace } = fixture();
    const bridge = new FakeBridge();
    await expect(considerLifecycleResearch(
      { workspace, config: config(), bridge, clock: () => NOW },
      lifecycleInput(
        'CONVERSATION',
        'EXTERNAL_KNOWLEDGE_GAP',
        request('depth-mismatch', 'What domain patterns apply?', false, 'DEEP'),
      ),
    )).rejects.toThrow(/requestedDepth must match/);
    expect(bridge.calls).toBe(0);
  });

  it('requires explicit refresh for current facts and retains version sensitivity', async () => {
    const { workspace } = fixture();
    const bridge = new FakeBridge();
    const deps = { workspace, config: config(), bridge, clock: () => NOW };
    await considerLifecycleResearch(deps, lifecycleInput('CONVERSATION', 'EXTERNAL_KNOWLEDGE_GAP', request('current-1', undefined, true)));
    const reused = await considerLifecycleResearch(deps, lifecycleInput('SPEC_DRAFT', 'EXTERNAL_KNOWLEDGE_GAP', request('current-2', undefined, true)));
    const refreshed = await considerLifecycleResearch(deps, {
      ...lifecycleInput('INTAKE_DECISION', 'EXTERNAL_KNOWLEDGE_GAP', request('current-3', undefined, true)),
      refreshCurrentFacts: true,
    });
    expect(reused.execution?.ok && reused.execution.reused).toBe(true);
    expect(refreshed.execution?.ok && refreshed.execution.reused).toBe(false);
    expect(refreshed.execution?.ok && refreshed.execution.record.request.freshness).toEqual({
      currentFactSensitive: true,
      subjectVersion: '2026-api',
    });
    expect(bridge.calls).toBe(2);
  });

  it('prepares an intake DecisionBrief but cannot answer the question or promote research to authority', async () => {
    const { workspace } = fixture();
    const bridge = new FakeBridge();
    const brief = await prepareDecisionBrief(
      { workspace, config: config(), bridge, clock: () => NOW },
      {
        questionId: 'q-compatibility',
        question: 'Which compatibility level should the product promise?',
        context: ['The current product has no sealed compatibility promise.'],
        options: [
          { id: 'A', label: 'Resemblance', description: 'Configuration resemblance only.', consequences: ['Smallest contract.'] },
          { id: 'B', label: 'Partial', description: 'Selected behavioral compatibility.', consequences: ['Requires conformance tests.'] },
        ],
        recommendation: { optionId: 'B', rationale: ['Balances user familiarity and contract size.'] },
        repositoryEvidenceRefs: ['snapshot:current'],
        research: {
          ...lifecycleInput('INTAKE_DECISION', 'PRODUCT_AUTHORITY', request('decision')),
          usedBy: 'q-compatibility',
        },
      },
    );
    expect(brief.requiresHumanDecision).toBe(true);
    expect(brief.recommendation?.optionId).toBe('B');
    expect(brief.context.join('\n')).toMatch(/Research option \(not a decision\)/);
    expect(brief.researchRefs).toEqual(['decision']);
    expect(Object.keys(brief)).not.toContain('answer');
    expect(readFileSync(path.join(workspace.sidecarDir, 'research', 'records', 'decision.json'), 'utf8')).toContain('PRODUCT_OPTION');
  });

  it('reports budget limitation honestly without fabricating a brief answer', async () => {
    const { workspace } = fixture();
    const bridge = new FakeBridge();
    const brief = await prepareDecisionBrief(
      { workspace, config: config({ maxQuickPerOperation: 0 }), bridge, clock: () => NOW },
      {
        questionId: 'q-budget',
        question: 'Which external compatibility promise?',
        options: [],
        context: [],
        repositoryEvidenceRefs: [],
        research: lifecycleInput('INTAKE_DECISION', 'EXTERNAL_KNOWLEDGE_GAP', request('budget')),
      },
    );
    expect(brief.researchOutcome).toBe('BUDGET_LIMITED');
    expect(brief.requiresHumanDecision).toBe(true);
    expect(bridge.calls).toBe(0);
  });
});

describe('runtime research trigger', () => {
  it('requires the same durable fingerprint and materially distinct strategies', () => {
    const input = {
      explicitExternalKnowledgeGap: false,
      externalAssumptionContradiction: false,
      unknownToolingOrPlatformBehavior: false,
      repositoryAnswerAvailable: false,
      productAuthorityAmbiguity: false,
      insufficientRepositoryContext: false,
      failureCategory: 'NO_PROGRESS' as const,
      failureSource: 'UNKNOWN' as const,
      failureFingerprint: 'problem-a',
    };
    const identical = evaluateRuntimeResearchTrigger({
      ...input,
      observations: [
        { failureFingerprint: 'problem-a', strategyKey: 'same' },
        { failureFingerprint: 'problem-a', strategyKey: 'same' },
      ],
    });
    const distinct = evaluateRuntimeResearchTrigger({
      ...input,
      observations: [
        { failureFingerprint: 'problem-a', strategyKey: 'plan-1' },
        { failureFingerprint: 'problem-a', strategyKey: 'plan-2' },
      ],
    });
    expect(identical.eligible).toBe(false);
    expect(distinct).toMatchObject({ eligible: true, depth: 'DEEP', repeatedCount: 2 });
  });

  it.each([
    ['AUTHENTICATION', 'AUTHORIZATION'],
    ['BUDGET_EXHAUSTED', 'BUDGET'],
    ['VERIFICATION_FAILURE', 'IMPLEMENTATION'],
    ['CAPABILITY_UNAVAILABLE', 'EXECUTION_INFRASTRUCTURE'],
  ] as const)('does not research ordinary %s failures', (failureCategory, failureSource) => {
    const result = evaluateRuntimeResearchTrigger({
      explicitExternalKnowledgeGap: true,
      externalAssumptionContradiction: true,
      unknownToolingOrPlatformBehavior: true,
      repositoryAnswerAvailable: false,
      productAuthorityAmbiguity: false,
      insufficientRepositoryContext: false,
      failureCategory,
      failureSource,
      failureFingerprint: 'ordinary',
      observations: [
        { failureFingerprint: 'ordinary', strategyKey: 'a' },
        { failureFingerprint: 'ordinary', strategyKey: 'b' },
      ],
    });
    expect(result.eligible).toBe(false);
  });
});

describe('research-avoidance qualification', () => {
  it('keeps new provider calls a small minority across twenty representative unknowns', async () => {
    const { workspace } = fixture();
    const bridge = new FakeBridge();
    const deps = { workspace, config: config(), bridge, clock: () => NOW };
    const classifications = [
      ...Array.from({ length: 10 }, () => 'KNOWN_BY_MODEL' as const),
      ...Array.from({ length: 4 }, () => 'KNOWN_BY_REPOSITORY' as const),
      ...Array.from({ length: 2 }, () => 'ENGINEERING_DECISION' as const),
      ...Array.from({ length: 2 }, () => 'PRODUCT_AUTHORITY' as const),
      'EXTERNAL_KNOWLEDGE_GAP' as const,
      'KNOWN_BY_PRIOR_RESEARCH' as const,
    ];
    for (const [index, classification] of classifications.entries()) {
      await considerLifecycleResearch(
        deps,
        lifecycleInput('CONVERSATION', classification, request(`qualification-${index}`)),
      );
    }
    const telemetry = readResearchTelemetry(workspace, NOW).telemetry;
    expect(bridge.calls).toBe(1);
    expect(telemetry.gateConsidered).toBe(20);
    expect(telemetry.byPhase.CONVERSATION.considered).toBe(20);
    expect(telemetry.researchAvoidanceRatio).toBeGreaterThanOrEqual(0.9);
    expect(telemetry.newQuick).toBe(1);
    expect(telemetry.reusedReports).toBe(1);
  });
});

describe('lifecycle qualification scenarios', () => {
  it('qualifies new-domain discovery with sparse DEEP research and human authority', async () => {
    const { workspace } = fixture();
    const bridge = new FakeBridge();
    const deps = { workspace, config: config(), bridge, clock: () => NOW };
    const domainQuestion = 'Which guest bootstrap and metadata patterns constrain a lightweight IaaS MVP?';
    const domainRequest = request('domain-discovery', domainQuestion, false, 'DEEP');
    await considerLifecycleResearch(
      deps,
      lifecycleInput('CONVERSATION', 'KNOWN_BY_MODEL', request('security-group', 'What is a security group?')),
    );
    await considerLifecycleResearch(
      deps,
      lifecycleInput('CONVERSATION', 'KNOWN_BY_REPOSITORY', request('current-bootstrap', 'How does this repository bootstrap guests?')),
    );
    const researched = await considerLifecycleResearch(deps, {
      ...lifecycleInput('CONVERSATION', 'EXTERNAL_KNOWLEDGE_GAP', domainRequest),
      gate: { ...gate, requestedDepth: 'DEEP' },
    });
    const brief = await prepareDecisionBrief(deps, {
      questionId: 'q-metadata-contract',
      question: 'Which metadata compatibility promise should the MVP make?',
      context: ['The user has not selected product semantics.'],
      options: [
        { id: 'A', label: 'Proprietary', description: 'Small internal contract.', consequences: ['No compatibility promise.'] },
        { id: 'B', label: 'Partial', description: 'Selected familiar behavior.', consequences: ['Requires conformance tests.'] },
      ],
      recommendation: { optionId: 'A', rationale: ['Keeps the MVP contract narrow.'] },
      repositoryEvidenceRefs: ['snapshot:greenfield'],
      research: {
        ...lifecycleInput('INTAKE_DECISION', 'PRODUCT_AUTHORITY', request('domain-decision', domainQuestion, false, 'DEEP')),
        gate: { ...gate, requestedDepth: 'DEEP' },
      },
    });
    const telemetry = readResearchTelemetry(workspace, NOW).telemetry;
    expect(researched.gate.decision).toBe('RESEARCH_DEEP');
    expect(bridge.calls).toBe(1);
    expect(brief).toMatchObject({ requiresHumanDecision: true, researchOutcome: 'REUSED' });
    expect(telemetry.newDeep).toBe(1);
    expect(telemetry.reusedReports).toBe(1);
  });

  it('qualifies Brownfield reuse before one bounded remediation-safety research', async () => {
    const { workspace } = fixture();
    const bridge = new FakeBridge();
    const deps = { workspace, config: config(), bridge, clock: () => NOW };
    for (const capability of ['RBAC', 'JobScheduler', 'ExecutionAudit', 'Prometheus']) {
      const result = await considerLifecycleResearch(
        deps,
        lifecycleInput(
          'SPEC_DRAFT',
          'KNOWN_BY_REPOSITORY',
          request(`repo-${capability}`, `Does the current system already provide ${capability}?`),
        ),
      );
      expect(result.gate.decision).toBe('ANSWER_DIRECTLY');
    }
    const safetyQuestion = 'Which external remediation safety patterns materially constrain automated repair?';
    const researched = await considerLifecycleResearch(
      deps,
      lifecycleInput('SPEC_DRAFT', 'EXTERNAL_KNOWLEDGE_GAP', request('remediation-safety', safetyQuestion)),
    );
    const brief = await prepareDecisionBrief(deps, {
      questionId: 'q-remediation-authority',
      question: 'Which remediation actions may run without operator approval?',
      context: ['Existing RBAC, scheduling, audit, and metrics remain reused capabilities.'],
      options: [],
      repositoryEvidenceRefs: ['snapshot:rbac', 'snapshot:scheduler', 'snapshot:audit', 'snapshot:prometheus'],
      research: lifecycleInput(
        'INTAKE_DECISION',
        'PRODUCT_AUTHORITY',
        request('remediation-decision', safetyQuestion),
      ),
    });
    expect(researched.gate.decision).toBe('RESEARCH_QUICK');
    expect(bridge.calls).toBe(1);
    expect(brief.requiresHumanDecision).toBe(true);
    expect(brief.researchOutcome).toBe('REUSED');
    expect(brief.repositoryEvidenceRefs).toHaveLength(4);
  });
});

describe('authority firewall structure', () => {
  it('keeps decision preparation and research MCP code independent of intake-answer authority', () => {
    const lifecycle = readFileSync(path.join(process.cwd(), 'packages', 'orchestration', 'src', 'research', 'lifecycle.ts'), 'utf8');
    const researchTools = readFileSync(path.join(process.cwd(), 'packages', 'mcp-server', 'src', 'tools', 'research-tools.ts'), 'utf8');
    expect(lifecycle).not.toMatch(/from ['"].*intake|spec_intake_answer|answerIntakeQuestion/i);
    expect(researchTools).not.toMatch(/registerSpecIntakeAnswer|answerIntakeQuestion/);
  });
});
