import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { WorkspaceInfo } from '@specbridge/core';
import { resolveWorkspace } from '@specbridge/core';
import type { MissionDeps } from '@specbridge/mission';
import { beginMission, recordAssessment, recordTurn } from '@specbridge/mission';
import type { MissionAssessmentResult, MissionState } from '@specbridge/mission';
import { emptyTempDir } from './helpers.js';
import { idCounter, tickingClock } from './helpers-execution.js';

/**
 * Shared setup for mission tests: a fresh Kiro-compatible workspace with an
 * empty `.kiro/specs` and deterministic clock/id factories. Fully offline —
 * missions never touch git, runners, or models.
 */

export interface MissionFixture {
  root: string;
  workspace: WorkspaceInfo;
  deps: MissionDeps;
  clock: () => Date;
}

export function setupMissionFixture(): MissionFixture {
  const root = emptyTempDir();
  mkdirSync(path.join(root, '.kiro', 'specs'), { recursive: true });
  const workspace = resolveWorkspace(root);
  if (workspace === undefined) throw new Error('fixture workspace did not resolve');
  const clock = tickingClock('2026-08-10T09:00:00.000Z');
  return {
    root,
    workspace,
    clock,
    deps: { workspace, clock, idFactory: idCounter('mission'), host: 'test' },
  };
}

/** Begin a mission and open discovery with one user turn. */
export function startedMission(
  fixture: MissionFixture,
  options: { name?: string; goal?: string } = {},
): { mission: MissionState; missionId: string; firstTurnId: string } {
  const mission = beginMission(fixture.deps, {
    name: options.name ?? 'steprelay',
    goal:
      options.goal ??
      'Build StepRelay: a lightweight, config-driven, distributed workflow engine for event-driven systems.',
  });
  const { turn } = recordTurn(fixture.deps, mission.missionId, {
    speaker: 'user',
    kind: 'statement',
    text: mission.goal,
  });
  return { mission, missionId: mission.missionId, firstTurnId: turn.turnId };
}

/**
 * Drive a mission to a CONTRACT_READY-capable state: user turns confirming
 * each required topic, decisions covering them, and one recorded contract.
 * Returns the assessment that recorded the contract.
 */
export function coveredMission(fixture: MissionFixture): {
  missionId: string;
  contractId: string;
  decisionIds: string[];
  assessment: MissionAssessmentResult;
} {
  const { missionId } = startedMission(fixture);
  const confirm = recordTurn(fixture.deps, missionId, {
    speaker: 'user',
    kind: 'confirmation',
    text: 'Confirmed: workflow definitions own control flow; actions own business logic; the engine is broker-neutral.',
  });

  const base = recordAssessment(fixture.deps, missionId, {
    decisions: [
      {
        decision: 'The goal is a lightweight config-driven distributed workflow engine.',
        provenance: 'known-from-user',
        sourceTurnId: confirm.turn.turnId,
        topics: ['goal'],
      },
      {
        decision: 'Primary use case: orchestrating event-driven business workflows across services.',
        provenance: 'known-from-user',
        sourceTurnId: confirm.turn.turnId,
        topics: ['use-cases'],
      },
      {
        decision: 'The engine owns orchestration; user services own business logic via actions.',
        provenance: 'known-from-user',
        sourceTurnId: confirm.turn.turnId,
        topics: ['system-boundaries', 'architecture-ownership'],
      },
      {
        decision: 'The canonical model is a workflow definition interpreted by a deterministic kernel.',
        provenance: 'known-from-user',
        sourceTurnId: confirm.turn.turnId,
        topics: ['canonical-model'],
      },
      {
        decision: 'The public API is the workflow definition format plus the action SDK.',
        provenance: 'known-from-user',
        sourceTurnId: confirm.turn.turnId,
        topics: ['public-api'],
      },
      {
        decision: 'Failures use at-least-once delivery with idempotent completion handling.',
        provenance: 'known-from-user',
        sourceTurnId: confirm.turn.turnId,
        topics: ['failure-semantics', 'idempotency'],
      },
      {
        decision: 'Compatibility: additive-only evolution of public contracts within a major version.',
        provenance: 'known-from-user',
        sourceTurnId: confirm.turn.turnId,
        topics: ['compatibility', 'evolution-rules'],
      },
    ],
  });

  const withContract = recordAssessment(fixture.deps, missionId, {
    contracts: [
      {
        title: 'Canonical Workflow Model',
        summary: 'The workflow definition is the sole authority for control flow.',
        classification: 'public',
        compatibilityPolicy: 'additive-only',
        requirements: [
          { statement: 'Sequential execution is deterministic given one workflow definition.' },
          { statement: 'Invalid transitions are rejected before any side effect.' },
        ],
        invariants: [
          {
            statement: 'Actions never determine workflow transitions.',
            guardPatterns: ['nextState\\s*[:=]'],
          },
        ],
        decisionIds: [base.decisionIds[3] ?? '', base.decisionIds[2] ?? ''].filter((id) => id.length > 0),
      },
    ],
  });

  return {
    missionId,
    contractId: withContract.contractIds[0] ?? 'CTR-001',
    decisionIds: base.decisionIds,
    assessment: withContract,
  };
}
