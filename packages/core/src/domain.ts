export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type EvidenceClass =
  | 'SEALED_PRODUCT_TRUTH'
  | 'DOCUMENTED_ARCHITECTURE'
  | 'OBSERVED_IMPLEMENTATION'
  | 'INFERRED_PATTERN'
  | 'ASSUMPTION';

export interface EvidenceReference {
  id: string;
  classification: EvidenceClass;
  path: string | null;
  detail: string;
  observedAt: string;
}

export type ProjectType = 'GREENFIELD' | 'BROWNFIELD' | 'PARTIAL';

export interface RepositoryIdentity {
  root: string;
  name: string;
  commit: string | null;
  contentFingerprint: string;
  dirty: boolean | null;
  capturedAt: string;
}

export interface CurrentSystemSnapshot {
  schemaVersion: 'specbridge.snapshot.v2';
  identity: RepositoryIdentity;
  projectType: ProjectType;
  languages: Record<string, number>;
  frameworks: string[];
  modules: string[];
  services: string[];
  publicApis: string[];
  domainModels: string[];
  storage: string[];
  messaging: string[];
  authentication: string[];
  authorization: string[];
  frontend: string[];
  deployment: string[];
  tests: string[];
  integrations: string[];
  configuration: string[];
  architecturalPatterns: string[];
  importantConstraints: string[];
  knownProductBehavior: string[];
  technicalDebt: string[];
  uncertainties: string[];
  evidence: EvidenceReference[];
  indexedFiles: number;
  truncated: boolean;
}

export type DesignSessionStatus =
  | 'DRAFT'
  | 'DISCOVERING'
  | 'NEEDS_INPUT'
  | 'RESEARCHING'
  | 'DESIGNING'
  | 'READY_FOR_REVIEW'
  | 'APPROVED'
  | 'SUPERSEDED';

export const DESIGN_STAGES = [
  'problem-framing',
  'functional-requirements',
  'non-functional-requirements',
  'scale-capacity',
  'architecture',
  'critical-deep-dives',
  'alternatives',
  'data-design',
  'api-events',
  'reliability',
  'security',
  'observability',
  'deployment-migration',
  'testing-acceptance',
] as const;

export type DesignStage = (typeof DESIGN_STAGES)[number];

export type DecisionAuthority = 'HUMAN' | 'ENGINEERING' | 'RESEARCH' | 'REPOSITORY';
export type DecisionStatus = 'OPEN' | 'DECIDED';

export interface ProductDecision {
  id: string;
  question: string;
  whyItMatters: string;
  options: string[];
  recommendation: string | null;
  authority: DecisionAuthority;
  blocking: boolean;
  status: DecisionStatus;
  answer: string | null;
  source: 'USER' | 'REPOSITORY' | 'RESEARCH' | 'ENGINEERING_DECISION' | 'ASSUMPTION';
}

export type ResearchFindingKind = 'FACT' | 'CONSTRAINT' | 'OPTION' | 'RECOMMENDATION';

export interface SourceReference {
  id: string;
  title: string;
  url: string;
  publisher: string | null;
  accessedAt: string;
  relevantVersion: string | null;
}

export interface ResearchFinding {
  id: string;
  kind: ResearchFindingKind;
  statement: string;
  sourceIds: string[];
}

export interface ResearchReport {
  id: string;
  normalizedQuestion: string;
  question: string;
  scope: string;
  researchedAt: string;
  freshnessUntil: string | null;
  findings: ResearchFinding[];
  sources: SourceReference[];
  contradictions: string[];
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  engineeringImplications: string[];
  productImplications: string[];
  unresolved: string[];
}

export interface DesignSession {
  schemaVersion: 'specbridge.design-session.v2';
  id: string;
  slug: string;
  title: string;
  roughIdea: string;
  status: DesignSessionStatus;
  createdAt: string;
  updatedAt: string;
  baselineCommit: string | null;
  baselineFingerprint: string;
  snapshotPath: string;
  currentStage: DesignStage;
  stages: Partial<Record<DesignStage, JsonObject>>;
  decisions: ProductDecision[];
  research: ResearchReport[];
  approval: {
    text: string;
    approvedAt: string;
    approvedBy: string;
  } | null;
  revision: number;
}

export type RequirementSource =
  | 'USER'
  | 'REPOSITORY'
  | 'RESEARCH'
  | 'DERIVED'
  | 'ENGINEERING_DECISION'
  | 'ASSUMPTION';

export interface FunctionalRequirement {
  id: string;
  title: string;
  description: string;
  actor: string | null;
  preconditions: string[];
  behavior: string;
  failureBehavior: string;
  priority: 'MUST' | 'SHOULD' | 'COULD';
  source: RequirementSource;
  sourceRefs: string[];
}

export interface NonFunctionalRequirement {
  id: string;
  category: string;
  requirement: string;
  target: string | null;
  source: RequirementSource;
  sourceRefs: string[];
}

export interface AcceptanceCriterion {
  id: string;
  requirementIds: string[];
  given: string;
  when: string;
  then: string;
  requiredEvidence: string;
}

export interface EvaluationFinding {
  id: string;
  dimension:
    | 'COMPLETENESS'
    | 'GROUNDING'
    | 'PRODUCT_CLARITY'
    | 'ARCHITECTURE_COHERENCE'
    | 'TRADE_OFF_QUALITY'
    | 'RESEARCH_COVERAGE'
    | 'SECURITY'
    | 'RELIABILITY'
    | 'IMPLEMENTATION_READINESS'
    | 'ACCEPTANCE_COVERAGE'
    | 'OPEN_RISKS';
  severity: 'PASS' | 'WARN' | 'FAIL';
  message: string;
  references: string[];
}

export interface SpecQualityReport {
  schemaVersion: 'specbridge.quality.v2';
  sessionId: string;
  designDigest: string;
  evaluatedAt: string;
  ready: boolean;
  findings: EvaluationFinding[];
  uncoveredRequirementIds: string[];
  orphanAcceptanceIds: string[];
  blockingDecisionIds: string[];
}

export interface SpecPackManifest {
  schemaVersion: 'specbridge.spec.v2';
  name: string;
  revision: number;
  status: 'approved';
  baseline: {
    repository: string;
    commit: string | null;
    contentFingerprint: string;
  };
  documents: Record<string, string>;
  goals: string[];
  nonGoals: string[];
  openBlockingDecisions: string[];
  approvedAt: string;
  sourceSessionId: string;
  changes: {
    previousRevision: number | null;
    summary: string[];
    changedProductDecisionIds: string[];
    changedRequirementIds: string[];
    changedAcceptanceCriterionIds: string[];
  };
  entityHashes: {
    productDecisions: Record<string, string>;
    requirements: Record<string, string>;
    acceptanceCriteria: Record<string, string>;
  };
}
