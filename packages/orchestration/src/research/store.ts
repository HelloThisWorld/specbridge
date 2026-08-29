import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Diagnostic, WorkspaceInfo } from '@specbridge/core';
import { assertInsideWorkspace, writeFileAtomic } from '@specbridge/core';
import type { ResearchRecord, ResearchUseRecord } from './contracts.js';
import {
  RESEARCH_RECORD_SCHEMA_VERSION,
  RESEARCH_USE_SCHEMA_VERSION,
  researchRecordSchema,
  researchUseRecordSchema,
} from './contracts.js';

export const RESEARCH_DIR_NAME = 'research';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function researchRootDir(workspace: WorkspaceInfo): string {
  return assertInsideWorkspace(workspace.rootDir, path.join(workspace.sidecarDir, RESEARCH_DIR_NAME));
}
export function researchRecordsDir(workspace: WorkspaceInfo): string {
  return assertInsideWorkspace(workspace.rootDir, path.join(researchRootDir(workspace), 'records'));
}

export function researchUsesDir(workspace: WorkspaceInfo): string {
  return assertInsideWorkspace(workspace.rootDir, path.join(researchRootDir(workspace), 'uses'));
}

function assertResearchId(researchId: string): string {
  if (!ID_PATTERN.test(researchId)) throw new Error(`Invalid research id "${researchId}".`);
  return researchId;
}

export function researchRecordFile(workspace: WorkspaceInfo, researchId: string): string {
  assertResearchId(researchId);
  return assertInsideWorkspace(
    workspace.rootDir,
    path.join(researchRecordsDir(workspace), `${researchId}.json`),
  );
}

export type ResearchRecordReadResult =
  | { kind: 'ok'; record: ResearchRecord }
  | { kind: 'missing' }
  | { kind: 'corrupt'; problem: string; file: string }
  | { kind: 'unsupported-version'; version: string; file: string };

function majorOf(value: string): string {
  return value.split('.')[0] ?? '';
}

export function readResearchRecord(
  workspace: WorkspaceInfo,
  researchId: string,
): ResearchRecordReadResult {
  const file = researchRecordFile(workspace, researchId);
  if (!existsSync(file)) return { kind: 'missing' };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    return { kind: 'corrupt', problem: cause instanceof Error ? cause.message : String(cause), file };
  }
  const version =
    value !== null && typeof value === 'object'
      ? (value as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (typeof version !== 'string') return { kind: 'corrupt', problem: 'schemaVersion is missing', file };
  if (majorOf(version) !== majorOf(RESEARCH_RECORD_SCHEMA_VERSION)) {
    return { kind: 'unsupported-version', version, file };
  }
  const parsed = researchRecordSchema.safeParse(value);
  if (!parsed.success) {
    return {
      kind: 'corrupt',
      problem: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
      file,
    };
  }
  return { kind: 'ok', record: parsed.data };
}

export function writeResearchRecord(
  workspace: WorkspaceInfo,
  value: ResearchRecord,
): ResearchRecord {
  const record = researchRecordSchema.parse(value);
  const file = researchRecordFile(workspace, record.researchId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function researchUseFile(workspace: WorkspaceInfo, useId: string): string {
  return assertInsideWorkspace(workspace.rootDir, path.join(researchUsesDir(workspace), `${useId}.json`));
}

/** Append one immutable lifecycle-use event. It grants no authority. */
export function writeResearchUseRecord(
  workspace: WorkspaceInfo,
  value: ResearchUseRecord,
): ResearchUseRecord {
  const record = researchUseRecordSchema.parse(value);
  const file = researchUseFile(workspace, record.useId);
  if (existsSync(file)) throw new Error(`research use id ${record.useId} already exists`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function listResearchUseRecords(workspace: WorkspaceInfo): ResearchUseRecord[] {
  const dir = researchUsesDir(workspace);
  if (!existsSync(dir)) return [];
  const records: ResearchUseRecord[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const value = JSON.parse(readFileSync(path.join(dir, entry.name), 'utf8')) as unknown;
      const version =
        value !== null && typeof value === 'object' && typeof (value as { schemaVersion?: unknown }).schemaVersion === 'string'
          ? (value as { schemaVersion: string }).schemaVersion
          : '';
      if (majorOf(version) !== majorOf(RESEARCH_USE_SCHEMA_VERSION)) continue;
      const parsed = researchUseRecordSchema.safeParse(value);
      if (parsed.success) records.push(parsed.data);
    } catch {
      // Preserve unreadable provenance. Status surfaces can still inspect the file.
    }
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export interface ResearchRecordListResult {
  records: ResearchRecord[];
  diagnostics: Diagnostic[];
}

export function listResearchRecords(workspace: WorkspaceInfo): ResearchRecordListResult {
  const dir = researchRecordsDir(workspace);
  if (!existsSync(dir)) return { records: [], diagnostics: [] };
  const records: ResearchRecord[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const researchId = entry.name.slice(0, -5);
    if (!ID_PATTERN.test(researchId)) continue;
    const read = readResearchRecord(workspace, researchId);
    if (read.kind === 'ok') records.push(read.record);
    else if (read.kind !== 'missing') {
      diagnostics.push({
        severity: 'warning',
        code: read.kind === 'unsupported-version' ? 'RESEARCH_UNSUPPORTED_VERSION' : 'RESEARCH_RECORD_UNREADABLE',
        message:
          read.kind === 'unsupported-version'
            ? `Research record ${researchId} uses schema ${read.version}; ignoring it.`
            : `Research record ${researchId} is corrupt; ignoring it and preserving the file.`,
        file: read.file,
      });
    }
  }
  records.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt, 'en') || right.researchId.localeCompare(left.researchId, 'en'),
  );
  return { records, diagnostics };
}
