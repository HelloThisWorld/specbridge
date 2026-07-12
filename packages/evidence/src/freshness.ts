import path from 'node:path';
import { runSafeProcess } from '@specbridge/runners';
import type { TaskEvidenceRecord } from './evidence-store.js';

/**
 * Evidence freshness validation.
 *
 * v0.3 evidence proves what happened at the moment it was recorded. Whether
 * it still describes the repository *now* is decided here, deterministically:
 *
 *   - the spec name and task identity must still match
 *   - recorded approved-content hashes must match the currently approved
 *     content (checkbox-normalized for the task plan)
 *   - recorded repository paths must stay inside the repository
 *   - for records that predate the v0.4 `specContext` fields, recorded
 *     approval timestamps are compared instead: a stage (re)approved after
 *     the evidence was evaluated invalidates it
 *
 * Model claims inside a record (`runnerClaims`) are never consulted — they
 * are audit data, not evidence.
 */

export type EvidenceValidity = 'valid' | 'stale' | 'invalid' | 'not-accepted';

/** Machine-readable causes; rules map these to stable diagnostics. */
export type EvidenceReasonCode =
  | 'spec-name-mismatch'
  | 'paths-outside-repository'
  | 'timestamp-unparseable'
  | 'manual-record-malformed'
  | 'task-missing'
  | 'task-identity-changed'
  | 'document-hash-changed'
  | 'design-hash-changed'
  | 'plan-hash-changed'
  | 'stage-not-approved'
  | 'approved-after-evidence'
  | 'history-diverged';

export interface EvidenceReason {
  code: EvidenceReasonCode;
  message: string;
}

export interface EvidenceAssessment {
  record: TaskEvidenceRecord;
  /** Whether the record's status can complete a task at all. */
  accepted: boolean;
  manual: boolean;
  validity: EvidenceValidity;
  /** Why the record is stale or invalid (empty for valid records). */
  reasons: EvidenceReason[];
  /** Non-fatal observations (unknown commit lineage, clock skew). */
  notes: string[];
  /** Recorded changed-file paths that escape the repository (SBV024). */
  pathViolations: string[];
}

export interface CurrentTaskIdentity {
  fingerprint: string;
  title: string;
  /** Raw checkbox line text as it appears in tasks.md right now. */
  rawLineText: string;
  state: string;
}

export interface EvidenceFreshnessContext {
  specName: string;
  /**
   * Currently approved content identity. A field is undefined when the stage
   * is not effectively approved right now — evidence that recorded a hash
   * for it can no longer be validated and reads as stale.
   */
  approved: {
    documentHash?: string;
    designHash?: string;
    /** Plan hash of the currently approved task plan. */
    tasksPlanHash?: string;
  };
  /** Recorded approval timestamps (ISO), for records without specContext. */
  approvedAt: {
    document?: string;
    design?: string;
    tasks?: string;
  };
  /** Current tasks by id. */
  tasks: Map<string, CurrentTaskIdentity>;
  /** Commit ancestry of recorded `headAfter` SHAs relative to current HEAD. */
  ancestry?: Map<string, CommitAncestry>;
  now: Date;
}

const ACCEPTED_STATUSES = new Set(['verified', 'manually-accepted']);
const FUTURE_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/** Repo-relative path check for recorded evidence paths. */
export function evidencePathEscapesRepository(recordedPath: string): boolean {
  if (recordedPath.includes('\0')) return true;
  if (path.isAbsolute(recordedPath) || /^[A-Za-z]:/.test(recordedPath)) return true;
  return recordedPath.split(/[\\/]/).includes('..');
}

const CHECKBOX_STATE_PREFIX = /^([ \t]*[-*+][ \t]+\[)([ xX~-])(\])/;

/** Compare two checkbox lines ignoring only the state character. */
function sameTaskLineIgnoringState(a: string, b: string): boolean {
  const normalize = (text: string): string => {
    const match = CHECKBOX_STATE_PREFIX.exec(text);
    if (match === null || match[1] === undefined || match[3] === undefined) return text;
    return `${match[1]} ${match[3]}${text.slice(match[0].length)}`;
  };
  return normalize(a) === normalize(b);
}

function parseTimestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Assess one evidence record against the current verification context. */
export function assessEvidenceRecord(
  record: TaskEvidenceRecord,
  context: EvidenceFreshnessContext,
): EvidenceAssessment {
  const reasons: EvidenceReason[] = [];
  const notes: string[] = [];
  const pathViolations: string[] = [];
  const accepted = ACCEPTED_STATUSES.has(record.status);
  const manual = record.status === 'manually-accepted';

  // Structural identity and path safety are checked for every record.
  if (record.specName !== context.specName) {
    reasons.push({
      code: 'spec-name-mismatch',
      message: `the record names spec "${record.specName}" but was read for "${context.specName}"`,
    });
  }
  for (const file of record.changedFiles) {
    if (evidencePathEscapesRepository(file.path)) pathViolations.push(file.path);
  }
  if (pathViolations.length > 0) {
    reasons.push({
      code: 'paths-outside-repository',
      message: `recorded changed-file paths escape the repository: ${pathViolations.join(', ')}`,
    });
  }
  const evaluatedAtMs = parseTimestamp(record.evaluatedAt);
  if (evaluatedAtMs === undefined) {
    reasons.push({
      code: 'timestamp-unparseable',
      message: `evaluatedAt "${record.evaluatedAt}" is not a parseable timestamp`,
    });
  } else if (evaluatedAtMs > context.now.getTime() + FUTURE_SKEW_TOLERANCE_MS) {
    notes.push('the record timestamp lies in the future relative to this machine (clock skew?)');
  }
  if (manual && record.manualAcceptance === undefined) {
    reasons.push({
      code: 'manual-record-malformed',
      message: 'status is manually-accepted but no manualAcceptance block is recorded',
    });
  }

  if (reasons.length > 0) {
    return { record, accepted, manual, validity: 'invalid', reasons, notes, pathViolations };
  }

  if (!accepted) {
    return { record, accepted, manual, validity: 'not-accepted', reasons, notes, pathViolations };
  }

  // ---- Freshness (only meaningful for accepted records) -------------------
  const stale: EvidenceReason[] = [];

  const currentTask = context.tasks.get(record.taskId);
  if (currentTask === undefined) {
    stale.push({
      code: 'task-missing',
      message: `task ${record.taskId} no longer exists in tasks.md`,
    });
  } else if (record.specContext?.taskFingerprint !== undefined) {
    if (record.specContext.taskFingerprint !== currentTask.fingerprint) {
      stale.push({
        code: 'task-identity-changed',
        message:
          "the task's text, numbering, or requirement references changed since the evidence was recorded",
      });
    }
  } else if (record.specContext?.taskText !== undefined) {
    if (!sameTaskLineIgnoringState(record.specContext.taskText, currentTask.rawLineText)) {
      stale.push({
        code: 'task-identity-changed',
        message: 'the task line text changed since the evidence was recorded',
      });
    }
  }

  const specContext = record.specContext;
  if (specContext !== undefined) {
    const hashChecks: {
      recorded: string | undefined;
      current: string | undefined;
      code: EvidenceReasonCode;
      what: string;
    }[] = [
      {
        recorded: specContext.documentHash,
        current: context.approved.documentHash,
        code: 'document-hash-changed',
        what: 'the approved requirements/bugfix document',
      },
      {
        recorded: specContext.designHash,
        current: context.approved.designHash,
        code: 'design-hash-changed',
        what: 'the approved design',
      },
      {
        recorded: specContext.tasksPlanHash,
        current: context.approved.tasksPlanHash,
        code: 'plan-hash-changed',
        what: 'the approved task plan',
      },
    ];
    for (const { recorded, current, code, what } of hashChecks) {
      if (recorded === undefined) continue;
      if (current === undefined) {
        stale.push({
          code: 'stage-not-approved',
          message: `${what} is no longer effectively approved`,
        });
      } else if (recorded !== current) {
        stale.push({ code, message: `${what} changed since the evidence was recorded` });
      }
    }
  } else {
    // Legacy record (v0.3): compare recorded approval timestamps instead.
    // A stage approved AFTER the evidence was evaluated means the spec the
    // evidence verified is not the spec that is approved now.
    const referenceMs =
      record.manualAcceptance !== undefined
        ? (parseTimestamp(record.manualAcceptance.acceptedAt) ?? evaluatedAtMs)
        : evaluatedAtMs;
    const timestampChecks: [string | undefined, string][] = [
      [context.approvedAt.document, 'requirements/bugfix'],
      [context.approvedAt.design, 'design'],
      [context.approvedAt.tasks, 'tasks'],
    ];
    for (const [approvedAt, stage] of timestampChecks) {
      if (approvedAt === undefined || referenceMs === undefined) continue;
      const approvedMs = parseTimestamp(approvedAt);
      if (approvedMs !== undefined && approvedMs > referenceMs) {
        stale.push({
          code: 'approved-after-evidence',
          message: `the ${stage} stage was (re)approved after this evidence was recorded`,
        });
      }
    }
  }

  const headAfter = record.repository.headAfter;
  if (headAfter !== undefined && context.ancestry !== undefined) {
    const ancestry = context.ancestry.get(headAfter);
    if (ancestry === 'not-ancestor') {
      stale.push({
        code: 'history-diverged',
        message: `the recorded commit ${headAfter.slice(0, 12)} is not an ancestor of the current HEAD (history diverged)`,
      });
    } else if (ancestry === 'unknown') {
      notes.push(
        `the recorded commit ${headAfter.slice(0, 12)} cannot be resolved in this clone (shallow history?)`,
      );
    }
  }

  return {
    record,
    accepted,
    manual,
    validity: stale.length > 0 ? 'stale' : 'valid',
    reasons: stale,
    notes,
    pathViolations,
  };
}

export interface TaskEvidenceAssessment {
  taskId: string;
  /** Assessment of the newest accepted record, when one exists. */
  best?: EvidenceAssessment;
  all: EvidenceAssessment[];
  /** Summary bucket for reports. `valid` includes manual acceptance. */
  bucket: 'valid' | 'stale' | 'invalid' | 'missing';
}

/**
 * Assess all records of one task (records ordered oldest-first, as returned
 * by the evidence store). The newest accepted record decides the bucket.
 */
export function assessTaskEvidence(
  taskId: string,
  records: readonly TaskEvidenceRecord[],
  context: EvidenceFreshnessContext,
): TaskEvidenceAssessment {
  const all = records.map((record) => assessEvidenceRecord(record, context));
  const acceptedAssessments = all.filter((assessment) => assessment.accepted);
  const best = acceptedAssessments[acceptedAssessments.length - 1];
  if (best === undefined) {
    return { taskId, all, bucket: 'missing' };
  }
  const bucket =
    best.validity === 'valid' ? 'valid' : best.validity === 'stale' ? 'stale' : 'invalid';
  return { taskId, best, all, bucket };
}

export type CommitAncestry = 'ancestor' | 'not-ancestor' | 'unknown';

const GIT_TIMEOUT_MS = 30_000;
const SHA_PATTERN = /^[0-9a-f]{4,64}$/i;

/**
 * Resolve whether each recorded commit is an ancestor of the current HEAD.
 * Read-only `git merge-base --is-ancestor` per unique SHA; unresolvable SHAs
 * (shallow clones, garbage-collected history) come back as `unknown`.
 */
export async function resolveCommitAncestry(
  workspaceRoot: string,
  shas: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, CommitAncestry>> {
  const result = new Map<string, CommitAncestry>();
  for (const sha of new Set(shas)) {
    if (!SHA_PATTERN.test(sha)) {
      result.set(sha, 'unknown');
      continue;
    }
    const processResult = await runSafeProcess({
      executable: 'git',
      argv: ['merge-base', '--is-ancestor', sha, 'HEAD'],
      cwd: workspaceRoot,
      timeoutMs: GIT_TIMEOUT_MS,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (processResult.status === 'ok') {
      result.set(sha, 'ancestor');
    } else if (
      processResult.status === 'nonzero-exit' &&
      processResult.observation.exitCode === 1
    ) {
      result.set(sha, 'not-ancestor');
    } else {
      result.set(sha, 'unknown');
    }
  }
  return result;
}

/**
 * True when a passing result for the named trusted command can be reused
 * from evidence instead of re-running it: the assessment must be valid, the
 * command must have passed, and the recorded repository state must be the
 * exact current HEAD (anything newer could have broken it).
 */
export function reusableCommandPass(
  assessments: readonly EvidenceAssessment[],
  commandName: string,
  currentHeadSha: string | undefined,
): TaskEvidenceRecord | undefined {
  if (currentHeadSha === undefined) return undefined;
  for (let i = assessments.length - 1; i >= 0; i -= 1) {
    const assessment = assessments[i];
    if (assessment === undefined || assessment.validity !== 'valid') continue;
    const { record } = assessment;
    if (record.repository.headAfter !== currentHeadSha) continue;
    const command = record.verificationCommands.find(
      (candidate) => candidate.name === commandName && candidate.passed,
    );
    if (command !== undefined) return record;
  }
  return undefined;
}
