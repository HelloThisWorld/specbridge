import { existsSync, readdirSync } from 'node:fs';
import type { ApprovalHealth, Diagnostic, WorkspaceInfo } from '@specbridge/core';
import { readSpecState, specStateDir } from '@specbridge/core';
import type { SpecFolder } from '@specbridge/compat-kiro';
import { evaluateWorkflow } from './health.js';

/**
 * Sidecar state audit for `doctor`: cross-checks `.specbridge/state/specs/`
 * against the actual `.kiro/specs/` directories. Report-only — nothing is
 * ever deleted or repaired automatically.
 */

export interface SidecarAuditEntry {
  specName: string;
  statePath: string;
  /** True when a matching `.kiro/specs/<name>/` directory exists. */
  hasSpecFolder: boolean;
  health: ApprovalHealth;
  /** Present when the state parsed and evaluated. */
  effectiveStatus?: string;
  diagnostics: Diagnostic[];
}

export interface SidecarAudit {
  stateDir: string;
  stateDirExists: boolean;
  entries: SidecarAuditEntry[];
  /** State files whose spec folder no longer exists. */
  orphanStates: string[];
  /** Spec folders with no sidecar state (normal for Kiro-only projects). */
  unmanagedSpecs: string[];
  /** Managed specs with at least one stale approval. */
  staleSpecs: string[];
  /** State files that could not be used. */
  invalidStates: string[];
  /** Non-state entries found in the state directory (listed, never touched). */
  unknownEntries: string[];
  diagnostics: Diagnostic[];
}

export function auditSidecarState(workspace: WorkspaceInfo, folders: SpecFolder[]): SidecarAudit {
  const stateDir = specStateDir(workspace);
  const stateDirExists = existsSync(stateDir);
  const folderNames = new Set(folders.map((folder) => folder.name));

  const entries: SidecarAuditEntry[] = [];
  const orphanStates: string[] = [];
  const invalidStates: string[] = [];
  const staleSpecs: string[] = [];
  const unknownEntries: string[] = [];
  const diagnostics: Diagnostic[] = [];

  if (stateDirExists) {
    const dirEntries = readdirSync(stateDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    );
    for (const entry of dirEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        unknownEntries.push(entry.name);
        continue;
      }
      const specName = entry.name.slice(0, -'.json'.length);
      const read = readSpecState(workspace, specName);
      const hasSpecFolder = folderNames.has(specName);
      const entryDiagnostics: Diagnostic[] = [...read.diagnostics];

      let health: ApprovalHealth;
      let effectiveStatus: string | undefined;
      if (read.state === undefined) {
        health = 'invalid';
        invalidStates.push(specName);
      } else if (!hasSpecFolder) {
        health = 'invalid';
        orphanStates.push(specName);
        entryDiagnostics.push({
          severity: 'warning',
          code: 'SIDECAR_STATE_ORPHAN',
          message: `Sidecar state exists for "${specName}" but .kiro/specs/${specName}/ does not. The state file is preserved; delete it manually if the spec is gone for good.`,
          file: read.path,
        });
      } else {
        const evaluation = evaluateWorkflow(workspace, read.state);
        health = evaluation.health;
        effectiveStatus = evaluation.effectiveStatus;
        entryDiagnostics.push(...evaluation.diagnostics);
        if (evaluation.health === 'stale') staleSpecs.push(specName);
      }

      entries.push({
        specName,
        statePath: read.path,
        hasSpecFolder,
        health,
        ...(effectiveStatus !== undefined ? { effectiveStatus } : {}),
        diagnostics: entryDiagnostics,
      });
      diagnostics.push(...entryDiagnostics);
    }
  }

  const managedNames = new Set(entries.map((entry) => entry.specName));
  const unmanagedSpecs = folders
    .map((folder) => folder.name)
    .filter((name) => !managedNames.has(name));

  return {
    stateDir,
    stateDirExists,
    entries,
    orphanStates,
    unmanagedSpecs,
    staleSpecs,
    invalidStates,
    unknownEntries,
    diagnostics,
  };
}
