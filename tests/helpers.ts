import { cpSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ConcreteSpecType,
  ConcreteWorkflowMode,
  SpecWorkflowState,
  StageApproval,
  StageName,
} from '@specbridge/core';
import { SPEC_STATE_SCHEMA_VERSION } from '@specbridge/core';

const testsDir = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to a fixture workspace (tests/fixtures/<name>). */
export function fixturePath(...segments: string[]): string {
  return path.join(testsDir, 'fixtures', ...segments);
}

/** Absolute path to an example workspace (examples/<name>). */
export function examplePath(...segments: string[]): string {
  return path.join(testsDir, '..', 'examples', ...segments);
}

/**
 * Copy a fixture into a fresh temp directory so tests can write safely.
 * Returns the temp workspace root. Vitest workers clean tmp dirs lazily;
 * the OS temp dir handles the rest.
 */
export function copyFixtureToTemp(fixtureName: string): string {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'specbridge-test-'));
  cpSync(fixturePath(fixtureName), tempRoot, { recursive: true });
  return tempRoot;
}

/** A temp directory guaranteed to contain no `.kiro` anywhere upward. */
export function emptyTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'specbridge-empty-'));
}

/** Deterministic clock for workflow tests. */
export const FIXED_NOW = new Date('2026-07-12T10:00:00.000Z');
export const fixedClock = (): Date => FIXED_NOW;

/**
 * Build a schema-valid v0.2 workflow state for tests. Stages default to the
 * canonical order for the type with nothing approved and the first stage
 * draft; pass `stages` overrides to adjust individual entries.
 */
export function testWorkflowState(options: {
  specName: string;
  specType?: ConcreteSpecType;
  workflowMode?: ConcreteWorkflowMode;
  status?: SpecWorkflowState['status'];
  origin?: SpecWorkflowState['origin'];
  stages?: Partial<Record<StageName, Partial<StageApproval>>>;
}): SpecWorkflowState {
  const specType = options.specType ?? 'feature';
  const workflowMode = options.workflowMode ?? 'requirements-first';
  const documentStage: StageName = specType === 'bugfix' ? 'bugfix' : 'requirements';
  const order: StageName[] =
    workflowMode === 'design-first'
      ? ['design', documentStage, 'tasks']
      : [documentStage, 'design', 'tasks'];

  const stages: Record<string, StageApproval> = {};
  order.forEach((stage, index) => {
    const base: StageApproval = {
      status: index === 0 || workflowMode === 'quick' ? 'draft' : 'blocked',
      file: `.kiro/specs/${options.specName}/${stage}.md`,
      approvedAt: null,
      approvedHash: null,
    };
    if (workflowMode === 'quick' && stage === 'tasks') base.status = 'blocked';
    stages[stage] = { ...base, ...(options.stages?.[stage] ?? {}) };
  });

  return {
    schemaVersion: SPEC_STATE_SCHEMA_VERSION,
    specName: options.specName,
    specType,
    workflowMode,
    origin: options.origin ?? 'created-by-specbridge',
    status:
      options.status ??
      (workflowMode === 'quick'
        ? 'READY_FOR_REVIEW'
        : workflowMode === 'design-first'
          ? 'DESIGN_DRAFT'
          : specType === 'bugfix'
            ? 'BUGFIX_DRAFT'
            : 'REQUIREMENTS_DRAFT'),
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    stages: stages as SpecWorkflowState['stages'],
  };
}
