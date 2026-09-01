import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DesignStage, ResearchReport } from '@specbridge/core';
import { DESIGN_STAGES } from '@specbridge/core';
import { DesignService } from '@specbridge/design';

export interface GoldenScenario {
  title: string;
  idea: string;
  architecture: string;
  needsResearch: boolean;
}

export const GOLDEN_SCENARIOS: GoldenScenario[] = [
  {
    title: 'greenfield-web-service',
    idea: 'Design a small account preferences web service.',
    architecture: 'modular service',
    needsResearch: false,
  },
  {
    title: 'brownfield-saas-expansion',
    idea: 'Turn an existing single-tenant application into a multi-tenant SaaS.',
    architecture: 'modular monolith with tenant boundaries',
    needsResearch: false,
  },
  {
    title: 'event-driven-orders',
    idea: 'Design reliable order events and downstream fulfillment.',
    architecture: 'transactional outbox and event consumers',
    needsResearch: false,
  },
  {
    title: 'ai-rag-application',
    idea: 'Design a tenant-isolated RAG assistant with cited answers.',
    architecture: 'retrieval gateway and policy-enforced model tools',
    needsResearch: true,
  },
  {
    title: 'monolith-incremental-migration',
    idea: 'Incrementally replace a legacy monolith without a big-bang cutover.',
    architecture: 'strangler boundary with compatibility adapters',
    needsResearch: false,
  },
  {
    title: 'synthetic-yoga-support-saas',
    idea:
      'Turn a synthetic support bot into a production multi-tenant SaaS with WhatsApp, WeChat, tenant portals, operator administration, analytics, and production deployment.',
    architecture: 'channel adapters around a tenant-isolated conversation core',
    needsResearch: true,
  },
];

export function createSyntheticRepository(
  name: string,
  options: { greenfield?: boolean } = {},
): string {
  const root = mkdtempSync(path.join(tmpdir(), 'specbridge-v2-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name,
        version: '0.0.0',
        description: 'Synthetic brownfield fixture for SpecBridge 2.0.',
        type: 'module',
        scripts: { test: 'vitest run' },
        dependencies: { express: '^5.0.0' },
        devDependencies: { typescript: '^5.6.0', vitest: '^3.0.0' },
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    path.join(root, 'README.md'),
    '# Synthetic support service\n\nExisting single-tenant customer support behavior.\n',
  );
  if (options.greenfield === true) return root;
  for (let index = 1; index <= 6; index += 1) {
    writeFileSync(
      path.join(root, 'src', 'module-' + index + '.ts'),
      'export interface Entity' +
        index +
        ' { id: string; tenantId: string }\nexport const module' +
        index +
        ' = true;\n',
    );
  }
  writeFileSync(
    path.join(root, 'src', 'index.ts'),
    "export * from './module-1.js';\nexport function publicApi(): string { return 'ok'; }\n",
  );
  writeFileSync(
    path.join(root, 'tests', 'service.test.ts'),
    "import { describe, it } from 'vitest';\ndescribe('service', () => { it('works', () => {}); });\n",
  );
  return root;
}

export function stageOutput(stage: DesignStage, scenario: GoldenScenario): unknown {
  const yoga = scenario.title === 'synthetic-yoga-support-saas';
  switch (stage) {
    case 'problem-framing':
      return {
        problemStatement: scenario.idea,
        businessContext: 'The product needs an implementation-ready design grounded in the existing repository.',
        actors: ['Product owner', 'Tenant administrator', 'Platform operator'],
        goals: [
          'Produce a coherent repository-grounded architecture.',
          'Make all product behavior and evidence traceable.',
          ...(yoga
            ? [
                'Isolate every studio organization while supporting multiple locations.',
                'Support reliable WhatsApp and WeChat conversations, tenant administration, platform operations, analytics, and human escalation.',
              ]
            : []),
        ],
        nonGoals: [
          'SpecBridge will not implement the designed product.',
          'SpecBridge will not schedule or supervise coding agents.',
          ...(yoga ? ['Subscription billing is outside the first release.'] : []),
        ],
        successCriteria: [
          'Every requirement maps to acceptance evidence.',
          'An independent coding agent can implement the Spec Pack.',
        ],
        knownConstraints: ['Preserve existing user-visible behavior during migration.'],
        assumptions: ['Initial scale assumptions remain subject to production measurement.'],
        openQuestions: yoga
          ? [
              {
                id: 'DEC-001',
                question: 'Does one tenant represent one studio or an organization with multiple locations?',
                whyItMatters: 'The answer changes identity, authorization, and data ownership boundaries.',
                options: ['one studio', 'multiple locations'],
                recommendation: 'multiple locations',
                blocking: true,
                repositoryCanAnswer: false,
                stableTechnicalFact: false,
                engineeringChoice: false,
                externalCurrentFact: false,
                definesProductBehavior: true,
              },
              {
                id: 'DEC-002',
                question: 'Can platform administrators read tenant conversations?',
                whyItMatters: 'The answer defines the cross-tenant privacy contract.',
                options: ['yes', 'no'],
                recommendation: 'no',
                blocking: true,
                repositoryCanAnswer: false,
                stableTechnicalFact: false,
                engineeringChoice: false,
                externalCurrentFact: false,
                definesProductBehavior: true,
              },
              {
                id: 'DEC-003',
                question: 'Is human escalation part of the first release?',
                whyItMatters: 'Escalation adds ownership, notification, and operational workflows.',
                options: ['yes', 'no'],
                recommendation: 'yes',
                blocking: true,
                repositoryCanAnswer: false,
                stableTechnicalFact: false,
                engineeringChoice: false,
                externalCurrentFact: false,
                definesProductBehavior: true,
              },
              {
                id: 'DEC-004',
                question: 'What current WhatsApp and WeChat platform constraints affect ingestion and outbound delivery?',
                whyItMatters: 'Channel API and policy constraints are current external facts.',
                options: [],
                recommendation: null,
                blocking: true,
                repositoryCanAnswer: false,
                stableTechnicalFact: false,
                engineeringChoice: false,
                externalCurrentFact: true,
                definesProductBehavior: false,
              },
            ]
          : [],
      };
    case 'functional-requirements':
      return {
        requirements: [
          {
            id: 'FR-001',
            title: 'Repository-grounded design',
            description: 'The design uses evidence from the current system snapshot.',
            actor: 'Product owner',
            preconditions: ['Repository bootstrap completed.'],
            behavior: 'Each material current-system claim identifies repository evidence.',
            failureBehavior: 'Uncertain claims remain labeled as assumptions or open risks.',
            priority: 'MUST',
            source: 'USER',
            sourceRefs: ['source-idea'],
          },
          {
            id: 'FR-002',
            title: 'Portable implementation handoff',
            description: 'The approved design is compiled into a Markdown-first Spec Pack.',
            actor: 'Implementing engineer',
            preconditions: ['The design passes evaluation.'],
            behavior: 'All architecture and acceptance documents remain readable without SpecBridge.',
            failureBehavior: 'Compilation fails if required design stages are missing.',
            priority: 'MUST',
            source: 'USER',
            sourceRefs: ['source-idea'],
          },
          ...(yoga
            ? [
                {
                  id: 'FR-003',
                  title: 'Organization and location tenancy',
                  description: 'Each tenant organization manages one or more studio locations.',
                  actor: 'Tenant administrator',
                  preconditions: ['The tenant is provisioned.'],
                  behavior: 'Authorize users and resources within an immutable organization and location context.',
                  failureBehavior: 'Deny requests with missing or mismatched tenant context.',
                  priority: 'MUST' as const,
                  source: 'USER' as const,
                  sourceRefs: ['DEC-001'],
                },
                {
                  id: 'FR-004',
                  title: 'WhatsApp and WeChat messaging',
                  description: 'Receive and send messages through independently configured channel adapters.',
                  actor: 'Customer',
                  preconditions: ['A tenant channel connection is active.'],
                  behavior: 'Normalize inbound messages into tenant-scoped conversations and track outbound delivery.',
                  failureBehavior: 'Retry transient failures idempotently and surface permanent failures to operators.',
                  priority: 'MUST' as const,
                  source: 'RESEARCH' as const,
                  sourceRefs: ['DEC-004', 'RR-001'],
                },
                {
                  id: 'FR-005',
                  title: 'Tenant management portal',
                  description: 'Tenant administrators manage locations, staff, channels, and conversations.',
                  actor: 'Tenant administrator',
                  preconditions: ['The administrator belongs to the tenant.'],
                  behavior: 'Expose only resources authorized within the administrator tenant.',
                  failureBehavior: 'Reject cross-tenant and insufficient-role access.',
                  priority: 'MUST' as const,
                  source: 'USER' as const,
                  sourceRefs: ['source-idea'],
                },
                {
                  id: 'FR-006',
                  title: 'Platform operations portal',
                  description: 'Platform operators manage tenant lifecycle and service health without reading conversation content.',
                  actor: 'Platform operator',
                  preconditions: ['The operator has a platform role.'],
                  behavior: 'Expose tenant metadata, configuration health, and aggregate operational signals.',
                  failureBehavior: 'Redact conversation content and audit every privileged operation.',
                  priority: 'MUST' as const,
                  source: 'USER' as const,
                  sourceRefs: ['DEC-002'],
                },
                {
                  id: 'FR-007',
                  title: 'Tenant and platform analytics',
                  description: 'Provide tenant-scoped analytics and privacy-preserving platform aggregates.',
                  actor: 'Authorized administrator',
                  preconditions: ['Analytics projections are current within the documented lag.'],
                  behavior: 'Filter tenant views by tenant and restrict platform views to approved aggregates.',
                  failureBehavior: 'Show freshness state and never fall back to unrestricted raw conversation queries.',
                  priority: 'SHOULD' as const,
                  source: 'USER' as const,
                  sourceRefs: ['source-idea', 'DEC-002'],
                },
                {
                  id: 'FR-008',
                  title: 'Human escalation',
                  description: 'Escalate an AI conversation to an authorized human queue with ownership history.',
                  actor: 'Support agent',
                  preconditions: ['The tenant enables escalation.'],
                  behavior: 'Assign the conversation once and notify eligible tenant staff.',
                  failureBehavior: 'Keep the conversation safely queued and alert when assignment delivery fails.',
                  priority: 'MUST' as const,
                  source: 'USER' as const,
                  sourceRefs: ['DEC-003'],
                },
              ]
            : []),
        ],
      };
    case 'non-functional-requirements':
      return {
        requirements: [
          {
            id: 'NFR-001',
            category: 'Security',
            requirement: 'Tenant and credential boundaries are explicit and verifiable.',
            target: null,
            source: 'DERIVED',
            sourceRefs: ['FR-001'],
          },
          ...(yoga
            ? [
                {
                  id: 'NFR-002',
                  category: 'Tenant isolation',
                  requirement: 'Every authorization, query, event, cache key, and analytics projection carries tenant scope.',
                  target: 'No cross-tenant record is returned in automated two-tenant negative tests.',
                  source: 'DERIVED' as const,
                  sourceRefs: ['FR-003', 'FR-005'],
                },
                {
                  id: 'NFR-003',
                  category: 'Privacy',
                  requirement: 'Platform operations exclude tenant conversation content and minimize customer identifiers.',
                  target: null,
                  source: 'USER' as const,
                  sourceRefs: ['DEC-002'],
                },
                {
                  id: 'NFR-004',
                  category: 'Reliability',
                  requirement: 'Channel delivery tolerates duplicates, reordering, transient provider failures, and poison messages.',
                  target: 'Targets are set from measured provider baselines before production launch.',
                  source: 'DERIVED' as const,
                  sourceRefs: ['FR-004', 'RR-001'],
                },
                {
                  id: 'NFR-005',
                  category: 'Auditability',
                  requirement: 'Privileged configuration, impersonation attempts, and conversation access decisions are auditable.',
                  target: null,
                  source: 'DERIVED' as const,
                  sourceRefs: ['FR-006'],
                },
                {
                  id: 'NFR-006',
                  category: 'Observability',
                  requirement: 'Operators can detect channel failure, queue lag, isolation anomalies, and analytics staleness.',
                  target: null,
                  source: 'DERIVED' as const,
                  sourceRefs: ['FR-004', 'FR-007'],
                },
              ]
            : []),
        ],
      };
    case 'scale-capacity':
      return {
        applicable: true,
        assumptions: [
          { statement: 'Assumption: 1,000 tenants at initial maturity.', source: 'ASSUMPTION' },
          { statement: 'Assumption: peak traffic is ten times average traffic.', source: 'ASSUMPTION' },
        ],
        estimates: [
          {
            metric: 'Peak requests',
            value: 'Derived during implementation sizing',
            method: 'Validate measured baseline before selecting capacity.',
          },
        ],
      };
    case 'architecture':
      return {
        summary: 'Use a ' + scenario.architecture + ' and keep product authority outside implementation mechanics.',
        mermaid: yoga
          ? 'flowchart LR\n  WhatsApp --> Channels\n  WeChat --> Channels\n  Channels --> Conversations\n  TenantPortal --> Conversations\n  OperatorPortal --> Operations\n  Conversations --> Store\n  Conversations --> Analytics'
          : 'flowchart LR\n  User --> API\n  API --> Core\n  Core --> Store',
        components: [
          {
            name: 'API boundary',
            responsibility: 'Authenticate requests and enforce product contracts.',
            requirementIds: ['FR-001', 'NFR-001'],
            ownedData: [],
            inboundInterfaces: ['HTTPS'],
            outboundInterfaces: ['Core commands'],
            dependencies: ['Identity provider'],
            failureModes: ['Dependency timeout', 'Duplicate request'],
            scalingModel: 'Stateless horizontal scaling.',
            securityBoundary: 'Reject unauthorized tenant access before core invocation.',
          },
          {
            name: 'Domain core',
            responsibility: 'Own product invariants and tenant-scoped state transitions.',
            requirementIds: ['FR-001', 'FR-002', 'NFR-001'],
            ownedData: ['Tenant-scoped records'],
            inboundInterfaces: ['Validated commands'],
            outboundInterfaces: ['Transactional persistence', 'Domain events'],
            dependencies: ['Primary store'],
            failureModes: ['Transaction conflict', 'Store outage'],
            scalingModel: 'Partition by tenant when measurements justify it.',
            securityBoundary: 'Every operation requires explicit tenant context.',
          },
          ...(yoga
            ? [
                {
                  name: 'Channel gateway',
                  responsibility: 'Verify, normalize, deduplicate, and deliver WhatsApp and WeChat messages.',
                  requirementIds: ['FR-004', 'NFR-004'],
                  ownedData: ['Provider delivery state', 'Webhook deduplication keys'],
                  inboundInterfaces: ['Provider webhooks'],
                  outboundInterfaces: ['Conversation commands', 'Provider outbound APIs'],
                  dependencies: ['WhatsApp API', 'WeChat API', 'Secret store'],
                  failureModes: ['Provider outage', 'Duplicate webhook', 'Out-of-order status'],
                  scalingModel: 'Partition message work by tenant and conversation.',
                  securityBoundary: 'Resolve channel credentials by tenant and never expose secret values.',
                },
                {
                  name: 'Tenant portal',
                  responsibility: 'Manage tenant locations, staff, channels, conversations, and escalation queues.',
                  requirementIds: ['FR-003', 'FR-005', 'FR-008', 'NFR-002'],
                  ownedData: [],
                  inboundInterfaces: ['Tenant administrator HTTPS'],
                  outboundInterfaces: ['Tenant-scoped application APIs'],
                  dependencies: ['Identity provider', 'Domain core'],
                  failureModes: ['Stale authorization', 'Partial configuration update'],
                  scalingModel: 'Stateless frontend and API sessions.',
                  securityBoundary: 'Tenant and location scope is derived from verified membership, never client input alone.',
                },
                {
                  name: 'Operations and analytics',
                  responsibility: 'Expose platform health and privacy-preserving aggregates without conversation content.',
                  requirementIds: ['FR-006', 'FR-007', 'NFR-003', 'NFR-005', 'NFR-006'],
                  ownedData: ['Tenant-safe analytics projections', 'Operational audit records'],
                  inboundInterfaces: ['Platform operator HTTPS', 'Domain events'],
                  outboundInterfaces: ['Dashboards', 'Alerts'],
                  dependencies: ['Analytics store', 'Audit store'],
                  failureModes: ['Projection lag', 'Accidental high-cardinality query'],
                  scalingModel: 'Scale projections independently from transactional traffic.',
                  securityBoundary: 'Platform roles can read tenant metadata and aggregates, not message bodies.',
                },
              ]
            : []),
        ],
      };
    case 'critical-deep-dives':
      return {
        topics: [
          {
            name: 'Tenant isolation',
            risk: 'A missing scope predicate could expose another tenant data.',
            design: 'Carry immutable tenant context through authorization, domain, and storage boundaries.',
            ...(yoga
              ? {
                  sequenceDiagram:
                    'sequenceDiagram\n  participant Admin\n  participant API\n  participant Policy\n  participant Store\n  Admin->>API: list conversations\n  API->>Policy: authorize tenant + location\n  Policy-->>API: scoped grant\n  API->>Store: query with tenantId\n  Store-->>API: tenant-only rows',
                }
              : {}),
            failureHandling: ['Deny requests with missing tenant context.', 'Audit rejected cross-tenant attempts.'],
            tradeOffs: ['Shared infrastructure is simpler but requires systematic isolation tests.'],
          },
          ...(yoga
            ? [
                {
                  name: 'Channel delivery and identity',
                  risk: 'Duplicate or reordered provider events can create duplicate replies or merge the wrong customer.',
                  design: 'Use provider-scoped external identities, immutable tenant channel connections, idempotent inbox/outbox records, and explicit cross-channel merge decisions.',
                  sequenceDiagram:
                    'sequenceDiagram\n  participant Provider\n  participant Gateway\n  participant Inbox\n  participant Core\n  Provider->>Gateway: signed webhook\n  Gateway->>Inbox: insert dedup key\n  Inbox->>Core: normalized tenant message\n  Core-->>Provider: outbound request via outbox',
                  failureHandling: ['Reject invalid signatures.', 'Deduplicate webhook IDs.', 'Quarantine poison payloads.', 'Reconcile delivery status asynchronously.'],
                  tradeOffs: ['Separate adapters add boundaries but keep changing provider contracts out of the conversation core.'],
                },
              ]
            : []),
        ],
      };
    case 'alternatives':
      return {
        decisions: [
          {
            id: 'ADR-001',
            decision: 'Keep the initial architecture modular and independently testable.',
            context: 'Expected load does not justify distributed operational complexity.',
            alternatives: [
              {
                name: 'Modular monolith',
                pros: ['Simple operations', 'Transactional consistency'],
                cons: ['Requires disciplined module boundaries'],
              },
              {
                name: 'Microservices',
                pros: ['Independent scaling'],
                cons: ['Distributed failure modes', 'Higher operational cost'],
              },
            ],
            rationale: 'The simpler option satisfies current scale assumptions.',
            consequences: ['Module contracts must be enforced in tests.'],
            revisitTrigger: 'A measured scaling or ownership bottleneck cannot be solved within the module boundary.',
          },
          ...(yoga
            ? [
                {
                  id: 'ADR-002',
                  decision: 'Use channel adapters around one tenant-isolated conversation core.',
                  context: 'WhatsApp and WeChat differ in authentication, webhook, template, and delivery contracts.',
                  alternatives: [
                    {
                      name: 'Adapter boundary',
                      pros: ['Contains provider change', 'Shared product semantics'],
                      cons: ['Requires a normalized message contract'],
                    },
                    {
                      name: 'Provider logic in the core',
                      pros: ['Fewer initial modules'],
                      cons: ['Couples product state to external API churn', 'Harder channel testing'],
                    },
                  ],
                  rationale: 'Provider-neutral domain contracts preserve product invariants while allowing channel-specific compliance.',
                  consequences: ['Adapters must retain provider payload references for audit and diagnosis.'],
                  revisitTrigger: 'A provider exposes behavior that cannot be represented without corrupting core conversation semantics.',
                },
              ]
            : []),
        ],
      };
    case 'data-design':
      return {
        applicable: true,
        mermaid: yoga
          ? 'erDiagram\n  TENANT ||--o{ LOCATION : owns\n  TENANT ||--o{ CHANNEL_CONNECTION : configures\n  TENANT ||--o{ CONVERSATION : owns\n  CONVERSATION ||--o{ MESSAGE : contains\n  CONVERSATION ||--o| ESCALATION : escalates'
          : 'erDiagram\n  TENANT ||--o{ RECORD : owns',
        entities: [
          {
            name: 'TenantRecord',
            meaning: 'A tenant-owned product record.',
            ownership: 'Domain core',
            tenantBoundary: 'tenantId is mandatory and immutable.',
            importantFields: ['id', 'tenantId', 'version'],
            relationships: ['Belongs to exactly one tenant.'],
            indexes: ['tenantId + id'],
            lifecycle: 'Created, updated with optimistic versioning, then retained or deleted by policy.',
            retention: 'Configured product policy.',
            consistency: 'Strong within one record transition.',
          },
          ...(yoga
            ? [
                {
                  name: 'Tenant',
                  meaning: 'A studio organization that owns one or more locations.',
                  ownership: 'Tenant domain',
                  tenantBoundary: 'The tenant ID is the root isolation key.',
                  importantFields: ['id', 'name', 'status', 'version'],
                  relationships: ['Owns locations, memberships, channel connections, and conversations.'],
                  indexes: ['status + id'],
                  lifecycle: 'Provisioned, activated, suspended, then deleted through an audited retention workflow.',
                  retention: 'Tenant metadata follows the approved account-retention policy.',
                  consistency: 'Strong for lifecycle transitions.',
                },
                {
                  name: 'ChannelConnection',
                  meaning: 'Tenant-scoped WhatsApp or WeChat configuration and external account binding.',
                  ownership: 'Channel gateway',
                  tenantBoundary: 'Unique within tenant and provider account; credentials remain secret references.',
                  importantFields: ['id', 'tenantId', 'provider', 'externalAccountId', 'secretReference', 'status'],
                  relationships: ['Routes provider identities to tenant conversations.'],
                  indexes: ['provider + externalAccountId', 'tenantId + status'],
                  lifecycle: 'Configured, verified, activated, rotated, disabled, then deleted.',
                  retention: 'Configuration audit remains after credential revocation according to policy.',
                  consistency: 'Strong for routing and credential rotation.',
                },
                {
                  name: 'Conversation',
                  meaning: 'A tenant-owned support interaction for one provider-scoped customer identity.',
                  ownership: 'Conversation core',
                  tenantBoundary: 'Every lookup includes tenantId; cross-channel identity merge requires an approved product rule.',
                  importantFields: ['id', 'tenantId', 'locationId', 'customerIdentityId', 'state', 'ownerId', 'version'],
                  relationships: ['Contains messages and optionally one active escalation.'],
                  indexes: ['tenantId + updatedAt', 'tenantId + state + ownerId'],
                  lifecycle: 'Opened, served by AI or human, resolved, and retained or deleted by policy.',
                  retention: 'Conversation and PII retention remains an explicit product policy.',
                  consistency: 'Strong for ownership transitions; ordered events per conversation.',
                },
              ]
            : []),
        ],
      };
    case 'api-events':
      return {
        apis: [
          {
            operation: 'POST /v1/records',
            purpose: 'Create a tenant-scoped record.',
            authentication: 'OIDC access token.',
            authorization: 'Tenant role permits record creation.',
            request: '{ idempotencyKey, payload }',
            response: '201 with record representation.',
            errors: ['400 invalid input', '403 unauthorized', '409 idempotency conflict'],
            idempotency: 'Persist the tenant-scoped idempotency key and response.',
            pagination: null,
          },
          ...(yoga
            ? [
                {
                  operation: 'POST /webhooks/channels/{provider}',
                  purpose: 'Accept signed WhatsApp or WeChat provider events.',
                  authentication: 'Provider signature and tenant channel lookup.',
                  authorization: 'The external account must map to one active tenant connection.',
                  request: '{ providerEventId, externalAccountId, sender, message, occurredAt }',
                  response: '202 after durable deduplication.',
                  errors: ['400 malformed event', '401 invalid signature', '404 unknown connection'],
                  idempotency: 'Deduplicate provider + external account + provider event ID.',
                  pagination: null,
                },
                {
                  operation: 'GET /v1/tenants/{tenantId}/conversations',
                  purpose: 'List tenant conversations for an authorized location scope.',
                  authentication: 'OIDC access token.',
                  authorization: 'Tenant membership and location-scoped conversation permission.',
                  request: '{ cursor?, locationId?, state? }',
                  response: '{ items, nextCursor } without cross-tenant rows.',
                  errors: ['403 tenant mismatch', '400 invalid cursor'],
                  idempotency: 'Read-only.',
                  pagination: 'Opaque stable cursor ordered by updatedAt and id.',
                },
                {
                  operation: 'POST /v1/conversations/{id}/escalations',
                  purpose: 'Transfer one tenant conversation to the human escalation queue.',
                  authentication: 'OIDC access token or authorized AI policy principal.',
                  authorization: 'Tenant escalation permission for the conversation location.',
                  request: '{ reason, idempotencyKey }',
                  response: '202 with escalation state.',
                  errors: ['403 unauthorized', '404 conversation', '409 already escalated'],
                  idempotency: 'Tenant + conversation + idempotency key returns the original result.',
                  pagination: null,
                },
              ]
            : []),
        ],
        events: [
          {
            name: 'RecordCreated',
            producer: 'Domain core',
            consumers: ['Analytics projection'],
            schema: '{ eventId, tenantId, recordId, occurredAt }',
            ordering: 'Ordered per record.',
            delivery: 'At least once.',
            idempotency: 'Consumers deduplicate eventId.',
            retry: 'Bounded exponential backoff.',
            poisonHandling: 'Quarantine with alert and replay tooling.',
          },
          ...(yoga
            ? [
                {
                  name: 'MessageReceived',
                  producer: 'Channel gateway',
                  consumers: ['Conversation core', 'Audit projection'],
                  schema: '{ eventId, tenantId, channelConnectionId, conversationId, providerMessageId, occurredAt }',
                  ordering: 'Partition and order per conversation.',
                  delivery: 'At least once.',
                  idempotency: 'Consumers deduplicate eventId and providerMessageId within tenant.',
                  retry: 'Bounded exponential backoff with provider-aware limits.',
                  poisonHandling: 'Quarantine redacted metadata, alert, and require audited replay.',
                },
                {
                  name: 'ConversationEscalated',
                  producer: 'Conversation core',
                  consumers: ['Tenant notification', 'Analytics projection'],
                  schema: '{ eventId, tenantId, conversationId, escalationId, reasonCode, occurredAt }',
                  ordering: 'Ordered per conversation.',
                  delivery: 'At least once.',
                  idempotency: 'One active escalation version per conversation.',
                  retry: 'Retry notifications independently from the committed escalation.',
                  poisonHandling: 'Keep escalation queued and alert tenant operations.',
                },
              ]
            : []),
        ],
      };
    case 'reliability':
      return {
        failureScenarios: [
          {
            scenario: 'Primary store timeout',
            expectedBehavior: 'Return a retryable error without acknowledging uncommitted work.',
            detection: 'Latency and timeout metrics trigger an alert.',
            recovery: 'Retry only idempotent operations with bounded backoff.',
          },
          {
            scenario: 'Duplicate event',
            expectedBehavior: 'The consumer produces no duplicate side effect.',
            detection: 'Deduplication counters are observable.',
            recovery: 'Record the duplicate and continue processing.',
          },
          ...(yoga
            ? [
                {
                  scenario: 'WhatsApp or WeChat provider outage',
                  expectedBehavior: 'Keep accepted outbound work durable, expose delayed status, and avoid duplicate replies.',
                  detection: 'Provider error, queue age, and delivery-state metrics trigger channel-specific alerts.',
                  recovery: 'Circuit-break the provider, retry within current policy, and reconcile ambiguous delivery before resending.',
                },
                {
                  scenario: 'Messages arrive out of order',
                  expectedBehavior: 'Preserve provider timestamps and process state transitions by conversation sequence rules.',
                  detection: 'Late-event and sequence-gap metrics identify affected conversations.',
                  recovery: 'Reconcile state idempotently without overwriting a newer conversation owner or response.',
                },
              ]
            : []),
        ],
      };
    case 'security':
      return {
        controls: [
          {
            area: 'Tenant isolation',
            threat: 'Cross-tenant data access',
            control: 'Authorize immutable tenant context and enforce tenant-scoped queries.',
            verification: 'Automated negative integration tests across two tenants.',
          },
          {
            area: 'Secrets',
            threat: 'Credential disclosure',
            control: 'Store provider credentials in a managed secret store and never log values.',
            verification: 'Secret scanning and log assertions.',
          },
          ...(yoga
            ? [
                {
                  area: 'Platform operator privacy',
                  threat: 'A platform role reads tenant conversation bodies.',
                  control: 'Separate platform metadata APIs and aggregate projections from conversation-content stores.',
                  verification: 'Contract and authorization tests prove operator tokens cannot call content endpoints.',
                },
                {
                  area: 'Channel credentials',
                  threat: 'One tenant channel secret is exposed or used for another tenant.',
                  control: 'Use tenant-bound secret references, least-privilege retrieval, rotation, redaction, and audited access.',
                  verification: 'Two-tenant credential isolation tests and rotation drills.',
                },
              ]
            : []),
        ],
        aiRisks: [
          {
            risk: 'Prompt injection through external content',
            boundary: 'Untrusted content never grants tool authority.',
            mitigation: 'Policy-check every tool call and keep retrieved content data-only.',
          },
        ],
      };
    case 'observability':
      return {
        technicalMetrics: [
          'Request rate, errors, and latency',
          'Store and provider saturation',
          ...(yoga ? ['Message delivery latency and failure by channel', 'Conversation queue age and projection lag'] : []),
        ],
        businessMetrics: [
          'Successful tenant operations',
          ...(yoga ? ['Conversations by channel', 'Escalation and resolution outcomes by tenant'] : []),
        ],
        logs: ['Structured request and decision logs without secrets'],
        traces: ['API through persistence and event publication'],
        auditEvents: ['Authorization denial', 'Credential change'],
        slos: ['Availability and latency objectives are set from measured baselines.'],
        alerts: ['SLO burn rate', 'Cross-tenant authorization anomaly'],
        dashboards: ['Service health', 'Tenant operations'],
        costMonitoring: ['Provider and storage cost by tenant'],
        workingSignals: ['Acceptance flows succeed and SLO budget remains healthy.'],
        failureSignals: ['Error budget burn or durable queue lag exceeds threshold.'],
      };
    case 'deployment-migration':
      return {
        runtimeTopology: yoga
          ? 'Stateless portals and APIs, tenant-isolated conversation core, channel workers, durable event delivery, managed primary and analytics stores.'
          : 'Stateless application instances with a managed primary store.',
        environments: ['development', 'staging', 'production'],
        configuration: ['Versioned non-secret configuration'],
        secrets: ['Managed environment-specific secret references'],
        deploymentModel: 'Progressive rollout with health gates.',
        migrationSequencing: ['Deploy compatible schema', 'Deploy application', 'Remove obsolete path after evidence.'],
        rollback: 'Roll back application while preserving backward-compatible schema.',
        backupRestore: 'Automated backups with tested point-in-time restore.',
        healthChecks: ['Startup dependency validation', 'Readiness', 'Liveness'],
        brownfield: {
          currentState: 'Existing single-tenant behavior in a brownfield repository.',
          targetState: yoga
            ? 'Tenant- and location-scoped conversation core with WhatsApp and WeChat adapters, tenant and operator portals, analytics, and escalation.'
            : 'Tenant-scoped modular architecture with portable contracts.',
          compatibilityConstraints: ['Preserve existing behavior during transition.'],
          stages: yoga
            ? [
                'Introduce tenant context and compatibility boundaries',
                'Backfill organizations and locations in restartable batches',
                'Route one channel and tenant cohort through adapters',
                'Enable portals, analytics, and escalation progressively',
                'Remove single-tenant paths after rollback evidence passes',
              ]
            : ['Introduce boundaries', 'Migrate reads and writes', 'Remove legacy behavior'],
          dataMigration: 'Use restartable, auditable batches.',
          rollback: 'Retain a reversible compatibility boundary until migration evidence passes.',
          legacyRemoval: ['Delete old code and tests after cutover evidence.'],
        },
      };
    case 'testing-acceptance':
      return {
        unit: ['Domain invariants and authority classification'],
        integration: ['Tenant-scoped persistence and idempotency'],
        contract: ['API and event schemas'],
        security: ['Authorization denial and secret redaction'],
        tenantIsolation: ['Two-tenant negative access tests'],
        migration: ['Restartable migration and rollback'],
        failure: ['Timeout, duplicate, and poison event handling'],
        load: ['Validate scale assumptions before production sizing'],
        endToEnd: ['Authenticated create and query flow'],
        acceptanceCriteria: [
          {
            id: 'AC-001',
            requirementIds: ['FR-001'],
            given: 'A repository snapshot exists.',
            when: 'The design is evaluated.',
            then: 'Material current-system claims reference repository evidence.',
            requiredEvidence: 'Automated grounding test.',
          },
          {
            id: 'AC-002',
            requirementIds: ['FR-002'],
            given: 'The design passes all readiness checks.',
            when: 'The human approves it in natural language.',
            then: 'A complete Markdown-first Spec Pack is written.',
            requiredEvidence: 'Spec Pack structure test.',
          },
          {
            id: 'AC-003',
            requirementIds: ['NFR-001'],
            given: 'Tenant A and Tenant B both contain records.',
            when: 'Tenant A requests records.',
            then: 'No Tenant B record is returned.',
            requiredEvidence: 'Automated two-tenant integration test.',
          },
          ...(yoga
            ? [
                {
                  id: 'AC-004',
                  requirementIds: ['FR-003', 'FR-005', 'NFR-002', 'NFR-003'],
                  given: 'Two tenant organizations with multiple locations and conversations exist.',
                  when: 'A tenant administrator queries and configures the portal.',
                  then: 'Only authorized organization and location resources are visible, and platform operators cannot read conversation bodies.',
                  requiredEvidence: 'Automated authorization matrix and two-tenant negative integration suite.',
                },
                {
                  id: 'AC-005',
                  requirementIds: ['FR-004', 'NFR-004'],
                  given: 'WhatsApp and WeChat connections are active and a provider sends duplicate or reordered events.',
                  when: 'The channel gateway processes and replies to the messages.',
                  then: 'Each product message has one durable effect and delivery state can be reconciled after provider failure.',
                  requiredEvidence: 'Provider contract tests plus duplicate, reorder, timeout, and outage fault tests.',
                },
                {
                  id: 'AC-006',
                  requirementIds: ['FR-006', 'NFR-005'],
                  given: 'A platform operator has a valid platform role.',
                  when: 'The operator manages tenant lifecycle or reviews service health.',
                  then: 'The operation is audited and no tenant conversation content is returned.',
                  requiredEvidence: 'Platform API authorization and audit integration tests.',
                },
                {
                  id: 'AC-007',
                  requirementIds: ['FR-007', 'NFR-006'],
                  given: 'Transactional events and analytics projections exist for multiple tenants.',
                  when: 'Tenant and platform dashboards are loaded.',
                  then: 'Tenant views are scoped, platform metrics are approved aggregates, and projection freshness is visible.',
                  requiredEvidence: 'Projection contract, isolation, and staleness tests.',
                },
                {
                  id: 'AC-008',
                  requirementIds: ['FR-008'],
                  given: 'A tenant enables human escalation for an active conversation.',
                  when: 'The AI or an authorized user escalates twice with the same key.',
                  then: 'One escalation is queued, ownership history is preserved, and eligible staff are notified.',
                  requiredEvidence: 'Idempotent escalation end-to-end test with notification failure injection.',
                },
              ]
            : []),
        ],
        implementationGuidance: {
          sequencing: ['Establish module boundaries before migrating data paths.'],
          dependencies: ['Repository baseline and approved external contracts'],
          migrationBoundaries: ['Keep each migration stage independently reversible.'],
          architecturalInvariants: ['Tenant context is explicit at every data boundary.'],
          parallelizationBoundaries: ['Docs, contract tests, and module internals can proceed independently.'],
          highRiskAreas: ['Tenant isolation', 'Migration rollback'],
        },
      };
  }
}

export function researchReport(question: string): ResearchReport {
  const normalized = question.trim().toLowerCase().replace(/\s+/g, ' ');
  const channelResearch = /whatsapp|wechat/i.test(question);
  return {
    id: 'RR-001',
    normalizedQuestion: normalized,
    question,
    scope: 'Current external platform constraints',
    researchedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    freshnessUntil: new Date('2027-01-01T00:00:00.000Z').toISOString(),
    findings: [
      {
        id: 'RF-001',
        kind: 'CONSTRAINT',
        statement: channelResearch
          ? 'WhatsApp and WeChat adapters must preserve their current provider-specific webhook, credential, outbound-delivery, and policy constraints behind a normalized product contract.'
          : 'The external integration must follow the provider current API contract.',
        sourceIds: ['SRC-001'],
      },
    ],
    sources: [
      {
        id: 'SRC-001',
        title: channelResearch
          ? 'Synthetic official WhatsApp and WeChat API documentation'
          : 'Synthetic provider official API documentation',
        url: 'https://example.test/official-api',
        publisher: 'Synthetic provider',
        accessedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
        relevantVersion: '2026-01',
      },
    ],
    contradictions: [],
    confidence: 'HIGH',
    engineeringImplications: [
      'Keep the provider behind a replaceable adapter.',
      ...(channelResearch
        ? ['Make webhook verification, idempotency, credential isolation, retries, and delivery reconciliation channel-specific.']
        : []),
    ],
    productImplications: channelResearch
      ? ['Provider-supported interaction modes and policy windows constrain channel-visible product behavior.']
      : [],
    unresolved: [],
  };
}

export function completeScenario(
  root: string,
  scenario: GoldenScenario,
): { service: DesignService; subject: string } {
  const service = new DesignService({
    rootDir: root,
    now: () => new Date('2026-01-02T00:00:00.000Z'),
    idFactory: () => scenario.title,
  });
  const session = service.start(scenario.title, scenario.idea);
  for (const stage of DESIGN_STAGES) {
    service.recordStage(session.id, stage, stageOutput(stage, scenario));
    if (stage === 'problem-framing') {
      const decisions = service.store.read(session.id).decisions;
      const answers: Record<string, string> = {
        'DEC-001': 'A tenant is a studio organization with multiple locations.',
        'DEC-002': 'No. Platform administrators cannot read tenant conversation content.',
        'DEC-003': 'Yes. Human escalation is part of the first release.',
      };
      for (const decision of decisions.filter((item) => item.authority === 'HUMAN')) {
        service.answer(
          session.id,
          decision.id,
          answers[decision.id] ?? decision.recommendation ?? 'Approved product behavior.',
        );
      }
      if (scenario.needsResearch) {
        const researchQuestion =
          decisions.find((item) => item.authority === 'RESEARCH')?.question ??
          'What current external platform constraints affect this design?';
        service.recordResearch(session.id, researchReport(researchQuestion));
      }
    }
  }
  return { service, subject: session.id };
}

export function readText(file: string): string {
  return readFileSync(file, 'utf8');
}
