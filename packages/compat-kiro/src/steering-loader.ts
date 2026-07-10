import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Diagnostic, WorkspaceInfo } from '@specbridge/core';
import { DEFAULT_STEERING_FILES, SpecBridgeError } from '@specbridge/core';
import { MarkdownDocument } from './markdown-document.js';

/**
 * Steering files live in `.kiro/steering/*.md`.
 *
 * Kiro's documented front matter controls when a steering file is included:
 *   - no front matter / `inclusion: always` -> always included
 *   - `inclusion: fileMatch` + `fileMatchPattern` -> included for matching files
 *   - `inclusion: manual`                          -> included on request
 * We parse this tolerantly and preserve everything else untouched.
 */

export type SteeringInclusion = 'always' | 'fileMatch' | 'manual' | 'unknown';

export interface SteeringFileInfo {
  /** Name without the `.md` extension, e.g. `product`. */
  name: string;
  fileName: string;
  path: string;
  /** True for Kiro's default trio: product.md, tech.md, structure.md. */
  isDefault: boolean;
  inclusion: SteeringInclusion;
  fileMatchPattern?: string;
  hasFrontMatter: boolean;
  sizeBytes: number;
  diagnostics: Diagnostic[];
}

export interface SteeringDocument {
  info: SteeringFileInfo;
  document: MarkdownDocument;
  /** Document text without the front matter block (for context building). */
  body: string;
}

interface FrontMatter {
  present: boolean;
  /** Exclusive end line of the block (line after the closing `---`). */
  endLine: number;
  data?: Record<string, unknown>;
  error?: string;
}

export function extractFrontMatter(document: MarkdownDocument): FrontMatter {
  if (document.lineCount === 0 || document.lineAt(0).text.trim() !== '---') {
    return { present: false, endLine: 0 };
  }
  for (let i = 1; i < document.lineCount; i += 1) {
    const text = document.lineAt(i).text.trim();
    if (text === '---' || text === '...') {
      const raw = document.getText(1, i);
      try {
        const data: unknown = parseYaml(raw);
        if (data === null || data === undefined) return { present: true, endLine: i + 1 };
        if (typeof data !== 'object' || Array.isArray(data)) {
          return { present: true, endLine: i + 1, error: 'front matter is not a YAML mapping' };
        }
        return { present: true, endLine: i + 1, data: data as Record<string, unknown> };
      } catch (cause) {
        return {
          present: true,
          endLine: i + 1,
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
    }
  }
  // Opening `---` with no closing marker: treat as content, not front matter.
  return { present: false, endLine: 0 };
}

function steeringInfoFor(workspace: WorkspaceInfo, fileName: string): SteeringFileInfo {
  const steeringDir = workspace.steeringDir;
  if (steeringDir === undefined) {
    throw new SpecBridgeError('STEERING_NOT_FOUND', 'Workspace has no .kiro/steering directory.');
  }
  const filePath = path.join(steeringDir, fileName);
  const diagnostics: Diagnostic[] = [];
  let inclusion: SteeringInclusion = 'always';
  let fileMatchPattern: string | undefined;
  let hasFrontMatter = false;
  let sizeBytes = 0;

  try {
    sizeBytes = statSync(filePath).size;
    const document = MarkdownDocument.load(filePath);
    const frontMatter = extractFrontMatter(document);
    hasFrontMatter = frontMatter.present;
    if (frontMatter.error !== undefined) {
      diagnostics.push({
        severity: 'warning',
        code: 'STEERING_FRONT_MATTER_INVALID',
        message: `Front matter could not be parsed (${frontMatter.error}); treating file as always-included.`,
        file: filePath,
      });
    } else if (frontMatter.data !== undefined) {
      const rawInclusion = frontMatter.data['inclusion'];
      if (rawInclusion === undefined) {
        inclusion = 'always';
      } else if (rawInclusion === 'always' || rawInclusion === 'fileMatch' || rawInclusion === 'manual') {
        inclusion = rawInclusion;
      } else {
        inclusion = 'unknown';
        diagnostics.push({
          severity: 'warning',
          code: 'STEERING_INCLUSION_UNRECOGNIZED',
          message: `Unrecognized inclusion mode ${JSON.stringify(rawInclusion)}; file preserved as-is.`,
          file: filePath,
        });
      }
      const rawPattern = frontMatter.data['fileMatchPattern'];
      if (typeof rawPattern === 'string') fileMatchPattern = rawPattern;
    }
    if (!document.encodingSafe) {
      diagnostics.push({
        severity: 'error',
        code: 'FILE_NOT_UTF8',
        message: 'File is not valid UTF-8; SpecBridge will read it best-effort but never edit it.',
        file: filePath,
      });
    }
  } catch (cause) {
    diagnostics.push({
      severity: 'error',
      code: 'STEERING_UNREADABLE',
      message: cause instanceof Error ? cause.message : String(cause),
      file: filePath,
    });
  }

  const name = fileName.replace(/\.md$/i, '');
  return {
    name,
    fileName,
    path: filePath,
    isDefault: (DEFAULT_STEERING_FILES as readonly string[]).includes(fileName.toLowerCase()),
    inclusion,
    ...(fileMatchPattern !== undefined ? { fileMatchPattern } : {}),
    hasFrontMatter,
    sizeBytes,
    diagnostics,
  };
}

/**
 * List steering Markdown files. Defaults (product, tech, structure) come
 * first in canonical order, then additional files alphabetically.
 */
export function listSteeringFiles(workspace: WorkspaceInfo): SteeringFileInfo[] {
  if (workspace.steeringDir === undefined) return [];
  const entries = readdirSync(workspace.steeringDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => entry.name);

  const defaults = DEFAULT_STEERING_FILES.filter((name) =>
    entries.some((e) => e.toLowerCase() === name),
  ).map((name) => entries.find((e) => e.toLowerCase() === name) as string);
  const additional = entries
    .filter((e) => !(DEFAULT_STEERING_FILES as readonly string[]).includes(e.toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'en'));

  return [...defaults, ...additional].map((fileName) => steeringInfoFor(workspace, fileName));
}

/** Non-Markdown files sitting in the steering directory (listed, never parsed). */
export function listUnknownSteeringEntries(workspace: WorkspaceInfo): string[] {
  if (workspace.steeringDir === undefined) return [];
  return readdirSync(workspace.steeringDir, { withFileTypes: true })
    .filter((entry) => !(entry.isFile() && entry.name.toLowerCase().endsWith('.md')))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'));
}

/** Resolve `product`, `product.md`, or a case-insensitive variant to a steering file. */
export function resolveSteeringName(
  workspace: WorkspaceInfo,
  name: string,
): SteeringFileInfo | undefined {
  const wanted = name.toLowerCase();
  return listSteeringFiles(workspace).find(
    (info) => info.name.toLowerCase() === wanted || info.fileName.toLowerCase() === wanted,
  );
}

/** Load one steering document by name; throws `STEERING_NOT_FOUND` with the available names. */
export function loadSteeringDocument(workspace: WorkspaceInfo, name: string): SteeringDocument {
  const info = resolveSteeringName(workspace, name);
  if (info === undefined) {
    const available = listSteeringFiles(workspace).map((f) => f.name);
    throw new SpecBridgeError(
      'STEERING_NOT_FOUND',
      available.length > 0
        ? `Steering file "${name}" not found. Available steering files: ${available.join(', ')}.`
        : `Steering file "${name}" not found. This workspace has no .kiro/steering directory or it is empty.`,
    );
  }
  const document = MarkdownDocument.load(info.path);
  const frontMatter = extractFrontMatter(document);
  const body = frontMatter.present
    ? document.getText(frontMatter.endLine, document.lineCount)
    : document.bodyText();
  return { info, document, body };
}
