import path from 'node:path';
import type { WorkspaceInfo } from '@specbridge/core';
import { requireWorkspace, resolveWorkspace } from '@specbridge/core';

/**
 * Kiro workspace detection.
 *
 * A Kiro workspace is any directory that contains a `.kiro` directory. No
 * configuration, no manifest, no migration: if Kiro can open it, so can we.
 */

export interface KiroWorkspaceStatus {
  workspace?: WorkspaceInfo;
  found: boolean;
  hasSteeringDir: boolean;
  hasSpecsDir: boolean;
  searchedFrom: string;
}

/** Detect the workspace without throwing; used by `doctor`. */
export function detectKiroWorkspace(startDir: string): KiroWorkspaceStatus {
  const searchedFrom = path.resolve(startDir);
  const workspace = resolveWorkspace(searchedFrom);
  if (workspace === undefined) {
    return { found: false, hasSteeringDir: false, hasSpecsDir: false, searchedFrom };
  }
  return {
    workspace,
    found: true,
    hasSteeringDir: workspace.steeringDir !== undefined,
    hasSpecsDir: workspace.specsDir !== undefined,
    searchedFrom,
  };
}

/** Detect the workspace or throw a `WORKSPACE_NOT_FOUND` error with guidance. */
export function requireKiroWorkspace(startDir: string): WorkspaceInfo {
  return requireWorkspace(startDir);
}
