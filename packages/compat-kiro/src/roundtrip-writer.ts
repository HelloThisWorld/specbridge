import { readFileSync } from 'node:fs';
import { SpecBridgeError, assertInsideWorkspace, writeFileAtomic } from '@specbridge/core';
import type { DominantEol } from './markdown-document.js';
import { MarkdownDocument } from './markdown-document.js';

/**
 * Round-trip-safe writing.
 *
 * The rules, in order of importance:
 *   1. A no-op load/serialize cycle is byte-identical. Always.
 *   2. Edits are surgical: only the targeted line changes, nothing else.
 *   3. Writes are atomic and confined to the workspace.
 *   4. Files that are not valid UTF-8 are never written through this model.
 */

export interface RoundTripCheck {
  file: string;
  identical: boolean;
  encodingSafe: boolean;
  byteLength: number;
  eol: DominantEol;
  hasBom: boolean;
  lineCount: number;
  reason?: string;
}

/** Prove that loading and reserializing a file reproduces its exact bytes. Read-only. */
export function checkNoopRoundTrip(filePath: string): RoundTripCheck {
  let original: Buffer;
  try {
    original = readFileSync(filePath);
  } catch (cause) {
    return {
      file: filePath,
      identical: false,
      encodingSafe: false,
      byteLength: 0,
      eol: 'none',
      hasBom: false,
      lineCount: 0,
      reason: `unreadable: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  const document = MarkdownDocument.fromBuffer(original, filePath);
  const reserialized = document.toBuffer();
  const identical = reserialized.equals(original);
  return {
    file: filePath,
    identical,
    encodingSafe: document.encodingSafe,
    byteLength: original.length,
    eol: document.dominantEol(),
    hasBom: document.hasBom,
    lineCount: document.lineCount,
    ...(identical
      ? {}
      : {
          reason: document.encodingSafe
            ? 'reserialized bytes differ from the original (this is a SpecBridge bug — please report it)'
            : 'file is not valid UTF-8',
        }),
  };
}

export function serializeDocument(document: MarkdownDocument): Buffer {
  return document.toBuffer();
}

/**
 * Write a document back to disk. Refuses to write outside the workspace and
 * refuses to write documents whose source bytes were not valid UTF-8.
 */
export function writeDocumentAtomic(
  document: MarkdownDocument,
  targetPath: string,
  options: { workspaceRoot: string },
): void {
  if (!document.encodingSafe) {
    throw new SpecBridgeError(
      'INVALID_STATE',
      `Refusing to write ${targetPath}: the source file was not valid UTF-8, so a write could corrupt it.`,
    );
  }
  const resolved = assertInsideWorkspace(options.workspaceRoot, targetPath);
  writeFileAtomic(resolved, document.toBuffer());
}

export type CheckboxTargetState = 'open' | 'done' | 'in-progress';

const CHECKBOX_LINE = /^([ \t]*[-*+][ \t]+\[)([^\]])(\].*)$/;

const STATE_CHAR: Record<CheckboxTargetState, string> = {
  open: ' ',
  done: 'x',
  'in-progress': '-',
};

/**
 * Surgically set the checkbox state on one line. Only the single character
 * between `[` and `]` changes; indentation, bullet marker, numbering, title,
 * trailing whitespace, and the line ending all stay byte-identical.
 */
export function applyCheckboxState(
  document: MarkdownDocument,
  lineIndex: number,
  state: CheckboxTargetState,
): { changed: boolean } {
  const line = document.lineAt(lineIndex);
  const match = CHECKBOX_LINE.exec(line.text);
  if (match === null || match[1] === undefined || match[3] === undefined) {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      `Line ${lineIndex + 1} is not a task checkbox line; refusing to edit it.`,
      { line: line.text },
    );
  }
  const nextChar = STATE_CHAR[state];
  if (match[2] === nextChar) return { changed: false };
  document.setLineText(lineIndex, `${match[1]}${nextChar}${match[3]}`);
  return { changed: true };
}
