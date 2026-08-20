import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { WorkspaceInfo } from '@specbridge/core';
import { assertInsideWorkspace, writeFileAtomic } from '@specbridge/core';
import { OrchestrationError } from '../errors.js';
import { jobDir } from '../jobs/store.js';
import type {
  CandidateArtifact,
  ContextProjection,
  ContractConflict,
  EvaluationRecord,
  ObjectiveWorkerRecord,
  WorkGraph,
} from './state.js';
import {
  candidateArtifactSchema,
  contextProjectionSchema,
  contractConflictSchema,
  evaluationRecordSchema,
  objectiveWorkerRecordSchema,
  workGraphSchema,
} from './state.js';

/**
 * Objective-runtime persistence:
 * `.specbridge/jobs/<jobId>/objectives/<nodeId>/`.
 *
 *   workgraphs/<n>.json          work-graph revisions (append-only; the
 *                                current revision is rewritten atomically
 *                                for unit-status progress, like job graphs)
 *   projections/<wu>-a<n>.json   immutable context projections
 *   candidates/<wu>-a<n>.json    candidate artifacts (immutable)
 *   candidates/<wu>-a<n>.patch   the normalized diff (immutable)
 *   evaluations/<wu>-a<n>-<k>.json  evaluation records (immutable)
 *   conflicts/<id>.json          contract conflicts (status-controlled)
 *   workers/<wu>-a<n>-<role>.json   worker identity records (status-controlled)
 *   reports/<name>.json          aggregation reports (immutable)
 *
 * Same guarantees as every other store: path-checked, atomic, append-only
 * where history matters, reads never mutate, corrupt records preserved.
 */

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function assertSegment(value: string, what: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new OrchestrationError('SBO040', `Invalid ${what} "${value}".`);
  }
  return value;
}

export function objectiveDir(workspace: WorkspaceInfo, jobId: string, nodeId: string): string {
  assertSegment(nodeId, 'objective node id');
  return assertInsideWorkspace(
    workspace.rootDir,
    path.join(jobDir(workspace, jobId), 'objectives', nodeId),
  );
}

function artifactPath(
  workspace: WorkspaceInfo,
  jobId: string,
  nodeId: string,
  ...segments: string[]
): string {
  return assertInsideWorkspace(
    workspace.rootDir,
    path.join(objectiveDir(workspace, jobId, nodeId), ...segments),
  );
}

function readJson<T>(file: string, parse: (raw: unknown) => T | undefined): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Work graphs
// ---------------------------------------------------------------------------

function workGraphFile(
  workspace: WorkspaceInfo,
  jobId: string,
  nodeId: string,
  revision: number,
): string {
  return artifactPath(workspace, jobId, nodeId, 'workgraphs', `${String(revision).padStart(4, '0')}.json`);
}

/**
 * Persist a work graph. A NEW revision number lands in a new file
 * (append-only history); progress within the current revision rewrites its
 * file atomically.
 */
export function storeWorkGraph(
  workspace: WorkspaceInfo,
  jobId: string,
  graph: WorkGraph,
): WorkGraph {
  const validated = workGraphSchema.parse(graph);
  const file = workGraphFile(workspace, jobId, validated.objectiveNodeId, validated.revision);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(validated, null, 2)}\n`);
  return validated;
}

export function readWorkGraph(
  workspace: WorkspaceInfo,
  jobId: string,
  nodeId: string,
  revision: number,
): WorkGraph | undefined {
  if (!Number.isInteger(revision) || revision < 1) return undefined;
  return readJson(workGraphFile(workspace, jobId, nodeId, revision), (raw) => {
    const result = workGraphSchema.safeParse(raw);
    return result.success ? result.data : undefined;
  });
}

/** Every stored revision number, ascending. */
export function listWorkGraphRevisions(
  workspace: WorkspaceInfo,
  jobId: string,
  nodeId: string,
): number[] {
  const dir = artifactPath(workspace, jobId, nodeId, 'workgraphs');
  if (!existsSync(dir)) return [];
  const revisions: number[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!/^\d{4}\.json$/.test(name)) continue;
    revisions.push(Number.parseInt(name.slice(0, 4), 10));
  }
  return revisions;
}

/** The latest stored work graph for one objective, when any exists. */
export function readLatestWorkGraph(
  workspace: WorkspaceInfo,
  jobId: string,
  nodeId: string,
): WorkGraph | undefined {
  const revisions = listWorkGraphRevisions(workspace, jobId, nodeId);
  const latest = revisions.at(-1);
  return latest === undefined ? undefined : readWorkGraph(workspace, jobId, nodeId, latest);
}

export function requireWorkGraph(
  workspace: WorkspaceInfo,
  jobId: string,
  nodeId: string,
  revision: number,
): WorkGraph {
  const graph = readWorkGraph(workspace, jobId, nodeId, revision);
  if (graph === undefined) {
    throw new OrchestrationError(
      'SBO039',
      `Work graph revision ${revision} for objective ${nodeId} is missing or unreadable.`,
    );
  }
  return graph;
}

// ---------------------------------------------------------------------------
// Context projections (immutable)
// ---------------------------------------------------------------------------

function projectionName(workUnitId: string, attempt: number): string {
  return `${workUnitId}-a${String(attempt).padStart(2, '0')}.json`;
}

export function storeProjection(
  workspace: WorkspaceInfo,
  jobId: string,
  nodeId: string,
  projection: ContextProjection,
): { projection: ContextProjection; ref: string } {
  const validated = contextProjectionSchema.parse(projection);
  assertSegment(validated.workUnitId, 'work unit id');
  const name = projectionName(validated.workUnitId, validated.attempt);
  const file = artifactPath(workspace, jobId, nodeId, 'projections', name);
  if (existsSync(file)) {
    throw new OrchestrationError(
      'SBO041',
      `Projection ${name} already exists; projections are immutable per (workUnit, attempt).`,
    );
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(validated, null, 2)}\n`);
  return { projection: validated, ref: `projections/${name}` };
}

export function readProjection(
  workspace: WorkspaceInfo,
  jobId: string,
  nodeId: string,
  workUnitId: string,
  attempt: number,
): ContextProjection | undefined {
  if (!ID_PATTERN.test(workUnitId) || !Number.isInteger(attempt) || attempt < 1) return undefined;
  return readJson(
    artifactPath(workspace, jobId, nodeId, 'projections', projectionName(workUnitId, attempt)),
    (raw) => {
      const result = contextProjectionSchema.safeParse(raw);
      return result.success ? result.data : undefined;
    },
  );
}

// ---------------------------------------------------------------------------
// Candidate artifacts (immutable)
// ---------------------------------------------------------------------------

function candidateName(workUnitId: string, attempt: number): string {
  return `${workUnitId}-a${String(attempt).padStart(2, '0')}`;
}

export function storeCandidate(
  workspace: WorkspaceInfo,
  jobId: string,
  nodeId: string,
  candidate: CandidateArtifact,
  patch: string | undefined,
  limits: { maxCandidateBytes: number },
): { candidate: CandidateArtifact; ref: string } {
  const validated = candidateArtifactSchema.parse(candidate);
  assertSegment(validated.workUnitId, 'work unit id');
  const base = candidateName(validated.workUnitId, validated.attempt);
  const file = artifactPath(workspace, jobId, nodeId, 'candidates', `${base}.json`);
  if (existsSync(file)) {
    throw new OrchestrationError(
      'SBO043',
      `Candidate ${base} already exists; candidates are immutable per (workUnit, attempt).`,
    );
  }
  mkdirSync(path.dirname(file), { recursive: true });
  if (patch !== undefined) {
    if (Buffer.byteLength(patch, 'utf8') > limits.maxCandidateBytes) {
      throw new OrchestrationError(
        'SBO043',
        `The candidate patch for ${base} exceeds the ${limits.maxCandidateBytes}-byte bound and was refused.`,
        { remediation: ['Split the work unit, or raise orchestration.jobs.objectives.maxCandidateBytes explicitly.'] },
      );
    }
    writeFileAtomic(artifactPath(workspace, jobId, nodeId, 'candidates', `${base}.patch`), patch);
  }
  writeFileAtomic(file, `${JSON.stringify(validated, null, 2)}\n`);
  return { candidate: validated, ref: `candidates/${base}.json` };
}

export function readCandidate(
  workspace: WorkspaceInfo,
  jobId: string,
  nodeId: string,
  workUnitId: string,
  attempt: number,
): CandidateArtifact | undefined {
  if (!ID_PATTERN.test(workUnitId) || !Number.isInteger(attempt) || attempt < 1) return undefined;
  return readJson(
    artifactPath(workspace, jobId, nodeId, 'candidates', `${candidateName(workUnitId, attempt)}.json`),
    (raw) => {
      const result = candidateArtifactSchema.safeParse(raw);
      return result.success ? result.data : undefined;
    },
  );
}

export function readCandidatePatch(
  workspace: WorkspaceInfo,
  jobId: string,
  nodeId: string,
  workUnitId: string,
  attempt: number,
): string | undefined {
  if (!ID_PATTERN.test(workUnitId) || !Number.isInteger(attempt) || attempt < 1) return undefined;
  const file = artifactPath(
    workspace,
    jobId,
    nodeId,
    'candidates',
    `${candidateName(workUnitId, attempt)}.patch`,
  );
  if (!existsSync(file)) return undefined;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Evaluation records (immutable)
// ---------------------------------------------------------------------------

export function storeEvaluation(
  workspace: WorkspaceInfo,
  jobId: string,
  nodeId: string,
  evaluation: EvaluationRecord,
): { evaluation: EvaluationRecord; ref: string } {
  const validated = evaluationRecordSchema.parse(evaluation);
  assertSegment(validated.evaluationId, 'evaluation id');
  const name = `${validated.evaluationId}.json`;
  const file = artifactPath(workspace, jobId, nodeId, 'evaluations', name);
  if (existsSync(file)) {
    throw new OrchestrationError('SBO044', `Evaluation ${validated.evaluationId} already exists.`);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(validated, null, 2)}\n`);
  return { evaluation: validated, ref: `evaluations/${name}` };
}

export function readEvaluations(
  workspace: WorkspaceInfo,
  jobId: string,
  nodeId: string,
  workUnitId?: string,
): EvaluationRecord[] {
  const dir = artifactPath(workspace, jobId, nodeId, 'evaluations');
  if (!existsSync(dir)) return [];
  const records: EvaluationRecord[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const record = readJson(path.join(dir, name), (raw) => {
      const result = evaluationRecordSchema.safeParse(raw);
      return result.success ? result.data : undefined;
    });
    if (record !== undefined && (workUnitId === undefined || record.workUnitId === workUnitId)) {
      records.push(record);
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Contract conflicts (status-controlled)
// ---------------------------------------------------------------------------

export function storeConflict(
  workspace: WorkspaceInfo,
  jobId: string,
  nodeId: string,
  conflict: ContractConflict,
): ContractConflict {
  const validated = contractConflictSchema.parse(conflict);
  assertSegment(validated.conflictId, 'conflict id');
  const file = artifactPath(workspace, jobId, nodeId, 'conflicts', `${validated.conflictId}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(validated, null, 2)}\n`);
  return validated;
}

export function readConflicts(
  workspace: WorkspaceInfo,
  jobId: string,
  nodeId: string,
): ContractConflict[] {
  const dir = artifactPath(workspace, jobId, nodeId, 'conflicts');
  if (!existsSync(dir)) return [];
  const records: ContractConflict[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const record = readJson(path.join(dir, name), (raw) => {
      const result = contractConflictSchema.safeParse(raw);
      return result.success ? result.data : undefined;
    });
    if (record !== undefined) records.push(record);
  }
  return records;
}

// ---------------------------------------------------------------------------
// Worker records (status-controlled)
// ---------------------------------------------------------------------------

function workerName(workUnitId: string, attempt: number, role: string): string {
  return `${workUnitId}-a${String(attempt).padStart(2, '0')}-${role.toLowerCase()}.json`;
}

export function storeWorkerRecord(
  workspace: WorkspaceInfo,
  jobId: string,
  nodeId: string,
  record: ObjectiveWorkerRecord,
): ObjectiveWorkerRecord {
  const validated = objectiveWorkerRecordSchema.parse(record);
  assertSegment(validated.workUnitId, 'work unit id');
  const file = artifactPath(
    workspace,
    jobId,
    nodeId,
    'workers',
    workerName(validated.workUnitId, validated.attempt, validated.agentRole),
  );
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(validated, null, 2)}\n`);
  return validated;
}

export function readWorkerRecord(
  workspace: WorkspaceInfo,
  jobId: string,
  nodeId: string,
  workUnitId: string,
  attempt: number,
  role: string,
): ObjectiveWorkerRecord | undefined {
  if (!ID_PATTERN.test(workUnitId) || !Number.isInteger(attempt) || attempt < 1) return undefined;
  return readJson(
    artifactPath(workspace, jobId, nodeId, 'workers', workerName(workUnitId, attempt, role)),
    (raw) => {
      const result = objectiveWorkerRecordSchema.safeParse(raw);
      return result.success ? result.data : undefined;
    },
  );
}

export function readWorkerRecords(
  workspace: WorkspaceInfo,
  jobId: string,
  nodeId: string,
): ObjectiveWorkerRecord[] {
  const dir = artifactPath(workspace, jobId, nodeId, 'workers');
  if (!existsSync(dir)) return [];
  const records: ObjectiveWorkerRecord[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const record = readJson(path.join(dir, name), (raw) => {
      const result = objectiveWorkerRecordSchema.safeParse(raw);
      return result.success ? result.data : undefined;
    });
    if (record !== undefined) records.push(record);
  }
  return records;
}

// ---------------------------------------------------------------------------
// Aggregation reports (immutable)
// ---------------------------------------------------------------------------

export function storeAggregationReport(
  workspace: WorkspaceInfo,
  jobId: string,
  nodeId: string,
  name: string,
  report: Record<string, unknown>,
): { ref: string } {
  assertSegment(name, 'report name');
  const file = artifactPath(workspace, jobId, nodeId, 'reports', `${name}.json`);
  if (existsSync(file)) {
    throw new OrchestrationError('SBO046', `Aggregation report "${name}" already exists.`);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(report, null, 2)}\n`);
  return { ref: `reports/${name}.json` };
}

export function readAggregationReport(
  workspace: WorkspaceInfo,
  jobId: string,
  nodeId: string,
  name: string,
): Record<string, unknown> | undefined {
  if (!ID_PATTERN.test(name)) return undefined;
  return readJson(artifactPath(workspace, jobId, nodeId, 'reports', `${name}.json`), (raw) =>
    raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined,
  );
}

/** Objective node ids that have any objective-runtime state for a job. */
export function listObjectiveNodes(workspace: WorkspaceInfo, jobId: string): string[] {
  const dir = path.join(jobDir(workspace, jobId), 'objectives');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}
