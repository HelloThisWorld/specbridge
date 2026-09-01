import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  assertInsideWorkspace,
  sha256,
  SpecBridgeError,
  writeFileAtomic,
} from '@specbridge/core';
import type {
  CurrentSystemSnapshot,
  DesignSession,
  JsonValue,
  SpecPackManifest,
  SpecQualityReport,
} from '@specbridge/core';

const DOCUMENTS = {
  overview: '00-overview.md',
  goals: '01-goals-and-non-goals.md',
  requirements: '02-requirements.md',
  currentSystem: '03-current-system.md',
  research: '04-research.md',
  architecture: '05-system-design.md',
  dataModel: '06-data-model.md',
  interfaces: '07-api-and-events.md',
  security: '08-security.md',
  reliability: '09-reliability.md',
  observability: '10-observability.md',
  deployment: '11-deployment-and-rollout.md',
  testing: '12-testing.md',
  acceptance: '13-acceptance-criteria.md',
  openDecisions: '14-open-decisions.md',
  implementationGuidance: '15-implementation-guidance.md',
  quality: 'spec-quality.md',
  agentHandoff: 'AGENT_HANDOFF.md',
} as const;

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value
        .map(record)
        .filter((item) => Object.keys(item).length > 0)
    : [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function entityHashes(items: Array<Record<string, unknown>>): Record<string, string> {
  const entries: Array<[string, string]> = items
    .filter((item) => typeof item['id'] === 'string')
    .map((item) => [String(item['id']), sha256(JSON.stringify(item))]);
  entries.sort((left, right) => left[0].localeCompare(right[0]));
  return Object.fromEntries(entries);
}

function changedIds(
  current: Record<string, string>,
  previous: Record<string, string>,
): string[] {
  return [...new Set([...Object.keys(current), ...Object.keys(previous)])]
    .filter((id) => current[id] !== previous[id])
    .sort();
}

function words(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('-', ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function scalar(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Not applicable.';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function bullets(values: string[]): string {
  return values.length > 0 ? values.map((value) => '- ' + value).join('\n') : '- None.';
}

function renderValue(value: unknown, depth = 3): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '- None.';
    if (value.every((item) => typeof item !== 'object' || item === null)) {
      return bullets(value.map(scalar));
    }
    return value
      .map((item, index) => {
        const itemRecord = record(item);
        const label =
          scalar(
            itemRecord['id'] ??
              itemRecord['name'] ??
              itemRecord['title'] ??
              itemRecord['question'] ??
              index + 1,
          );
        return '#'.repeat(Math.min(depth, 6)) + ' ' + label + '\n\n' + renderRecord(itemRecord, depth + 1);
      })
      .join('\n\n');
  }
  if (typeof value === 'object' && value !== null) {
    return renderRecord(record(value), depth);
  }
  return scalar(value);
}

function renderRecord(value: Record<string, unknown>, depth = 2): string {
  return Object.entries(value)
    .map(
      ([key, child]) =>
        '#'.repeat(Math.min(depth, 6)) +
        ' ' +
        words(key) +
        '\n\n' +
        renderValue(child, depth + 1),
    )
    .join('\n\n');
}

function stageDocument(title: string, session: DesignSession, stages: string[]): string {
  const bodies = stages
    .map((stageName) => {
      const stage = session.stages[stageName as keyof typeof session.stages];
      return stage === undefined
        ? ''
        : '## ' + words(stageName) + '\n\n' + renderRecord(stage as Record<string, unknown>, 3);
    })
    .filter(Boolean);
  return '# ' + title + '\n\n' + bodies.join('\n\n') + '\n';
}

function overview(session: DesignSession): string {
  const problem = record(session.stages['problem-framing']);
  return (
    '# ' +
    session.title +
    '\n\n' +
    scalar(problem['problemStatement']) +
    '\n\n## Business context\n\n' +
    scalar(problem['businessContext']) +
    '\n\n## Actors\n\n' +
    bullets(stringList(problem['actors'])) +
    '\n\n## Source idea\n\n' +
    session.roughIdea +
    '\n'
  );
}

function goals(session: DesignSession): string {
  const problem = record(session.stages['problem-framing']);
  const decided = session.decisions.filter((decision) => decision.status === 'DECIDED');
  const decidedText =
    decided.length === 0
      ? '- None.'
      : decided
          .map(
            (decision) =>
              '- **' +
              decision.id +
              '** ' +
              decision.question +
              '\n  - Decision: ' +
              (decision.answer ?? 'Not recorded.') +
              '\n  - Authority: ' +
              decision.authority +
              '\n  - Source: ' +
              decision.source,
          )
          .join('\n');
  return (
    '# Goals and non-goals\n\n## Goals\n\n' +
    bullets(stringList(problem['goals'])) +
    '\n\n## Non-goals\n\n' +
    bullets(stringList(problem['nonGoals'])) +
    '\n\n## Success criteria\n\n' +
    bullets(stringList(problem['successCriteria'])) +
    '\n\n## Known constraints\n\n' +
    bullets(stringList(problem['knownConstraints'])) +
    '\n\n## Assumptions\n\n' +
    bullets(stringList(problem['assumptions'])) +
    '\n\n## Approved product and engineering decisions\n\n' +
    decidedText +
    '\n'
  );
}

function requirements(session: DesignSession): string {
  return stageDocument('Requirements', session, [
    'functional-requirements',
    'non-functional-requirements',
  ]);
}

function currentSystem(snapshot: CurrentSystemSnapshot): string {
  const summary: Record<string, JsonValue> = {
    baseline: {
      repository: snapshot.identity.name,
      commit: snapshot.identity.commit,
      contentFingerprint: snapshot.identity.contentFingerprint,
      dirty: snapshot.identity.dirty,
      capturedAt: snapshot.identity.capturedAt,
    },
    projectType: snapshot.projectType,
    languages: snapshot.languages,
    frameworks: snapshot.frameworks,
    modules: snapshot.modules,
    services: snapshot.services,
    publicApis: snapshot.publicApis,
    domainModels: snapshot.domainModels,
    storage: snapshot.storage,
    messaging: snapshot.messaging,
    authentication: snapshot.authentication,
    authorization: snapshot.authorization,
    frontend: snapshot.frontend,
    deployment: snapshot.deployment,
    tests: snapshot.tests,
    integrations: snapshot.integrations,
    configuration: snapshot.configuration,
    architecturalPatterns: snapshot.architecturalPatterns,
    importantConstraints: snapshot.importantConstraints,
    knownProductBehavior: snapshot.knownProductBehavior,
    technicalDebt: snapshot.technicalDebt,
    uncertainties: snapshot.uncertainties,
    evidence: snapshot.evidence.map((item) => ({
      id: item.id,
      classification: item.classification,
      path: item.path,
      detail: item.detail,
    })),
  };
  return '# Current system\n\n' + renderRecord(summary, 2) + '\n';
}

function research(session: DesignSession): string {
  if (session.research.length === 0) {
    return '# Research\n\nNo external research was required for this design.\n';
  }
  const reports = session.research
    .map((report) => {
      const sources = report.sources
        .map(
          (source) =>
            '- [' +
            source.title +
            '](' +
            source.url +
            ') — ' +
            (source.publisher ?? 'unknown publisher') +
            ', accessed ' +
            source.accessedAt +
            (source.relevantVersion === null ? '' : ', version ' + source.relevantVersion) +
            ' (' +
            source.id +
            ')',
        )
        .join('\n');
      const findings = report.findings
        .map(
          (finding) =>
            '- **' +
            finding.kind +
            '** ' +
            finding.statement +
            ' [' +
            finding.sourceIds.join(', ') +
            ']',
        )
        .join('\n');
      return (
        '## ' +
        report.question +
        '\n\nReport: ' +
        report.id +
        ' · Confidence: **' +
        report.confidence +
        '** · Researched: ' +
        report.researchedAt +
        '\n\n### Findings\n\n' +
        (findings || '- None.') +
        '\n\n### Engineering implications\n\n' +
        bullets(report.engineeringImplications) +
        '\n\n### Product implications\n\n' +
        bullets(report.productImplications) +
        '\n\n### Contradictions\n\n' +
        bullets(report.contradictions) +
        '\n\n### Unresolved\n\n' +
        bullets(report.unresolved) +
        '\n\n### Sources\n\n' +
        (sources || '- None.')
      );
    })
    .join('\n\n');
  return '# Research\n\n' + reports + '\n';
}

function architecture(session: DesignSession): string {
  const base = stageDocument('System design', session, [
    'scale-capacity',
    'architecture',
    'critical-deep-dives',
    'alternatives',
  ]);
  const architectureStage = record(session.stages['architecture']);
  const mermaid = scalar(architectureStage['mermaid']);
  const fence = String.fromCharCode(96).repeat(3);
  return base.replace(
    '### Mermaid\n\n' + mermaid,
    '### Architecture diagram\n\n' + fence + 'mermaid\n' + mermaid + '\n' + fence,
  );
}

function decisions(session: DesignSession): string {
  const open = session.decisions.filter((decision) => decision.status === 'OPEN');
  if (open.length === 0) {
    return '# Open decisions\n\nNo material decisions remain open.\n';
  }
  return (
    '# Open decisions\n\n' +
    open
      .map(
        (decision) =>
          '## ' +
          decision.id +
          '\n\n' +
          decision.question +
          '\n\n- Why it matters: ' +
          decision.whyItMatters +
          '\n- Options: ' +
          (decision.options.join('; ') || 'No fixed options.') +
          '\n- Recommendation: ' +
          (decision.recommendation ?? 'None.') +
          '\n- Authority: ' +
          decision.authority +
          '\n- Blocking: ' +
          String(decision.blocking),
      )
      .join('\n\n') +
    '\n'
  );
}

function implementationGuidance(session: DesignSession): string {
  const testing = record(session.stages['testing-acceptance']);
  const guidance = record(testing['implementationGuidance']);
  return (
    '# Implementation guidance\n\n' +
    'This is guidance, not a SpecBridge execution plan. The implementing coding agent owns task decomposition, parallelism, retries, and context management.\n\n' +
    renderRecord(guidance, 2) +
    '\n'
  );
}

function testingStrategy(session: DesignSession): string {
  const source = record(session.stages['testing-acceptance']);
  const testing = Object.fromEntries(
    Object.entries(source).filter(
      ([key]) => key !== 'acceptanceCriteria' && key !== 'implementationGuidance',
    ),
  );
  return '# Testing strategy\n\n' + renderRecord(testing, 2) + '\n';
}

function acceptanceCriteriaDocument(session: DesignSession): string {
  const source = record(session.stages['testing-acceptance']);
  return (
    '# Acceptance criteria\n\n' +
    renderValue(source['acceptanceCriteria'], 2) +
    '\n'
  );
}

function qualityDocument(quality: SpecQualityReport): string {
  const rows = quality.findings
    .map(
      (finding) =>
        '| ' +
        finding.dimension +
        ' | ' +
        finding.severity +
        ' | ' +
        finding.message.replaceAll('|', '\\|') +
        ' | ' +
        finding.references.join(', ').replaceAll('|', '\\|') +
        ' |',
    )
    .join('\n');
  return (
    '# Spec quality report\n\nImplementation ready: **' +
    (quality.ready ? 'YES' : 'NO') +
    '**\n\n| Dimension | Result | Finding | References |\n|---|---|---|---|\n' +
    rows +
    '\n'
  );
}

function agentHandoff(): string {
  return (
    '# Agent handoff\n\n' +
    'Implement the approved specification referenced by spec.yaml. Read every referenced document before making architectural changes.\n\n' +
    'You own implementation planning and execution. You may decompose work, create subagents, use worktrees, parallelize independent work, retry and repair, choose implementation order, and manage your own context.\n\n' +
    'Preserve goals, non-goals, approved product decisions, architectural invariants, external contracts, security constraints, and acceptance criteria. Do not silently change the product contract.\n\n' +
    'If implementation uncovers a genuine product ambiguity or approved-contract conflict, ask the user. Routine engineering decisions belong to you.\n\n' +
    'Completion means every acceptance criterion has credible evidence. SpecBridge does not supervise or execute implementation.\n'
  );
}

function archiveExisting(packDir: string, previous: SpecPackManifest): void {
  const archiveDir = assertInsideWorkspace(
    packDir,
    path.join('revisions', String(previous.revision)),
  );
  mkdirSync(archiveDir, { recursive: true });
  const names = ['spec.yaml', ...Object.values(previous.documents)];
  for (const name of names) {
    const source = assertInsideWorkspace(packDir, name);
    if (!existsSync(source)) continue;
    writeFileAtomic(
      assertInsideWorkspace(archiveDir, path.basename(name)),
      readFileSync(source),
    );
  }
}

export interface CompileResult {
  directory: string;
  manifest: SpecPackManifest;
  files: string[];
}

export function compileSpecPack(
  rootDir: string,
  session: DesignSession,
  snapshot: CurrentSystemSnapshot,
  quality: SpecQualityReport,
): CompileResult {
  if (session.status !== 'APPROVED' || session.approval === null) {
    throw new SpecBridgeError(
      'DESIGN_NOT_APPROVED',
      'A natural-language product approval is required before compiling the Spec Pack.',
    );
  }
  if (!quality.ready) {
    throw new SpecBridgeError('SPEC_NOT_READY', 'The design evaluator has failing findings.');
  }
  const packDir = assertInsideWorkspace(
    rootDir,
    path.join('.specbridge', 'specs', session.slug),
  );
  mkdirSync(packDir, { recursive: true });
  const manifestFile = path.join(packDir, 'spec.yaml');
  let revision = session.revision;
  let previous: SpecPackManifest | null = null;
  if (existsSync(manifestFile)) {
    previous = YAML.parse(
      readFileSync(manifestFile, 'utf8'),
    ) as SpecPackManifest;
    archiveExisting(packDir, previous);
    revision = Math.max(revision, previous.revision + 1);
  }
  const problem = record(session.stages['problem-framing']);
  const currentEntityHashes = {
    productDecisions: entityHashes(
      session.decisions.map((decision) => decision as unknown as Record<string, unknown>),
    ),
    requirements: entityHashes([
      ...records(record(session.stages['functional-requirements'])['requirements']),
      ...records(record(session.stages['non-functional-requirements'])['requirements']),
    ]),
    acceptanceCriteria: entityHashes(
      records(record(session.stages['testing-acceptance'])['acceptanceCriteria']),
    ),
  };
  const priorHashes = previous?.entityHashes ?? {
    productDecisions: {},
    requirements: {},
    acceptanceCriteria: {},
  };
  const changedProductDecisionIds = changedIds(
    currentEntityHashes.productDecisions,
    priorHashes.productDecisions,
  );
  const changedRequirementIds = changedIds(
    currentEntityHashes.requirements,
    priorHashes.requirements,
  );
  const changedAcceptanceCriterionIds = changedIds(
    currentEntityHashes.acceptanceCriteria,
    priorHashes.acceptanceCriteria,
  );
  const changeSummary =
    previous === null
      ? ['Initial approved product contract.']
      : [
          changedProductDecisionIds.length > 0
            ? `${changedProductDecisionIds.length} product decision(s) changed.`
            : null,
          changedRequirementIds.length > 0
            ? `${changedRequirementIds.length} requirement(s) changed.`
            : null,
          changedAcceptanceCriterionIds.length > 0
            ? `${changedAcceptanceCriterionIds.length} acceptance criterion/criteria changed.`
            : null,
        ].filter((item): item is string => item !== null);
  if (changeSummary.length === 0) {
    changeSummary.push('No product-contract entity changes detected.');
  }
  const manifest: SpecPackManifest = {
    schemaVersion: 'specbridge.spec.v2',
    name: session.slug,
    revision,
    status: 'approved',
    baseline: {
      repository: snapshot.identity.name,
      commit: snapshot.identity.commit,
      contentFingerprint: snapshot.identity.contentFingerprint,
    },
    documents: { ...DOCUMENTS },
    goals: stringList(problem['goals']),
    nonGoals: stringList(problem['nonGoals']),
    openBlockingDecisions: session.decisions
      .filter((decision) => decision.blocking && decision.status === 'OPEN')
      .map((decision) => decision.id),
    approvedAt: session.approval.approvedAt,
    sourceSessionId: session.id,
    changes: {
      previousRevision: previous?.revision ?? null,
      summary: changeSummary,
      changedProductDecisionIds,
      changedRequirementIds,
      changedAcceptanceCriterionIds,
    },
    entityHashes: currentEntityHashes,
  };
  const contents: Record<string, string> = {
    [DOCUMENTS.overview]: overview(session),
    [DOCUMENTS.goals]: goals(session),
    [DOCUMENTS.requirements]: requirements(session),
    [DOCUMENTS.currentSystem]: currentSystem(snapshot),
    [DOCUMENTS.research]: research(session),
    [DOCUMENTS.architecture]: architecture(session),
    [DOCUMENTS.dataModel]: stageDocument('Data model', session, ['data-design']),
    [DOCUMENTS.interfaces]: stageDocument('APIs and events', session, ['api-events']),
    [DOCUMENTS.security]: stageDocument('Security', session, ['security']),
    [DOCUMENTS.reliability]: stageDocument('Reliability', session, ['reliability']),
    [DOCUMENTS.observability]: stageDocument('Observability', session, ['observability']),
    [DOCUMENTS.deployment]: stageDocument('Deployment and rollout', session, [
      'deployment-migration',
    ]),
    [DOCUMENTS.testing]: testingStrategy(session),
    [DOCUMENTS.acceptance]: acceptanceCriteriaDocument(session),
    [DOCUMENTS.openDecisions]: decisions(session),
    [DOCUMENTS.implementationGuidance]: implementationGuidance(session),
    [DOCUMENTS.quality]: qualityDocument(quality),
    [DOCUMENTS.agentHandoff]: agentHandoff(),
  };
  for (const [name, content] of Object.entries(contents)) {
    writeFileAtomic(
      assertInsideWorkspace(packDir, name),
      content.endsWith('\n') ? content : content + '\n',
    );
  }
  writeFileAtomic(manifestFile, YAML.stringify(manifest));
  return {
    directory: packDir,
    manifest,
    files: ['spec.yaml', ...Object.keys(contents)],
  };
}
