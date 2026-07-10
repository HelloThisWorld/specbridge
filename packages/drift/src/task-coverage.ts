import type { TasksModel } from '@specbridge/compat-kiro';
import type { TaskEvidence } from './evidence.js';
import type { DriftFinding } from './drift-report.js';

/**
 * Task coverage: compare checkbox states in tasks.md against recorded
 * evidence. Deterministic assessment buckets, matching the sync command's
 * vocabulary:
 *
 *   - verified:                checked and verified evidence exists
 *   - implemented-unverified:  evidence exists but is not verified, or the
 *                              checkbox disagrees with the evidence
 *   - likely-incomplete:       checked but no evidence at all
 *   - unknown:                 unchecked and no evidence (normal for open work)
 */

export type TaskAssessment = 'verified' | 'implemented-unverified' | 'likely-incomplete' | 'unknown';

export interface TaskCoverageEntry {
  taskId: string;
  title: string;
  checkboxState: string;
  assessment: TaskAssessment;
  evidence?: TaskEvidence;
}

export interface TaskCoverageResult {
  entries: TaskCoverageEntry[];
  findings: DriftFinding[];
}

export function assessTaskCoverage(
  tasks: TasksModel,
  evidenceRecords: TaskEvidence[],
): TaskCoverageResult {
  const byTaskId = new Map<string, TaskEvidence>();
  for (const record of evidenceRecords) byTaskId.set(record.taskId, record);

  const entries: TaskCoverageEntry[] = [];
  const findings: DriftFinding[] = [];

  for (const task of tasks.allTasks) {
    // Parent tasks aggregate children; only leaves need direct evidence.
    if (task.children.length > 0) continue;

    const evidence = byTaskId.get(task.id) ?? (task.number !== undefined ? byTaskId.get(task.number) : undefined);
    let assessment: TaskAssessment;

    if (task.state === 'done') {
      if (evidence !== undefined && evidence.status === 'verified') {
        assessment = 'verified';
        findings.push({
          category: 'task-evidence',
          severity: 'pass',
          message: `Task ${task.id} is complete and has verified evidence.`,
          related: { taskId: task.id },
        });
      } else if (evidence !== undefined) {
        assessment = 'implemented-unverified';
        findings.push({
          category: 'task-evidence',
          severity: 'warn',
          message: `Task ${task.id} is marked complete but its evidence is not verified.`,
          related: { taskId: task.id },
        });
      } else {
        assessment = 'likely-incomplete';
        findings.push({
          category: 'task-evidence',
          severity: 'fail',
          message: `Task ${task.id} is marked complete but no evidence record exists.`,
          related: { taskId: task.id },
        });
      }
    } else if (evidence !== undefined && evidence.status !== 'rejected') {
      assessment = 'implemented-unverified';
      findings.push({
        category: 'checkbox-state',
        severity: 'warn',
        message: `Task ${task.id} has evidence but its checkbox is still "${task.state}".`,
        related: { taskId: task.id },
      });
    } else {
      assessment = 'unknown';
    }

    entries.push({
      taskId: task.id,
      title: task.title,
      checkboxState: task.state,
      assessment,
      ...(evidence !== undefined ? { evidence } : {}),
    });
  }

  return { entries, findings };
}
