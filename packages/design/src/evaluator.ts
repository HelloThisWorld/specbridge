import { DESIGN_STAGES, sha256, stableId } from '@specbridge/core';
import type {
  AcceptanceCriterion,
  CurrentSystemSnapshot,
  DesignSession,
  EvaluationFinding,
  FunctionalRequirement,
  NonFunctionalRequirement,
  SpecQualityReport,
} from '@specbridge/core';

type Dimension = EvaluationFinding['dimension'];

export interface ModelEvaluationFinding {
  dimension: Dimension;
  severity: 'WARN' | 'FAIL';
  message: string;
  references: string[];
}

export interface SpecEvaluationProvider {
  evaluate(input: {
    session: DesignSession;
    snapshot: CurrentSystemSnapshot;
    deterministicReport: SpecQualityReport;
  }): Promise<ModelEvaluationFinding[]>;
}

const CONTRADICTION_STOP_WORDS = new Set([
  'agent',
  'coding',
  'design',
  'first',
  'implementation',
  'outside',
  'product',
  'specbridge',
  'system',
  'the',
  'this',
  'will',
  'with',
  'without',
]);

function meaningfulTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4 && !CONTRADICTION_STOP_WORDS.has(token)),
  );
}

function sharesMeaningfulToken(left: string, right: string): boolean {
  const rightTokens = meaningfulTokens(right);
  return [...meaningfulTokens(left)].some((token) => rightTokens.has(token));
}

function arrayOfObjects(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null && !Array.isArray(item),
      )
    : [];
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function stage(session: DesignSession, name: keyof DesignSession['stages']): Record<string, unknown> {
  return (session.stages[name] ?? {}) as Record<string, unknown>;
}

function functionalRequirements(session: DesignSession): FunctionalRequirement[] {
  return arrayOfObjects(stage(session, 'functional-requirements')['requirements']) as unknown as FunctionalRequirement[];
}

function nonFunctionalRequirements(session: DesignSession): NonFunctionalRequirement[] {
  return arrayOfObjects(
    stage(session, 'non-functional-requirements')['requirements'],
  ) as unknown as NonFunctionalRequirement[];
}

function acceptanceCriteria(session: DesignSession): AcceptanceCriterion[] {
  return arrayOfObjects(
    stage(session, 'testing-acceptance')['acceptanceCriteria'],
  ) as unknown as AcceptanceCriterion[];
}

export function evaluateDesign(
  session: DesignSession,
  snapshot: CurrentSystemSnapshot,
  now: Date = new Date(),
  modelFindings: ModelEvaluationFinding[] = [],
): SpecQualityReport {
  const findings: EvaluationFinding[] = [];
  const add = (
    dimension: Dimension,
    severity: EvaluationFinding['severity'],
    message: string,
    references: string[] = [],
  ): void => {
    findings.push({
      id: stableId('QF', dimension, severity, message, ...references),
      dimension,
      severity,
      message,
      references,
    });
  };
  const addPassWhenClear = (dimension: Dimension, message: string): void => {
    if (!findings.some((finding) => finding.dimension === dimension)) {
      add(dimension, 'PASS', message);
    }
  };

  const missingStages = DESIGN_STAGES.filter((name) => session.stages[name] === undefined);
  if (missingStages.length > 0) {
    add(
      'COMPLETENESS',
      'FAIL',
      `Missing design stages: ${missingStages.join(', ')}.`,
      missingStages,
    );
  }
  const problem = stage(session, 'problem-framing');
  const goals = arrayOfStrings(problem['goals']);
  const nonGoals = arrayOfStrings(problem['nonGoals']);
  if (goals.length === 0) {
    add('PRODUCT_CLARITY', 'FAIL', 'At least one explicit goal is required.');
  }
  if (nonGoals.length === 0) {
    add('PRODUCT_CLARITY', 'FAIL', 'At least one explicit non-goal is required.');
  }
  const blockingDecisionIds = session.decisions
    .filter((decision) => decision.blocking && decision.status === 'OPEN')
    .map((decision) => decision.id);
  if (blockingDecisionIds.length > 0) {
    add(
      'PRODUCT_CLARITY',
      'FAIL',
      'Blocking product or research decisions remain open.',
      blockingDecisionIds,
    );
  }

  const frs = functionalRequirements(session);
  const nfrs = nonFunctionalRequirements(session);
  if (frs.length === 0) {
    add('COMPLETENESS', 'FAIL', 'Functional requirements are missing.');
  }
  if (nfrs.length === 0) {
    add('COMPLETENESS', 'FAIL', 'Non-functional requirements are missing.');
  }
  const nfrCategories = nfrs.map((requirement) => requirement.category.toLowerCase());
  const expectedNfrCategories = [
    'security',
    'reliability',
    'observability',
    ...(/multi[- ]tenant|tenant isolation/i.test(session.roughIdea)
      ? ['tenant isolation', 'privacy', 'auditability']
      : []),
  ];
  const missingNfrCategories = expectedNfrCategories.filter(
    (expected) =>
      !nfrCategories.some(
        (actual) => actual.includes(expected) || expected.includes(actual),
      ),
  );
  if (missingNfrCategories.length > 0) {
    add(
      'COMPLETENESS',
      'WARN',
      'Relevant non-functional requirement categories are not explicit.',
      missingNfrCategories,
    );
  }
  const requirementIds = [...frs.map((item) => item.id), ...nfrs.map((item) => item.id)];
  const duplicates = requirementIds.filter(
    (id, index) => requirementIds.indexOf(id) !== index,
  );
  if (duplicates.length > 0) {
    add('COMPLETENESS', 'FAIL', 'Requirement IDs must be unique.', [...new Set(duplicates)]);
  }
  const ungroundedDerived = [...frs, ...nfrs]
    .filter(
      (requirement) =>
        requirement.source === 'DERIVED' && requirement.sourceRefs.length === 0,
    )
    .map((requirement) => requirement.id);
  if (ungroundedDerived.length > 0) {
    add(
      'GROUNDING',
      'WARN',
      'Derived requirements should identify the user, repository, research, or decision evidence that justified them.',
      ungroundedDerived,
    );
  }
  if (snapshot.evidence.length === 0 || session.snapshotPath.length === 0) {
    add('GROUNDING', 'FAIL', 'The design has no durable repository evidence baseline.');
  }
  if (
    snapshot.identity.commit !== session.baselineCommit &&
    snapshot.identity.commit !== null &&
    session.baselineCommit !== null
  ) {
    add(
      'GROUNDING',
      'FAIL',
      'The repository baseline changed after the design session started; refresh repository intelligence.',
      [session.baselineCommit, snapshot.identity.commit],
    );
  }
  if (snapshot.identity.contentFingerprint !== session.baselineFingerprint) {
    add(
      'GROUNDING',
      'FAIL',
      'Repository content changed after the design session started; refresh repository intelligence and affected design claims.',
      [session.baselineFingerprint, snapshot.identity.contentFingerprint],
    );
  }

  const architecture = stage(session, 'architecture');
  const components = arrayOfObjects(architecture['components']);
  if (components.length === 0 || typeof architecture['mermaid'] !== 'string') {
    add(
      'ARCHITECTURE_COHERENCE',
      'FAIL',
      'Architecture must include explained components and a text diagram.',
    );
  }
  const unexplainedComponents = components
    .filter(
      (component) =>
        typeof component['responsibility'] !== 'string' ||
        typeof component['securityBoundary'] !== 'string' ||
        !Array.isArray(component['failureModes']),
    )
    .map((component) => String(component['name'] ?? '(unnamed)'));
  if (unexplainedComponents.length > 0) {
    add(
      'ARCHITECTURE_COHERENCE',
      'FAIL',
      'Every architecture component needs responsibility, failure modes, and a security boundary.',
      unexplainedComponents,
    );
  }
  const unjustifiedComponents = components
    .filter((component) => {
      const references = arrayOfStrings(component['requirementIds']);
      return (
        references.length === 0 ||
        references.some((reference) => !requirementIds.includes(reference))
      );
    })
    .map((component) => String(component['name'] ?? '(unnamed)'));
  if (unjustifiedComponents.length > 0) {
    add(
      'GROUNDING',
      'FAIL',
      'Every major architecture component must reference the requirements that justify it.',
      unjustifiedComponents,
    );
  }
  const decisionsWithoutAuthority = session.decisions
    .filter(
      (decision) =>
        !['HUMAN', 'ENGINEERING', 'RESEARCH', 'REPOSITORY'].includes(decision.authority) ||
        decision.source.length === 0,
    )
    .map((decision) => decision.id);
  if (decisionsWithoutAuthority.length > 0) {
    add(
      'PRODUCT_CLARITY',
      'FAIL',
      'Every product or engineering decision requires an explicit authority source.',
      decisionsWithoutAuthority,
    );
  }

  const adrs = arrayOfObjects(stage(session, 'alternatives')['decisions']);
  const ceremonialAdrs = adrs
    .filter((adr) => arrayOfObjects(adr['alternatives']).length < 2)
    .map((adr) => String(adr['id'] ?? '(unnamed)'));
  if (ceremonialAdrs.length > 0) {
    add(
      'TRADE_OFF_QUALITY',
      'FAIL',
      'Architecture decisions must compare at least two genuine alternatives.',
      ceremonialAdrs,
    );
  }
  if (adrs.length === 0 && components.length > 1) {
    add(
      'TRADE_OFF_QUALITY',
      'WARN',
      'No major architecture trade-off was recorded for a multi-component design.',
    );
  }

  const researchOpen = session.decisions
    .filter((decision) => decision.authority === 'RESEARCH' && decision.status === 'OPEN')
    .map((decision) => decision.id);
  if (researchOpen.length > 0) {
    add('RESEARCH_COVERAGE', 'FAIL', 'Required external research is unresolved.', researchOpen);
  }
  const unresolvedResearch = session.research
    .filter((report) => report.unresolved.length > 0)
    .map((report) => report.id);
  if (unresolvedResearch.length > 0) {
    add(
      'RESEARCH_COVERAGE',
      'WARN',
      'Research reports contain unresolved findings that should be represented as risks or decisions.',
      unresolvedResearch,
    );
  }
  const uncitedFindings = session.research
    .flatMap((report) => report.findings)
    .filter((finding) => finding.sourceIds.length === 0 && finding.kind !== 'RECOMMENDATION')
    .map((finding) => finding.id);
  if (uncitedFindings.length > 0) {
    add('RESEARCH_COVERAGE', 'FAIL', 'External facts and constraints require citations.', uncitedFindings);
  }
  const invalidResearchMetadata = session.research.flatMap((report) => {
    const invalid = Number.isNaN(Date.parse(report.researchedAt)) ? [report.id] : [];
    return [
      ...invalid,
      ...report.sources
        .filter(
          (source) =>
            source.url.trim().length === 0 || Number.isNaN(Date.parse(source.accessedAt)),
        )
        .map((source) => source.id),
    ];
  });
  if (invalidResearchMetadata.length > 0) {
    add(
      'RESEARCH_COVERAGE',
      'FAIL',
      'Research facts require valid source and freshness metadata.',
      invalidResearchMetadata,
    );
  }
  const staleResearch = session.research
    .filter(
      (report) =>
        report.freshnessUntil !== null &&
        Date.parse(report.freshnessUntil) <= now.getTime(),
    )
    .map((report) => report.id);
  if (staleResearch.length > 0) {
    add(
      'RESEARCH_COVERAGE',
      'WARN',
      'Version-dependent research has passed its declared freshness date.',
      staleResearch,
    );
  }
  const timelessVersionedResearch = session.research
    .filter(
      (report) =>
        report.freshnessUntil === null &&
        report.sources.some((source) => source.relevantVersion !== null),
    )
    .map((report) => report.id);
  if (timelessVersionedResearch.length > 0) {
    add(
      'RESEARCH_COVERAGE',
      'WARN',
      'Version-specific research must declare when its evidence should be refreshed.',
      timelessVersionedResearch,
    );
  }

  const securityControls = arrayOfObjects(stage(session, 'security')['controls']);
  if (securityControls.length === 0) {
    add('SECURITY', 'FAIL', 'Security threats, controls, and verification are missing.');
  }
  const security = stage(session, 'security');
  const aiRelevant = /\b(?:ai|llm|rag|model|prompt)\b/i.test(session.roughIdea);
  if (aiRelevant && arrayOfObjects(security['aiRisks']).length === 0) {
    add(
      'SECURITY',
      'FAIL',
      'AI designs must address prompt injection, untrusted model output, data leakage, and tool authorization where relevant.',
    );
  }
  if (
    /multi[- ]tenant|tenant isolation/i.test(session.roughIdea) &&
    !JSON.stringify(securityControls).toLowerCase().includes('tenant')
  ) {
    add('SECURITY', 'FAIL', 'A multi-tenant design requires verifiable tenant-isolation controls.');
  }
  const reliabilityScenarios = arrayOfObjects(
    stage(session, 'reliability')['failureScenarios'],
  );
  if (reliabilityScenarios.length === 0) {
    add('RELIABILITY', 'FAIL', 'Reliability failure behavior and recovery are missing.');
  }
  if (snapshot.projectType === 'BROWNFIELD') {
    const brownfield = stage(session, 'deployment-migration')['brownfield'];
    if (typeof brownfield !== 'object' || brownfield === null || Array.isArray(brownfield)) {
      add(
        'IMPLEMENTATION_READINESS',
        'FAIL',
        'Brownfield repositories require an explicit migration and legacy-removal design.',
      );
    }
  }

  const acceptance = acceptanceCriteria(session);
  const covered = new Set(acceptance.flatMap((criterion) => criterion.requirementIds));
  const uncoveredRequirementIds = requirementIds.filter((id) => !covered.has(id));
  const knownRequirementIds = new Set(requirementIds);
  const orphanAcceptanceIds = acceptance
    .filter((criterion) =>
      criterion.requirementIds.some((requirementId) => !knownRequirementIds.has(requirementId)),
    )
    .map((criterion) => criterion.id);
  if (acceptance.length === 0) {
    add('ACCEPTANCE_COVERAGE', 'FAIL', 'Acceptance criteria are missing.');
  }
  if (uncoveredRequirementIds.length > 0) {
    add(
      'ACCEPTANCE_COVERAGE',
      'FAIL',
      'Requirements without acceptance evidence were found.',
      uncoveredRequirementIds,
    );
  }
  if (orphanAcceptanceIds.length > 0) {
    add(
      'ACCEPTANCE_COVERAGE',
      'FAIL',
      'Acceptance criteria reference unknown requirements.',
      orphanAcceptanceIds,
    );
  }

  const nonGoalConflicts = frs
    .filter((requirement) =>
      nonGoals.some(
        (nonGoal) =>
          nonGoal.length >= 8 &&
          sharesMeaningfulToken(
            nonGoal,
            `${requirement.title} ${requirement.description} ${requirement.behavior}`,
          ),
      ),
    )
    .map((requirement) => requirement.id);
  if (nonGoalConflicts.length > 0) {
    add(
      'OPEN_RISKS',
      'FAIL',
      'A requirement directly reintroduces behavior declared as a non-goal.',
      nonGoalConflicts,
    );
  }
  const possibleScopeCreep = [...frs, ...nfrs]
    .filter(
      (requirement) =>
        requirement.source === 'DERIVED' && requirement.sourceRefs.length === 0,
    )
    .map((requirement) => requirement.id);
  if (possibleScopeCreep.length > 0) {
    add(
      'OPEN_RISKS',
      'WARN',
      'Possible scope creep: derived requirements lack a user, repository, research, or approved-decision justification.',
      possibleScopeCreep,
    );
  }
  const architectureText = JSON.stringify(architecture);
  if (
    /tenant.{0,30}isolat|isolat.{0,30}tenant/i.test(goals.join(' ')) &&
    /unrestricted|unscoped|cross[- ]tenant (?:read|query|access)/i.test(architectureText)
  ) {
    add(
      'OPEN_RISKS',
      'FAIL',
      'Architecture contradicts the stated tenant-isolation goal.',
      ['architecture'],
    );
  }
  const contractText = JSON.stringify(stage(session, 'api-events'));
  const contradictedConstraints = session.research.flatMap((report) => [
    ...report.contradictions.map(() => report.id),
    ...report.findings
      .filter(
        (finding) =>
          finding.kind === 'CONSTRAINT' &&
          /forbid|prohibit|must not|does not support|unsupported/i.test(finding.statement) &&
          sharesMeaningfulToken(finding.statement, contractText),
      )
      .map((finding) => finding.id),
  ]);
  if (contradictedConstraints.length > 0) {
    add(
      'OPEN_RISKS',
      'FAIL',
      'A design contract conflicts with research evidence or unresolved authoritative-source contradictions.',
      [...new Set(contradictedConstraints)],
    );
  }
  if (snapshot.uncertainties.length > 0) {
    add(
      'OPEN_RISKS',
      'WARN',
      'Repository intelligence contains unresolved uncertainties.',
      snapshot.uncertainties,
    );
  }

  for (const finding of modelFindings) {
    add(finding.dimension, finding.severity, finding.message, finding.references);
  }

  addPassWhenClear('COMPLETENESS', 'All required design stages and requirement sets are present.');
  addPassWhenClear('GROUNDING', 'Repository evidence and requirement attribution are present.');
  addPassWhenClear('PRODUCT_CLARITY', 'Goals, non-goals, and product decisions are explicit.');
  addPassWhenClear('ARCHITECTURE_COHERENCE', 'Architecture components have explained boundaries.');
  addPassWhenClear('TRADE_OFF_QUALITY', 'Major architecture choices include meaningful alternatives.');
  addPassWhenClear('RESEARCH_COVERAGE', 'Required external facts are cited and resolved.');
  addPassWhenClear('SECURITY', 'Security controls and verification are defined.');
  addPassWhenClear('RELIABILITY', 'Failure behavior and recovery are defined.');
  addPassWhenClear('ACCEPTANCE_COVERAGE', 'Every requirement maps to acceptance evidence.');
  addPassWhenClear('OPEN_RISKS', 'No unresolved contradiction or material risk was detected.');

  const hasFailureBeforeReadiness = findings.some((finding) => finding.severity === 'FAIL');
  if (hasFailureBeforeReadiness) {
    add(
      'IMPLEMENTATION_READINESS',
      'FAIL',
      'The Spec Pack is not implementation-ready until all failing findings are resolved.',
    );
  } else {
    add(
      'IMPLEMENTATION_READINESS',
      'PASS',
      'The design is complete enough for an independent coding agent to implement.',
    );
  }
  return {
    schemaVersion: 'specbridge.quality.v2',
    sessionId: session.id,
    designDigest: sha256(
      JSON.stringify({
        baselineCommit: session.baselineCommit,
        currentSnapshotCommit: snapshot.identity.commit,
        baselineFingerprint: session.baselineFingerprint,
        currentSnapshotFingerprint: snapshot.identity.contentFingerprint,
        stages: session.stages,
        decisions: session.decisions,
        research: session.research,
      }),
    ),
    evaluatedAt: now.toISOString(),
    ready: !findings.some((finding) => finding.severity === 'FAIL'),
    findings,
    uncoveredRequirementIds,
    orphanAcceptanceIds,
    blockingDecisionIds,
  };
}

export async function evaluateDesignWithProvider(
  session: DesignSession,
  snapshot: CurrentSystemSnapshot,
  provider: SpecEvaluationProvider,
  now: Date = new Date(),
): Promise<SpecQualityReport> {
  const deterministicReport = evaluateDesign(session, snapshot, now);
  const modelFindings = await provider.evaluate({
    session,
    snapshot,
    deterministicReport,
  });
  return evaluateDesign(session, snapshot, now, modelFindings);
}
