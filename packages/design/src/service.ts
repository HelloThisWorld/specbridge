import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  assertInsideWorkspace,
  DESIGN_STAGES,
  readJsonFile,
  resolveWorkspace,
  SpecBridgeError,
  workspaceRelative,
  writeFileAtomic,
} from '@specbridge/core';
import type {
  CurrentSystemSnapshot,
  DesignSession,
  DesignStage,
  ResearchReport,
  SpecPackManifest,
  SpecQualityReport,
} from '@specbridge/core';
import {
  bootstrapRepository,
  readRepositoryIndex,
  retrieveRepositoryContext,
} from '@specbridge/repository';
import type {
  BootstrapOptions,
  BootstrapResult,
  RetrievedContext,
} from '@specbridge/repository';
import { compileSpecPack } from './compiler.js';
import type { CompileResult } from './compiler.js';
import { evaluateDesign } from './evaluator.js';
import type { ModelEvaluationFinding } from './evaluator.js';
import { DesignSessionStore } from './store.js';
import { validateModelEvaluationFindings } from './schemas.js';

export interface DesignServiceOptions {
  rootDir: string;
  now?: () => Date;
  idFactory?: () => string;
}

export interface DesignReadResult {
  session: DesignSession;
  nextAction:
    | 'ANSWER_PRODUCT_DECISION'
    | 'PROVIDE_RESEARCH'
    | 'GENERATE_STAGE'
    | 'REVIEW'
    | 'COMPLETE';
  pendingDecisions: DesignSession['decisions'];
  repositoryContext: RetrievedContext[];
}

export interface SpecReadResult {
  manifest: SpecPackManifest;
  document: string | null;
  content: string;
}

export class DesignService {
  readonly rootDir: string;
  readonly store: DesignSessionStore;
  private readonly now: () => Date;

  constructor(options: DesignServiceOptions) {
    this.rootDir = resolveWorkspace(options.rootDir)?.rootDir ?? path.resolve(options.rootDir);
    this.now = options.now ?? (() => new Date());
    this.store = new DesignSessionStore({
      rootDir: this.rootDir,
      now: this.now,
      ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
    });
  }

  bootstrap(options: Omit<BootstrapOptions, 'rootDir'> = {}): BootstrapResult {
    return bootstrapRepository({ rootDir: this.rootDir, ...options });
  }

  start(title: string, roughIdea: string): DesignSession {
    if (title.trim().length === 0 || roughIdea.trim().length === 0) {
      throw new SpecBridgeError(
        'INVALID_DESIGN_INPUT',
        'A design title and rough product idea are required.',
      );
    }
    const bootstrap = this.bootstrap();
    return this.store.create({
      title,
      roughIdea,
      snapshot: bootstrap.snapshot,
      snapshotPath: workspaceRelative(this.rootDir, bootstrap.snapshotPath),
    });
  }

  list(): DesignSession[] {
    return this.store.list();
  }

  read(subject: string): DesignReadResult {
    const session = this.store.read(subject);
    const open = session.decisions.filter((decision) => decision.status === 'OPEN');
    const allStagesRecorded = DESIGN_STAGES.every(
      (stage) => session.stages[stage] !== undefined,
    );
    const nextAction =
      session.status === 'NEEDS_INPUT'
        ? 'ANSWER_PRODUCT_DECISION'
        : session.status === 'RESEARCHING'
          ? 'PROVIDE_RESEARCH'
          : session.status === 'READY_FOR_REVIEW'
            ? 'REVIEW'
            : session.status === 'APPROVED' || session.status === 'SUPERSEDED'
              ? 'COMPLETE'
              : allStagesRecorded
                ? 'REVIEW'
                : 'GENERATE_STAGE';
    let repositoryContext: RetrievedContext[] = [];
    if (nextAction === 'GENERATE_STAGE') {
      try {
        const index = readRepositoryIndex(this.rootDir);
        repositoryContext = retrieveRepositoryContext(index, {
          rootDir: this.rootDir,
          query: session.roughIdea + '\n' + session.currentStage.replaceAll('-', ' '),
          limit: 12,
        });
      } catch {
        repositoryContext = [];
      }
    }
    return {
      session,
      nextAction,
      pendingDecisions: open,
      repositoryContext,
    };
  }

  recordStage(subject: string, stage: DesignStage, output: unknown): DesignSession {
    return this.store.recordStage(subject, stage, output);
  }

  answer(subject: string, decisionId: string, answer: string): DesignSession {
    return this.store.answerDecision(subject, decisionId, answer);
  }

  recordResearch(subject: string, report: ResearchReport): DesignSession {
    return this.store.recordResearch(subject, report);
  }

  evaluate(
    subject: string,
    modelFindings: ModelEvaluationFinding[] = [],
  ): SpecQualityReport {
    const session = this.store.read(subject);
    const snapshot = this.bootstrap().snapshot;
    const quality = evaluateDesign(
      session,
      snapshot,
      this.now(),
      validateModelEvaluationFindings(modelFindings),
    );
    this.store.setReviewStatus(subject, quality.ready);
    const file = assertInsideWorkspace(
      this.rootDir,
      path.join('.specbridge', 'design-sessions', session.id, 'quality.json'),
    );
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify(quality, null, 2) + '\n');
    return quality;
  }

  approve(
    subject: string,
    approvalText: string,
    approvedBy = 'human',
  ): CompileResult {
    const session = this.store.read(subject);
    const quality = this.readQuality(subject);
    if (quality === null) {
      throw new SpecBridgeError(
        'SPEC_EVALUATION_REQUIRED',
        'Run the Spec Evaluator before requesting approval.',
      );
    }
    if (!quality.ready) {
      throw new SpecBridgeError(
        'SPEC_NOT_READY',
        'The design has failing quality findings and cannot be approved.',
        {
          failures: quality.findings.filter((finding) => finding.severity === 'FAIL'),
        },
      );
    }
    const snapshot = this.bootstrap().snapshot;
    const current = evaluateDesign(session, snapshot, this.now());
    if (current.designDigest !== quality.designDigest) {
      throw new SpecBridgeError(
        'SPEC_EVALUATION_STALE',
        'The design or repository baseline changed after evaluation; evaluate it again before approval.',
      );
    }
    const approved = this.store.approve(subject, approvalText, approvedBy);
    return compileSpecPack(this.rootDir, approved, snapshot, quality);
  }

  listSpecs(): SpecPackManifest[] {
    const specsDir = assertInsideWorkspace(this.rootDir, path.join('.specbridge', 'specs'));
    if (!existsSync(specsDir)) return [];
    return readdirSync(specsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const manifest = path.join(specsDir, entry.name, 'spec.yaml');
        if (!existsSync(manifest)) return null;
        try {
          return YAML.parse(readFileSync(manifest, 'utf8')) as SpecPackManifest;
        } catch {
          return null;
        }
      })
      .filter((manifest): manifest is SpecPackManifest => manifest !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  readSpec(name: string, document?: string): SpecReadResult {
    const specsDir = assertInsideWorkspace(this.rootDir, path.join('.specbridge', 'specs'));
    const manifestPath = assertInsideWorkspace(
      specsDir,
      path.join(name, 'spec.yaml'),
    );
    if (!existsSync(manifestPath)) {
      throw new SpecBridgeError('SPEC_NOT_FOUND', 'Spec Pack was not found.', { name });
    }
    const manifest = YAML.parse(readFileSync(manifestPath, 'utf8')) as SpecPackManifest;
    if (document === undefined) {
      return {
        manifest,
        document: null,
        content: readFileSync(manifestPath, 'utf8'),
      };
    }
    const fileName = manifest.documents[document] ?? document;
    if (!Object.values(manifest.documents).includes(fileName)) {
      throw new SpecBridgeError(
        'SPEC_DOCUMENT_NOT_FOUND',
        'Document is not referenced by the Spec Pack manifest.',
        { name, document },
      );
    }
    const file = assertInsideWorkspace(path.dirname(manifestPath), fileName);
    return { manifest, document: fileName, content: readFileSync(file, 'utf8') };
  }

  readQuality(subject: string): SpecQualityReport | null {
    const session = this.store.read(subject);
    const file = assertInsideWorkspace(
      this.rootDir,
      path.join('.specbridge', 'design-sessions', session.id, 'quality.json'),
    );
    return existsSync(file) ? readJsonFile<SpecQualityReport>(file) : null;
  }

  private snapshot(session: DesignSession): CurrentSystemSnapshot {
    return readJsonFile<CurrentSystemSnapshot>(
      assertInsideWorkspace(this.rootDir, session.snapshotPath),
    );
  }
}

export function isDesignStage(value: string): value is DesignStage {
  return (DESIGN_STAGES as readonly string[]).includes(value);
}
