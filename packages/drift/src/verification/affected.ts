import { existsSync } from 'node:fs';
import path from 'node:path';
import { MarkdownDocument, extractPathReferences } from '@specbridge/compat-kiro';
import type { PathReference, SpecFolder } from '@specbridge/compat-kiro';
import { discoverSpecs, specFile } from '@specbridge/compat-kiro';
import type { WorkspaceInfo } from '@specbridge/core';
import { listTaskEvidence } from '@specbridge/evidence';
import { readdirSync } from 'node:fs';
import type { ComparisonChangedFile } from './comparison.js';
import type { EffectivePolicy } from './policy.js';
import { resolveEffectivePolicy } from './policy.js';
import { specMatchReasons } from './context.js';

/**
 * Deterministic affected-spec resolution: which specs does a change set
 * touch? A spec is affected when at least one changed file
 *
 *   1. lives under `.kiro/specs/<name>/`,
 *   2. is the spec's sidecar state file,
 *   3. is the spec's verification policy file,
 *   4. matches a declared impact area,
 *   5. appears in accepted task evidence for the spec, or
 *   6. is a file design.md explicitly references.
 *
 * Everything here is read-only and runs no verification commands.
 */

export interface AffectedFileMatch {
  file: string;
  via: string[];
}

export interface AffectedSpec {
  specName: string;
  matches: AffectedFileMatch[];
}

export interface AffectedSpecsResult {
  /** Affected specs sorted by name; matches sorted by file path. */
  affected: AffectedSpec[];
  /** Non-infrastructure changed files that no spec claims (SBV014). */
  unmapped: ComparisonChangedFile[];
  /** Files claimed by more than one spec (SBV022). */
  ambiguous: { path: string; specs: { name: string; via: string[] }[] }[];
}

function isInfrastructurePath(candidate: string): boolean {
  return (
    candidate === '.git' ||
    candidate.startsWith('.git/') ||
    candidate.startsWith('.kiro/') ||
    candidate.startsWith('.specbridge/')
  );
}

interface SpecMatchingInfo {
  folder: SpecFolder;
  policy: EffectivePolicy;
  designReferences: PathReference[];
  evidencePaths: Set<string>;
}

function loadSpecMatchingInfo(
  workspace: WorkspaceInfo,
  folder: SpecFolder,
  options: { strict?: boolean },
): SpecMatchingInfo {
  const policy = resolveEffectivePolicy(workspace, folder.name, {
    ...(options.strict !== undefined ? { strict: options.strict } : {}),
  });

  let designReferences: PathReference[] = [];
  const design = specFile(folder, 'design');
  if (design !== undefined) {
    try {
      designReferences = extractPathReferences(MarkdownDocument.load(design.path));
    } catch {
      // Unreadable design files simply contribute no reference matches.
    }
  }

  // Accepted evidence records route files to the spec (routing only — the
  // freshness rules judge validity separately during verification).
  const evidencePaths = new Set<string>();
  const evidenceDir = path.join(workspace.sidecarDir, 'evidence', folder.name);
  if (existsSync(evidenceDir)) {
    for (const entry of readdirSync(evidenceDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const { records } = listTaskEvidence(workspace, folder.name, entry.name);
      for (const record of records) {
        if (record.status !== 'verified' && record.status !== 'manually-accepted') continue;
        for (const file of record.changedFiles) evidencePaths.add(file.path);
      }
    }
  }

  return { folder, policy, designReferences, evidencePaths };
}

export interface ResolveAffectedSpecsOptions {
  strict?: boolean;
}

/** Resolve affected specs for a change set against every workspace spec. */
export function resolveAffectedSpecs(
  workspace: WorkspaceInfo,
  changedFiles: readonly ComparisonChangedFile[],
  options: ResolveAffectedSpecsOptions = {},
): AffectedSpecsResult {
  const specs = discoverSpecs(workspace).map((folder) =>
    loadSpecMatchingInfo(workspace, folder, options),
  );

  const affectedByName = new Map<string, Map<string, string[]>>();
  const claimsByFile = new Map<string, { name: string; via: string[] }[]>();

  for (const file of changedFiles) {
    for (const spec of specs) {
      const via = specMatchReasons(
        spec.folder.name,
        spec.policy,
        spec.evidencePaths,
        spec.designReferences,
        file,
      );
      if (via.length === 0) continue;
      const fileMatches = affectedByName.get(spec.folder.name) ?? new Map<string, string[]>();
      fileMatches.set(file.path, via);
      affectedByName.set(spec.folder.name, fileMatches);
      const claims = claimsByFile.get(file.path) ?? [];
      claims.push({ name: spec.folder.name, via });
      claimsByFile.set(file.path, claims);
    }
  }

  const affected: AffectedSpec[] = [...affectedByName.entries()]
    .map(([specName, fileMatches]) => ({
      specName,
      matches: [...fileMatches.entries()]
        .map(([file, via]) => ({ file, via }))
        .sort((a, b) => a.file.localeCompare(b.file, 'en')),
    }))
    .sort((a, b) => a.specName.localeCompare(b.specName, 'en'));

  const unmapped = changedFiles.filter(
    (file) => !isInfrastructurePath(file.path) && !claimsByFile.has(file.path),
  );

  const ambiguous = [...claimsByFile.entries()]
    .filter(([, claims]) => claims.length > 1)
    .map(([filePath, claims]) => ({
      path: filePath,
      specs: [...claims].sort((a, b) => a.name.localeCompare(b.name, 'en')),
    }))
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));

  return { affected, unmapped, ambiguous };
}
