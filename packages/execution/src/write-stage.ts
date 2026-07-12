import { existsSync } from 'node:fs';
import path from 'node:path';
import { MarkdownDocument } from '@specbridge/compat-kiro';
import type { StageName, WorkspaceInfo } from '@specbridge/core';
import { assertInsideWorkspace, writeFileAtomic } from '@specbridge/core';

/**
 * Atomic stage-document writes with line-ending preservation.
 *
 * Generated Markdown uses LF internally; when the target file already
 * exists with CRLF endings (or a BOM), the candidate is converted so the
 * file keeps its convention. `.kiro` writes always go through the
 * workspace-traversal guard and the atomic writer.
 */

export interface StageWriteResult {
  filePath: string;
  created: boolean;
  eol: 'lf' | 'crlf';
  bytesWritten: number;
}

export function stageDocumentPath(
  workspace: WorkspaceInfo,
  specName: string,
  stage: StageName,
): string {
  return assertInsideWorkspace(
    workspace.rootDir,
    path.join(workspace.kiroDir, 'specs', specName, `${stage}.md`),
  );
}

/** Normalize candidate markdown to LF with exactly one trailing newline. */
export function normalizeCandidateMarkdown(markdown: string): string {
  const lf = markdown.replace(/\r\n?/g, '\n');
  return lf.endsWith('\n') ? lf : `${lf}\n`;
}

export function writeStageDocument(
  workspace: WorkspaceInfo,
  specName: string,
  stage: StageName,
  markdown: string,
): StageWriteResult {
  const filePath = stageDocumentPath(workspace, specName, stage);
  const exists = existsSync(filePath);
  let eol: 'lf' | 'crlf' = 'lf';
  let bom = false;
  if (exists) {
    const current = MarkdownDocument.load(filePath);
    if (current.dominantEol() === 'crlf') eol = 'crlf';
    bom = current.hasBom;
  }
  const BOM = '﻿';
  let content = normalizeCandidateMarkdown(markdown);
  if (eol === 'crlf') content = content.replace(/\n/g, '\r\n');
  if (bom && !content.startsWith(BOM)) content = BOM + content;
  writeFileAtomic(filePath, content);
  return {
    filePath,
    created: !exists,
    eol,
    bytesWritten: Buffer.byteLength(content, 'utf8'),
  };
}
