import type { MarkdownDocument, TaskItem, TasksModel } from '@specbridge/compat-kiro';
import { findTask } from '@specbridge/compat-kiro';

/**
 * Task identity and selection for execution.
 *
 * Task IDs come from the explicit numbering in tasks.md (`1`, `1.2`,
 * `2.3.1`); a task without a number gets the parser's deterministic
 * synthetic id (`line:<n>`, 1-based) — used for reading and reporting only,
 * never written back into the Markdown.
 *
 * Only executable leaf tasks are selectable: a parent task with children is
 * a grouping, not one unit of implementation.
 */

export interface SelectedTask {
  /** Stable id: the explicit number when present, else the synthetic id. */
  id: string;
  number?: string;
  title: string;
  /** 0-based line index of the checkbox line. */
  line: number;
  /** Exact current line text — re-checked before any checkbox update. */
  rawLineText: string;
  state: TaskItem['state'];
  optional: boolean;
  isLeaf: boolean;
  parentId?: string;
  childIds: string[];
  requirementRefs: string[];
}

export type TaskSelectionFailure =
  | { ok: false; reason: 'task-not-found'; message: string }
  | { ok: false; reason: 'task-already-complete'; message: string }
  | { ok: false; reason: 'task-not-leaf'; message: string; childIds: string[] }
  | { ok: false; reason: 'no-open-tasks'; message: string };

export type TaskSelectionResult = { ok: true; task: SelectedTask } | TaskSelectionFailure;

function toSelected(model: TasksModel, document: MarkdownDocument, task: TaskItem): SelectedTask {
  const parent = model.allTasks.find((candidate) => candidate.children.includes(task));
  return {
    id: task.id,
    ...(task.number !== undefined ? { number: task.number } : {}),
    title: task.title,
    line: task.line,
    rawLineText: document.lineAt(task.line).text,
    state: task.state,
    optional: task.optional,
    isLeaf: task.children.length === 0,
    ...(parent !== undefined ? { parentId: parent.id } : {}),
    childIds: task.children.map((child) => child.id),
    requirementRefs: [...task.requirementRefs],
  };
}

/** Incomplete required leaf tasks in document order (the `--all` work list). */
export function openRequiredLeafTasks(
  model: TasksModel,
  document: MarkdownDocument,
): SelectedTask[] {
  return model.allTasks
    .filter((task) => task.state === 'open' && task.children.length === 0 && !task.optional)
    .map((task) => toSelected(model, document, task));
}

export interface TaskSelector {
  /** Explicit task id (`--task 2.3`). */
  taskId?: string;
  /** Pick the next open required leaf task (default behavior). */
  next?: boolean;
}

export function selectTask(
  model: TasksModel,
  document: MarkdownDocument,
  selector: TaskSelector,
): TaskSelectionResult {
  if (selector.taskId !== undefined) {
    const task = findTask(model, selector.taskId);
    if (task === undefined) {
      const known = model.allTasks
        .map((candidate) => candidate.number ?? candidate.id)
        .slice(0, 30);
      return {
        ok: false,
        reason: 'task-not-found',
        message:
          `Task "${selector.taskId}" was not found in tasks.md. ` +
          (known.length > 0 ? `Known task ids: ${known.join(', ')}.` : 'The task list is empty.'),
      };
    }
    if (task.children.length > 0) {
      return {
        ok: false,
        reason: 'task-not-leaf',
        message:
          `Task ${task.id} has sub-tasks and is not executed as one implementation task. ` +
          `Run one of its sub-tasks instead: ${task.children.map((child) => child.id).join(', ')}.`,
        childIds: task.children.map((child) => child.id),
      };
    }
    if (task.state === 'done') {
      return {
        ok: false,
        reason: 'task-already-complete',
        message: `Task ${task.id} is already complete ([x]). Pick an open task or run with --next.`,
      };
    }
    return { ok: true, task: toSelected(model, document, task) };
  }

  // Default / --next: first open REQUIRED leaf task in document order.
  const next = openRequiredLeafTasks(model, document)[0];
  if (next === undefined) {
    return {
      ok: false,
      reason: 'no-open-tasks',
      message: 'No open required leaf task remains in tasks.md.',
    };
  }
  return { ok: true, task: next };
}

/** Open required leaf tasks that appear before `task` in document order. */
export function openPredecessors(
  model: TasksModel,
  document: MarkdownDocument,
  task: SelectedTask,
): SelectedTask[] {
  return openRequiredLeafTasks(model, document).filter(
    (candidate) => candidate.line < task.line && candidate.id !== task.id,
  );
}
