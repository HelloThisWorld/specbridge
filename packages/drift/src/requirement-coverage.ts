import type { RequirementsModel, TasksModel } from '@specbridge/compat-kiro';
import type { DriftFinding } from './drift-report.js';

/**
 * Requirement coverage: every acceptance criterion should be referenced by
 * at least one task (`_Requirements: 1.2, 2.1_`). A reference to a whole
 * requirement id (e.g. `1`) covers all of its criteria.
 */

export interface RequirementCoverageResult {
  findings: DriftFinding[];
  coveredCriterionIds: string[];
  uncoveredCriterionIds: string[];
  /** Tasks with no requirement references, when linking is in use at all. */
  unlinkedTaskIds: string[];
}

export function assessRequirementCoverage(
  requirements: RequirementsModel,
  tasks: TasksModel,
): RequirementCoverageResult {
  const findings: DriftFinding[] = [];
  const referenced = new Set<string>();
  for (const task of tasks.allTasks) {
    for (const ref of task.requirementRefs) referenced.add(ref);
  }

  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const requirement of requirements.requirements) {
    for (const criterion of requirement.criteria) {
      const isCovered = referenced.has(criterion.id) || referenced.has(requirement.id);
      if (isCovered) {
        covered.push(criterion.id);
        findings.push({
          category: 'requirement-coverage',
          severity: 'pass',
          message: `Criterion ${criterion.id} is referenced by at least one task.`,
          related: { requirementId: criterion.id },
        });
      } else {
        uncovered.push(criterion.id);
        findings.push({
          category: 'requirement-coverage',
          severity: 'warn',
          message: `Criterion ${criterion.id} is not referenced by any task.`,
          related: { requirementId: criterion.id },
        });
      }
    }
  }

  // Only flag unlinked tasks when the spec uses linking at all; otherwise
  // the whole file simply predates the convention.
  const unlinkedTaskIds: string[] = [];
  const linkingInUse = tasks.allTasks.some((task) => task.requirementRefs.length > 0);
  if (linkingInUse) {
    for (const task of tasks.allTasks) {
      // Parent tasks often delegate references to their children.
      if (task.requirementRefs.length === 0 && task.children.length === 0) {
        unlinkedTaskIds.push(task.id);
        findings.push({
          category: 'task-linking',
          severity: 'info',
          message: `Task ${task.id} has no requirement references while other tasks do.`,
          related: { taskId: task.id },
        });
      }
    }
  }

  return {
    findings,
    coveredCriterionIds: covered,
    uncoveredCriterionIds: uncovered,
    unlinkedTaskIds,
  };
}
