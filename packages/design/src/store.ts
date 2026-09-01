import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  assertInsideWorkspace,
  DESIGN_STAGES,
  readJsonFile,
  slugify,
  SpecBridgeError,
  writeFileAtomic,
} from '@specbridge/core';
import type {
  CurrentSystemSnapshot,
  DesignSession,
  DesignStage,
  ProductDecision,
  ResearchReport,
} from '@specbridge/core';
import {
  questionCandidateSchema,
  validateResearchReport,
  validateStageOutput,
} from './schemas.js';
import { toProductDecision } from './authority.js';

export interface CreateSessionInput {
  title: string;
  roughIdea: string;
  snapshot: CurrentSystemSnapshot;
  snapshotPath: string;
}

export interface DesignSessionStoreOptions {
  rootDir: string;
  now?: () => Date;
  idFactory?: () => string;
}

function normalizeQuestion(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function activeStatus(session: DesignSession): DesignSession['status'] {
  const humanOpen = session.decisions.some(
    (decision) =>
      decision.status === 'OPEN' && decision.authority === 'HUMAN' && decision.blocking,
  );
  if (humanOpen) return 'NEEDS_INPUT';
  const researchOpen = session.decisions.some(
    (decision) =>
      decision.status === 'OPEN' && decision.authority === 'RESEARCH' && decision.blocking,
  );
  return researchOpen ? 'RESEARCHING' : 'DESIGNING';
}

function isExplicitApproval(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (normalized.length === 0) return false;
  if (
    /\b(?:do not|don't|not|decline|reject)\b.{0,30}\b(?:approve|accept|ok|okay)\b/.test(
      normalized,
    ) ||
    /(?:不|未|拒絕|拒绝).{0,12}(?:同意|核准|批准|通過|通过|可以)/u.test(normalized)
  ) {
    return false;
  }
  return (
    /\b(?:i\s+)?(?:approve|accept)\b|\bapproved\b|\blooks?\s+good\b|\b(?:ok|okay)\b/.test(
      normalized,
    ) ||
    /(?:我)?(?:同意|核准|批准|通過|通过|可以|沒問題|没问题)/u.test(normalized)
  );
}

export class DesignSessionStore {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  readonly rootDir: string;
  readonly sessionsDir: string;

  constructor(options: DesignSessionStoreOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.sessionsDir = assertInsideWorkspace(
      this.rootDir,
      path.join('.specbridge', 'design-sessions'),
    );
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  create(input: CreateSessionInput): DesignSession {
    const slug = slugify(input.title);
    const previous = this.list().filter((session) => session.slug === slug);
    const unfinished = previous.find(
      (session) => session.status !== 'APPROVED' && session.status !== 'SUPERSEDED',
    );
    if (unfinished !== undefined) {
      throw new SpecBridgeError(
        'DESIGN_SESSION_EXISTS',
        `An unfinished design session named "${slug}" already exists.`,
        { slug, sessionId: unfinished.id },
      );
    }
    const timestamp = this.now().toISOString();
    const session: DesignSession = {
      schemaVersion: 'specbridge.design-session.v2',
      id: `design-${this.idFactory()}`,
      slug,
      title: input.title.trim(),
      roughIdea: input.roughIdea,
      status: 'DISCOVERING',
      createdAt: timestamp,
      updatedAt: timestamp,
      baselineCommit: input.snapshot.identity.commit,
      baselineFingerprint: input.snapshot.identity.contentFingerprint,
      snapshotPath: input.snapshotPath,
      currentStage: DESIGN_STAGES[0],
      stages: {},
      decisions: [],
      research: [],
      approval: null,
      revision: Math.max(0, ...previous.map((session) => session.revision)) + 1,
    };
    for (const candidate of previous.filter((item) => item.status === 'APPROVED')) {
      candidate.status = 'SUPERSEDED';
      candidate.updatedAt = timestamp;
      this.save(candidate);
    }
    this.save(session);
    return session;
  }

  list(): DesignSession[] {
    if (!existsSync(this.sessionsDir)) return [];
    return readdirSync(this.sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        try {
          return readJsonFile<DesignSession>(this.sessionFile(entry.name));
        } catch {
          return null;
        }
      })
      .filter((session): session is DesignSession => session !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  read(subject: string): DesignSession {
    const direct = this.sessionFile(subject);
    if (existsSync(direct)) return readJsonFile<DesignSession>(direct);
    const found = this.list().find((session) => session.id === subject || session.slug === subject);
    if (found === undefined) {
      throw new SpecBridgeError('DESIGN_SESSION_NOT_FOUND', 'Design session was not found.', {
        subject,
      });
    }
    return found;
  }

  recordStage(subject: string, stage: DesignStage, rawOutput: unknown): DesignSession {
    const session = this.read(subject);
    if (session.status === 'APPROVED' || session.status === 'SUPERSEDED') {
      throw new SpecBridgeError(
        'DESIGN_SESSION_IMMUTABLE',
        'Approved and superseded sessions cannot be changed.',
        { subject, status: session.status },
      );
    }
    if (stage !== session.currentStage) {
      throw new SpecBridgeError('DESIGN_STAGE_ORDER', 'Design stages must be recorded in order.', {
        expected: session.currentStage,
        received: stage,
      });
    }
    const output = validateStageOutput(stage, rawOutput);
    session.stages[stage] = output;
    if (stage === 'problem-framing') {
      const candidates = Array.isArray(output['openQuestions']) ? output['openQuestions'] : [];
      const discovered = candidates.map((candidate) =>
        toProductDecision(questionCandidateSchema.parse(candidate)),
      );
      session.decisions = mergeDecisions(session.decisions, discovered);
    }
    const index = DESIGN_STAGES.indexOf(stage);
    const next = DESIGN_STAGES[index + 1];
    if (next !== undefined) session.currentStage = next;
    session.status = activeStatus(session);
    session.updatedAt = this.now().toISOString();
    this.save(session);
    return session;
  }

  answerDecision(subject: string, decisionId: string, answer: string): DesignSession {
    const session = this.read(subject);
    if (session.status === 'APPROVED' || session.status === 'SUPERSEDED') {
      throw new SpecBridgeError(
        'DESIGN_SESSION_IMMUTABLE',
        'Approved and superseded sessions cannot be changed.',
        { subject, status: session.status },
      );
    }
    const decision = session.decisions.find((candidate) => candidate.id === decisionId);
    if (decision === undefined) {
      throw new SpecBridgeError('DECISION_NOT_FOUND', 'Product decision was not found.', {
        subject,
        decisionId,
      });
    }
    if (decision.authority !== 'HUMAN') {
      throw new SpecBridgeError(
        'WRONG_DECISION_AUTHORITY',
        'Only human product decisions are answered through this operation.',
        { decisionId, authority: decision.authority },
      );
    }
    if (answer.trim().length === 0) {
      throw new SpecBridgeError('EMPTY_DECISION_ANSWER', 'Decision answer cannot be empty.');
    }
    decision.answer = answer;
    decision.status = 'DECIDED';
    session.status = activeStatus(session);
    session.updatedAt = this.now().toISOString();
    this.save(session);
    return session;
  }

  recordResearch(subject: string, report: ResearchReport): DesignSession {
    const session = this.read(subject);
    if (session.status === 'APPROVED' || session.status === 'SUPERSEDED') {
      throw new SpecBridgeError(
        'DESIGN_SESSION_IMMUTABLE',
        'Approved and superseded sessions cannot be changed.',
        { subject, status: session.status },
      );
    }
    report = validateResearchReport(report);
    const normalized = normalizeQuestion(report.question);
    if (report.normalizedQuestion !== normalized) {
      throw new SpecBridgeError(
        'RESEARCH_QUESTION_NOT_NORMALIZED',
        'Research report normalizedQuestion does not match its question.',
        { expected: normalized, received: report.normalizedQuestion },
      );
    }
    const sourceIds = new Set(report.sources.map((source) => source.id));
    const invalidFinding = report.findings.find((finding) =>
      finding.sourceIds.some((sourceId) => !sourceIds.has(sourceId)),
    );
    if (invalidFinding !== undefined) {
      throw new SpecBridgeError(
        'RESEARCH_SOURCE_MISSING',
        'A research finding references a source that is not in the report.',
        { findingId: invalidFinding.id },
      );
    }
    session.research = [
      ...session.research.filter((candidate) => candidate.id !== report.id),
      report,
    ].sort((a, b) => a.id.localeCompare(b.id));
    if (report.unresolved.length === 0) {
      for (const decision of session.decisions) {
        if (
          decision.authority === 'RESEARCH' &&
          normalizeQuestion(decision.question) === normalized
        ) {
          decision.status = 'DECIDED';
          decision.answer = `Resolved by research report ${report.id}.`;
        }
      }
    }
    session.status = activeStatus(session);
    session.updatedAt = this.now().toISOString();
    this.save(session);
    return session;
  }

  setReviewStatus(subject: string, ready: boolean): DesignSession {
    const session = this.read(subject);
    if (session.status === 'APPROVED' || session.status === 'SUPERSEDED') return session;
    session.status = ready ? 'READY_FOR_REVIEW' : 'DESIGNING';
    session.updatedAt = this.now().toISOString();
    this.save(session);
    return session;
  }

  approve(subject: string, text: string, approvedBy: string): DesignSession {
    const session = this.read(subject);
    if (session.status !== 'READY_FOR_REVIEW') {
      throw new SpecBridgeError(
        'DESIGN_NOT_READY',
        'Only a design that passed evaluation can be approved.',
        { status: session.status },
      );
    }
    if (!isExplicitApproval(text)) {
      throw new SpecBridgeError(
        'EXPLICIT_APPROVAL_REQUIRED',
        'Approval text must explicitly and affirmatively approve the specification.',
      );
    }
    session.approval = {
      text,
      approvedAt: this.now().toISOString(),
      approvedBy: approvedBy.trim() || 'human',
    };
    session.status = 'APPROVED';
    session.updatedAt = this.now().toISOString();
    this.save(session);
    return session;
  }

  save(session: DesignSession): void {
    const directory = this.sessionDirectory(session.id);
    mkdirSync(directory, { recursive: true });
    writeFileAtomic(this.sessionFile(session.id), `${JSON.stringify(session, null, 2)}\n`);
  }

  private sessionDirectory(key: string): string {
    const safeKey = key.replace(/[^A-Za-z0-9._-]/g, '-');
    return assertInsideWorkspace(this.rootDir, path.join(this.sessionsDir, safeKey));
  }

  private sessionFile(key: string): string {
    return assertInsideWorkspace(this.rootDir, path.join(this.sessionDirectory(key), 'session.json'));
  }
}

function mergeDecisions(
  existing: ProductDecision[],
  discovered: ProductDecision[],
): ProductDecision[] {
  const byId = new Map(existing.map((decision) => [decision.id, decision]));
  for (const decision of discovered) {
    if (!byId.has(decision.id)) byId.set(decision.id, decision);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
