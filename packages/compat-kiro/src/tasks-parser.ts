import type { Diagnostic, TaskProgress } from '@specbridge/core';
import type { MarkdownDocument } from './markdown-document.js';

/**
 * Tolerant tasks.md parser.
 *
 * Recognizes the documented Kiro checkbox format:
 *
 *   - [ ] 1. Top-level task
 *     - [x] 1.1 Nested sub-task
 *       - Detail bullet
 *       - _Requirements: 1.2, 2.1_
 *   - [ ]* 2. Optional task
 *
 * Tolerances: any bullet marker (-, *, +), tab or space indentation, flat or
 * indented sub-task numbering, unnumbered tasks, unusual checkbox characters
 * (reported, never rewritten), and arbitrary prose between tasks. Content in
 * fenced code blocks is ignored. Nothing outside a targeted checkbox line is
 * ever modified.
 */

export type TaskCheckboxState = 'open' | 'done' | 'in-progress' | 'unknown';

export interface TaskItem {
  /** Explicit number (e.g. `2.1`) when present, otherwise `line:<n>` (1-based). */
  id: string;
  number?: string;
  title: string;
  /** 0-based line index of the checkbox line. */
  line: number;
  indent: number;
  state: TaskCheckboxState;
  /** The raw character found between the brackets. */
  stateChar: string;
  optional: boolean;
  requirementRefs: string[];
  children: TaskItem[];
}

export interface TasksModel {
  filePath?: string;
  title?: string;
  /** Top-level tasks with nested children. */
  tasks: TaskItem[];
  /** Every task in document order (flattened). */
  allTasks: TaskItem[];
  progress: TaskProgress;
  diagnostics: Diagnostic[];
}

const CHECKBOX = /^([ \t]*)([-*+])[ \t]+\[([^\]]?)\](\*)?[ \t]*(.*)$/;
const CHECKBOX_PROBE = /^[ \t]*[-*+][ \t]+\[([^\]]*)\]/;
const NUMBER_PREFIX = /^(\d+(?:\.\d+)*)[.)]?[ \t]+(.*)$/;
const REQUIREMENT_REF = /_[ \t]*requirements?[ \t]*:[ \t]*([^_]*)_/i;

function stateForChar(char: string): TaskCheckboxState {
  if (char === ' ' || char === '') return 'open';
  if (char === 'x' || char === 'X') return 'done';
  if (char === '-' || char === '~') return 'in-progress';
  return 'unknown';
}

function indentWidth(indent: string): number {
  let width = 0;
  for (const char of indent) width += char === '\t' ? 4 : 1;
  return width;
}

export function parseTasks(document: MarkdownDocument): TasksModel {
  const diagnostics: Diagnostic[] = [];
  const mask = document.codeFenceMask();
  const allTasks: TaskItem[] = [];
  const roots: TaskItem[] = [];
  const stack: { indent: number; task: TaskItem }[] = [];
  const numbersSeen = new Map<string, number>();

  for (let i = 0; i < document.lineCount; i += 1) {
    if (mask[i] === true) continue;
    const text = document.lineAt(i).text;
    const match = CHECKBOX.exec(text);

    if (match === null) {
      // Detect near-miss checkboxes like `- [ x]` or `- []` so users learn
      // why a task was not counted. Regular links `- [text](url)` are fine.
      const probe = CHECKBOX_PROBE.exec(text);
      if (probe !== null) {
        const inner = probe[1] ?? '';
        const looksLikeCheckbox = inner.trim() === '' || /^[ \txX~-]+$/.test(inner);
        if (looksLikeCheckbox && inner.length !== 1) {
          diagnostics.push({
            severity: 'warning',
            code: 'TASKS_MALFORMED_CHECKBOX',
            message: `Unrecognized checkbox syntax "[${inner}]"; this line is preserved but not counted as a task.`,
            ...(document.filePath !== undefined ? { file: document.filePath } : {}),
            line: i + 1,
          });
        }
      }
      // Requirement references live on detail lines below a task.
      if (allTasks.length > 0) {
        const refMatch = REQUIREMENT_REF.exec(text);
        if (refMatch !== null) {
          const owner = allTasks[allTasks.length - 1];
          if (owner !== undefined) {
            const refs = (refMatch[1] ?? '')
              .split(',')
              .map((ref) => ref.trim())
              .filter((ref) => ref.length > 0);
            owner.requirementRefs.push(...refs);
          }
        }
      }
      continue;
    }

    const indentText = match[1] ?? '';
    const stateChar = match[3] ?? '';
    const optionalMarker = match[4] === '*';
    const rest = (match[5] ?? '').trim();

    if (stateChar === '') {
      diagnostics.push({
        severity: 'warning',
        code: 'TASKS_MALFORMED_CHECKBOX',
        message: 'Empty checkbox brackets "[]"; this line is preserved but not counted as a task.',
        ...(document.filePath !== undefined ? { file: document.filePath } : {}),
        line: i + 1,
      });
      continue;
    }

    const state = stateForChar(stateChar);
    if (state === 'unknown') {
      diagnostics.push({
        severity: 'info',
        code: 'TASKS_UNKNOWN_CHECKBOX_STATE',
        message: `Unrecognized checkbox state "[${stateChar}]"; treated as unknown and preserved as-is.`,
        ...(document.filePath !== undefined ? { file: document.filePath } : {}),
        line: i + 1,
      });
    }

    const numberMatch = NUMBER_PREFIX.exec(rest);
    const number = numberMatch?.[1];
    const title = (numberMatch?.[2] ?? rest).trim();
    const optional = optionalMarker || /\(optional\)/i.test(rest);

    const task: TaskItem = {
      id: number ?? `line:${i + 1}`,
      ...(number !== undefined ? { number } : {}),
      title,
      line: i,
      indent: indentWidth(indentText),
      state,
      stateChar,
      optional,
      requirementRefs: [],
      children: [],
    };

    if (number !== undefined) {
      const previousLine = numbersSeen.get(number);
      if (previousLine !== undefined) {
        diagnostics.push({
          severity: 'warning',
          code: 'TASKS_DUPLICATE_NUMBER',
          message: `Task number ${number} appears more than once (also on line ${previousLine}).`,
          ...(document.filePath !== undefined ? { file: document.filePath } : {}),
          line: i + 1,
        });
      } else {
        numbersSeen.set(number, i + 1);
      }
    }

    while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) >= task.indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1]?.task;
    if (parent !== undefined) parent.children.push(task);
    else roots.push(task);
    stack.push({ indent: task.indent, task });
    allTasks.push(task);
  }

  const progress: TaskProgress = {
    total: 0,
    completed: 0,
    inProgress: 0,
    optionalTotal: 0,
    optionalCompleted: 0,
  };
  for (const task of allTasks) {
    if (task.optional) {
      progress.optionalTotal += 1;
      if (task.state === 'done') progress.optionalCompleted += 1;
    } else {
      progress.total += 1;
      if (task.state === 'done') progress.completed += 1;
      if (task.state === 'in-progress') progress.inProgress += 1;
    }
  }

  return {
    ...(document.filePath !== undefined ? { filePath: document.filePath } : {}),
    ...(document.title() !== undefined ? { title: document.title() as string } : {}),
    tasks: roots,
    allTasks,
    progress,
    diagnostics,
  };
}

/** Look a task up by its explicit number (preferred) or synthesized id. */
export function findTask(model: TasksModel, reference: string): TaskItem | undefined {
  const wanted = reference.trim();
  return (
    model.allTasks.find((task) => task.number === wanted) ??
    model.allTasks.find((task) => task.id === wanted)
  );
}

/**
 * First open tasks in document order (required before optional) — what an
 * agent should pick up next. Parent tasks with children are skipped: the
 * actionable unit is the leaf.
 */
export function nextOpenTasks(model: TasksModel, limit: number): TaskItem[] {
  const open = model.allTasks.filter((task) => task.state === 'open' && task.children.length === 0);
  const required = open.filter((task) => !task.optional);
  const optional = open.filter((task) => task.optional);
  return [...required, ...optional].slice(0, limit);
}
