import { DESIGN_STAGES, SpecBridgeError } from '@specbridge/core';
import type {
  CurrentSystemSnapshot,
  DesignSession,
  DesignStage,
  JsonObject,
  ResearchReport,
} from '@specbridge/core';
import type { RepositoryIndex, RetrievedContext } from '@specbridge/repository';
import { retrieveRepositoryContext } from '@specbridge/repository';
import type { DesignSessionStore } from './store.js';

export interface DesignStageRequest {
  stage: DesignStage;
  roughIdea: string;
  snapshot: CurrentSystemSnapshot;
  repositoryContext: RetrievedContext[];
  completedStages: Partial<Record<DesignStage, JsonObject>>;
  decisions: DesignSession['decisions'];
  research: ResearchReport[];
}

export interface SystemDesignProvider {
  generateStage(request: DesignStageRequest): Promise<unknown>;
}

export interface PipelineOptions {
  store: DesignSessionStore;
  snapshot: CurrentSystemSnapshot;
  index: RepositoryIndex;
  provider: SystemDesignProvider;
}

export class SystemDesignPipeline {
  constructor(private readonly options: PipelineOptions) {}

  async runNext(subject: string): Promise<DesignSession> {
    const session = this.options.store.read(subject);
    if (session.status === 'NEEDS_INPUT' || session.status === 'RESEARCHING') {
      throw new SpecBridgeError(
        'DESIGN_BLOCKED',
        'The design needs a product answer or research evidence before it can continue.',
        { status: session.status },
      );
    }
    if (session.status === 'READY_FOR_REVIEW' || session.status === 'APPROVED') return session;
    const stage = session.currentStage;
    if (session.stages[stage] !== undefined) {
      throw new SpecBridgeError('DESIGN_STAGE_ALREADY_RECORDED', 'Current design stage already exists.', {
        stage,
      });
    }
    const repositoryContext = retrieveRepositoryContext(this.options.index, {
      rootDir: this.options.snapshot.identity.root,
      query: `${session.roughIdea}\n${stage.replaceAll('-', ' ')}`,
      limit: 12,
    });
    const raw = await this.options.provider.generateStage({
      stage,
      roughIdea: session.roughIdea,
      snapshot: this.options.snapshot,
      repositoryContext,
      completedStages: session.stages,
      decisions: session.decisions,
      research: session.research,
    });
    return this.options.store.recordStage(subject, stage, raw);
  }

  async runUntilBlocked(subject: string): Promise<DesignSession> {
    let session = this.options.store.read(subject);
    while (
      session.status !== 'NEEDS_INPUT' &&
      session.status !== 'RESEARCHING' &&
      session.status !== 'READY_FOR_REVIEW' &&
      session.status !== 'APPROVED'
    ) {
      const before = DESIGN_STAGES.indexOf(session.currentStage);
      session = await this.runNext(subject);
      const after = DESIGN_STAGES.indexOf(session.currentStage);
      const allRecorded = DESIGN_STAGES.every((stage) => session.stages[stage] !== undefined);
      if (allRecorded || after === before) return session;
    }
    return session;
  }
}
