import { sha256Hex } from '@specbridge/core';
import { MarkdownDocument } from './markdown-document.js';
import type { TaskItem } from './tasks-parser.js';

/**
 * Normalized task-plan hashing (hash semantics version "2", see
 * TASK_PLAN_HASH_SEMANTICS_VERSION in @specbridge/core).
 *
 * The plan hash answers one question: "is this the same task plan that was
 * approved, ignoring checkbox progress?" Normalization therefore touches
 * exactly one thing — the single state character between the brackets of a
 * recognized checkbox line — and nothing else:
 *
 *   - task text, numbering, indentation, and hierarchy are NOT normalized
 *   - requirement references and detail lines are NOT normalized
 *   - line endings, BOM, and trailing-newline style are NOT normalized
 *   - checkbox-looking lines inside fenced code blocks are content, not
 *     tasks, and are NOT normalized
 *   - unrecognized state characters (anything outside ` `, `x`, `X`, `-`,
 *     `~`) are NOT normalized — changing them is a content change
 *
 * Consequently `[ ]` → `[x]` progress keeps the plan hash stable while every
 * other byte change produces a different hash.
 */

/** Matches the checkbox prefix of a task line with a recognized state char. */
const CHECKBOX_STATE_PREFIX = /^([ \t]*[-*+][ \t]+\[)([ xX~-])(\])/;

/** The canonical (open) state every recognized checkbox is normalized to. */
const NORMALIZED_STATE = ' ';

/**
 * The document text with recognized checkbox states normalized to `[ ]`.
 * Every other byte — including the BOM and each line's original ending —
 * is reproduced exactly.
 */
export function normalizedTaskPlanText(document: MarkdownDocument): string {
  const mask = document.codeFenceMask();
  let out = document.hasBom ? String.fromCharCode(0xfeff) : '';
  for (let i = 0; i < document.lineCount; i += 1) {
    const line = document.lineAt(i);
    let text = line.text;
    if (mask[i] !== true) {
      const match = CHECKBOX_STATE_PREFIX.exec(text);
      if (match !== null && match[1] !== undefined && match[3] !== undefined) {
        text = `${match[1]}${NORMALIZED_STATE}${match[3]}${text.slice(match[0].length)}`;
      }
    }
    out += text + line.eol;
  }
  return out;
}

/** SHA-256 (hex) of the checkbox-normalized document text. */
export function taskPlanHash(document: MarkdownDocument): string {
  return sha256Hex(Buffer.from(normalizedTaskPlanText(document), 'utf8'));
}

/** Plan hash of a tasks file on disk, or undefined when it cannot be read. */
export function tryTaskPlanHashOfFile(filePath: string): string | undefined {
  try {
    return taskPlanHash(MarkdownDocument.load(filePath));
  } catch {
    return undefined;
  }
}

/**
 * Stable fingerprint of one task's plan-relevant identity: its ID, title,
 * and requirement references. Checkbox state is deliberately excluded, so
 * progress does not change the fingerprint while renaming, renumbering, or
 * re-referencing the task does.
 */
export function taskFingerprint(task: Pick<TaskItem, 'id' | 'title' | 'requirementRefs'>): string {
  return sha256Hex(
    JSON.stringify({
      id: task.id,
      title: task.title,
      requirementRefs: [...task.requirementRefs],
    }),
  );
}
