import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Diagnostic, WorkspaceInfo } from '@specbridge/core';
import { ioError } from '@specbridge/core';
import type { Clock } from '@specbridge/workflow';
import { isoNow, systemClock } from '@specbridge/workflow';

/**
 * Append-only template operation records.
 *
 * One JSON line per operation in `.specbridge/template-records.jsonl`.
 * Records are never rewritten or deleted. They contain safe summaries only:
 * variable NAMES and rendered-content hashes, never variable values —
 * template runtime metadata must not duplicate potentially sensitive spec
 * content. Previews are deliberately not recorded: preview writes nothing.
 */

export const TEMPLATE_RECORD_SCHEMA_VERSION = '1.0.0';
export const TEMPLATE_RECORDS_FILE_NAME = 'template-records.jsonl';

export const TEMPLATE_RECORD_TYPES = [
  'template-apply',
  'template-install',
  'template-uninstall',
  'template-scaffold',
] as const;
export type TemplateRecordType = (typeof TEMPLATE_RECORD_TYPES)[number];

const baseRecordShape = {
  schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  recordId: z.string().min(1).max(100),
  type: z.enum(TEMPLATE_RECORD_TYPES),
  createdAt: z.string().datetime(),
  result: z.enum(['ok', 'failed']),
};

export const templateApplyRecordSchema = z
  .object({
    ...baseRecordShape,
    type: z.literal('template-apply'),
    templateRef: z.string(),
    templateId: z.string(),
    templateVersion: z.string(),
    templateSource: z.enum(['builtin', 'project']),
    manifestHash: z.string(),
    specName: z.string(),
    specKind: z.enum(['feature', 'bugfix']),
    workflowMode: z.enum(['requirements-first', 'design-first', 'quick']),
    /** Workspace-relative POSIX target path -> sha256 of rendered bytes. */
    renderedFiles: z.array(z.object({ target: z.string(), hash: z.string() })),
    /** Safe variable NAMES only; values are never stored. */
    variableNames: z.array(z.string()),
    createdPaths: z.array(z.string()),
  })
  .passthrough();

export const templateInstallRecordSchema = z
  .object({
    ...baseRecordShape,
    type: z.literal('template-install'),
    templateRef: z.string(),
    templateId: z.string(),
    templateVersion: z.string(),
    manifestHash: z.string(),
    /** Workspace-relative source the pack was copied from. */
    sourcePath: z.string(),
    installedPath: z.string(),
  })
  .passthrough();

export const templateUninstallRecordSchema = z
  .object({
    ...baseRecordShape,
    type: z.literal('template-uninstall'),
    templateRef: z.string(),
    templateId: z.string(),
    uninstalledPath: z.string(),
  })
  .passthrough();

export const templateScaffoldRecordSchema = z
  .object({
    ...baseRecordShape,
    type: z.literal('template-scaffold'),
    templateId: z.string(),
    kind: z.enum(['feature', 'bugfix']),
    outputPath: z.string(),
  })
  .passthrough();

export const templateRecordSchema = z.discriminatedUnion('type', [
  templateApplyRecordSchema,
  templateInstallRecordSchema,
  templateUninstallRecordSchema,
  templateScaffoldRecordSchema,
]);

export type TemplateApplyRecord = z.infer<typeof templateApplyRecordSchema>;
export type TemplateInstallRecord = z.infer<typeof templateInstallRecordSchema>;
export type TemplateUninstallRecord = z.infer<typeof templateUninstallRecordSchema>;
export type TemplateScaffoldRecord = z.infer<typeof templateScaffoldRecordSchema>;
export type TemplateRecord = z.infer<typeof templateRecordSchema>;

export function templateRecordsPath(workspace: WorkspaceInfo): string {
  return path.join(workspace.sidecarDir, TEMPLATE_RECORDS_FILE_NAME);
}

let recordCounter = 0;

/** Unique-enough record ID; tests may pass explicit IDs instead. */
export function newTemplateRecordId(clock: Clock = systemClock): string {
  recordCounter += 1;
  return `template-${clock().getTime().toString(36)}-${process.pid.toString(36)}-${recordCounter}`;
}

/** Validate and append one record. Records are append-only by contract. */
export function appendTemplateRecord(workspace: WorkspaceInfo, record: TemplateRecord): void {
  const validated = templateRecordSchema.parse(record);
  const filePath = templateRecordsPath(workspace);
  try {
    mkdirSync(workspace.sidecarDir, { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(validated)}\n`, 'utf8');
  } catch (cause) {
    throw ioError('append template record to', filePath, cause);
  }
}

export interface TemplateRecordsReadResult {
  records: TemplateRecord[];
  diagnostics: Diagnostic[];
}

/** Read all records, degrading unparseable lines to diagnostics. */
export function readTemplateRecords(workspace: WorkspaceInfo): TemplateRecordsReadResult {
  const filePath = templateRecordsPath(workspace);
  const diagnostics: Diagnostic[] = [];
  if (!existsSync(filePath)) return { records: [], diagnostics };
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (cause) {
    diagnostics.push({
      severity: 'warning',
      code: 'TEMPLATE_RECORDS_UNREADABLE',
      message: `Cannot read ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
    return { records: [], diagnostics };
  }
  const records: TemplateRecord[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      diagnostics.push({
        severity: 'warning',
        code: 'TEMPLATE_RECORD_INVALID',
        message: `Line ${index + 1} of ${TEMPLATE_RECORDS_FILE_NAME} is not valid JSON.`,
      });
      continue;
    }
    const result = templateRecordSchema.safeParse(parsed);
    if (!result.success) {
      diagnostics.push({
        severity: 'warning',
        code: 'TEMPLATE_RECORD_INVALID',
        message: `Line ${index + 1} of ${TEMPLATE_RECORDS_FILE_NAME} does not match the record schema.`,
      });
      continue;
    }
    records.push(result.data);
  }
  return { records, diagnostics };
}

export function nowIso(clock: Clock): string {
  return isoNow(clock);
}
