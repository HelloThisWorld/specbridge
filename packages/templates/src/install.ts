import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import type { WorkspaceInfo } from '@specbridge/core';
import { isSpecBridgeError, sha256Hex, writeFileAtomic } from '@specbridge/core';
import { assertInsideWorkspace } from '@specbridge/core';
import type { Clock } from '@specbridge/workflow';
import { systemClock } from '@specbridge/workflow';
import type { TemplateCatalog } from './catalog.js';
import { projectTemplatesDir } from './catalog.js';
import { TemplateError } from './errors.js';
import { parseTemplateReference } from './ids.js';
import type { LoadedTemplatePack } from './pack.js';
import { loadTemplatePack, readTemplatePackDirectory } from './pack.js';
import { appendTemplateRecord, newTemplateRecordId, nowIso } from './records.js';

/**
 * Local template installation and uninstallation.
 *
 * Install copies a validated pack from a filesystem path inside the
 * repository into `.specbridge/templates/<id>/` — through a temp directory
 * and a single atomic rename, so a failed install leaves nothing behind.
 * No scripts run, no network is touched, symlinks are rejected, and an
 * existing installed template is never overwritten (there is no --force).
 */

export interface TemplateInstallRequest {
  /** Path to the local template pack directory. */
  sourcePath: string;
  /** Base for resolving a relative sourcePath (defaults to workspace root). */
  cwd?: string;
}

export interface TemplateInstallPlan {
  templateId: string;
  ref: string;
  templateVersion: string;
  manifestHash: string;
  sourceDir: string;
  targetDir: string;
  pack: LoadedTemplatePack;
  /** Advisory notes, e.g. shadowing a built-in ID. */
  warnings: string[];
}

export function planTemplateInstall(
  workspace: WorkspaceInfo,
  catalog: TemplateCatalog,
  request: TemplateInstallRequest,
): TemplateInstallPlan {
  const sourceDir = path.resolve(request.cwd ?? workspace.rootDir, request.sourcePath);
  try {
    assertInsideWorkspace(workspace.rootDir, sourceDir);
  } catch (cause) {
    if (isSpecBridgeError(cause) && cause.code === 'PATH_OUTSIDE_WORKSPACE') {
      throw new TemplateError(
        'SBT007',
        `Install source ${sourceDir} is outside the repository.`,
        'Copy the template pack into the repository first; installation only reads local, inspectable paths.',
        { path: sourceDir },
      );
    }
    throw cause;
  }

  const data = readTemplatePackDirectory(sourceDir);
  const pack = loadTemplatePack(data);
  if (!pack.valid || pack.manifest === undefined || pack.manifestText === undefined) {
    const problems = pack.issues
      .filter((issue) => issue.severity === 'error')
      .slice(0, 5)
      .map((issue) => `${issue.code}: ${issue.message}`);
    throw new TemplateError(
      'SBT004',
      `Template pack at ${sourceDir} failed validation: ${problems.join(' | ')}`,
      `Run "specbridge template validate ${request.sourcePath}" for the full report and fix the pack before installing.`,
      { path: sourceDir },
    );
  }

  const templateId = pack.manifest.id;
  const targetDir = path.join(projectTemplatesDir(workspace), templateId);
  if (existsSync(targetDir)) {
    throw new TemplateError(
      'SBT021',
      `Template "project:${templateId}" is already installed at ${targetDir}.`,
      `Uninstall it first with "specbridge template uninstall project:${templateId}" — installs never overwrite.`,
      { path: targetDir },
    );
  }

  const warnings: string[] = [];
  if (catalog.entries.some((entry) => entry.source === 'builtin' && entry.id === templateId)) {
    warnings.push(
      `A built-in template with ID "${templateId}" exists. After installation the unqualified reference ` +
        `"${templateId}" becomes ambiguous and every command will require "builtin:${templateId}" or "project:${templateId}".`,
    );
  }

  return {
    templateId,
    ref: `project:${templateId}`,
    templateVersion: pack.manifest.version,
    manifestHash: sha256Hex(pack.manifestText),
    sourceDir,
    targetDir,
    pack,
    warnings,
  };
}

export interface TemplateInstallResult {
  plan: TemplateInstallPlan;
  installedPath: string;
  recordId: string;
}

export function executeTemplateInstall(
  workspace: WorkspaceInfo,
  plan: TemplateInstallPlan,
  clock: Clock = systemClock,
  recordId?: string,
): TemplateInstallResult {
  const tmpParent = path.join(workspace.sidecarDir, 'tmp');
  const tempDir = path.join(
    tmpParent,
    `template-install-${plan.templateId}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );

  try {
    // Write the already-validated in-memory contents — the copy can never
    // pick up files (or symlinks) that validation did not see.
    mkdirSync(tempDir, { recursive: true });
    for (const [relative, content] of plan.pack.files) {
      const target = path.join(tempDir, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileAtomic(target, content);
    }

    // Validate the copied pack as an independent artifact before it becomes
    // discoverable.
    const copied = loadTemplatePack(readTemplatePackDirectory(tempDir));
    if (!copied.valid) {
      throw new TemplateError(
        'SBT025',
        `Copied template pack failed re-validation; installation was aborted.`,
        'Retry the install; if this persists, the source pack is changing while being read.',
        { path: plan.sourceDir },
      );
    }

    mkdirSync(path.dirname(plan.targetDir), { recursive: true });
    if (existsSync(plan.targetDir)) {
      throw new TemplateError(
        'SBT021',
        `Template "project:${plan.templateId}" was installed by another process.`,
        'Nothing was overwritten. Inspect the installed template with "specbridge template show ' +
          `project:${plan.templateId}".`,
        { path: plan.targetDir },
      );
    }
    renameSync(tempDir, plan.targetDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    try {
      rmdirSync(tmpParent);
    } catch {
      // Not empty or already gone — either is fine.
    }
  }

  const id = recordId ?? newTemplateRecordId(clock);
  appendTemplateRecord(workspace, {
    schemaVersion: '1.0.0',
    recordId: id,
    type: 'template-install',
    createdAt: nowIso(clock),
    result: 'ok',
    templateRef: plan.ref,
    templateId: plan.templateId,
    templateVersion: plan.templateVersion,
    manifestHash: plan.manifestHash,
    sourcePath: path.relative(workspace.rootDir, plan.sourceDir).split(path.sep).join('/'),
    installedPath: path.relative(workspace.rootDir, plan.targetDir).split(path.sep).join('/'),
  });

  return { plan, installedPath: plan.targetDir, recordId: id };
}

export interface TemplateUninstallPlan {
  templateId: string;
  ref: string;
  dir: string;
}

/**
 * Uninstall planning. Only project templates can be uninstalled, and only
 * via an explicit qualified reference — built-ins are immutable, and there
 * are no wildcards.
 */
export function planTemplateUninstall(workspace: WorkspaceInfo, rawReference: string): TemplateUninstallPlan {
  const reference = parseTemplateReference(rawReference);
  if (reference === undefined) {
    throw new TemplateError(
      'SBT003',
      `"${rawReference}" is not a valid template reference.`,
      'Use a qualified project reference like "project:my-template".',
      { reference: rawReference },
    );
  }
  if (reference.source === 'builtin') {
    throw new TemplateError(
      'SBT022',
      `Built-in template "${reference.id}" cannot be uninstalled.`,
      'Built-in templates are bundled with SpecBridge and are immutable at runtime.',
      { reference: rawReference },
    );
  }
  if (reference.source !== 'project') {
    throw new TemplateError(
      'SBT025',
      `Uninstall requires a qualified project reference (got "${rawReference}").`,
      `Use "project:${reference.id}" so the command cannot accidentally target another source.`,
      { reference: rawReference },
    );
  }

  const dir = path.join(projectTemplatesDir(workspace), reference.id);
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    throw new TemplateError(
      'SBT001',
      `Template "project:${reference.id}" is not installed.`,
      'Run "specbridge template list --source project" to see installed templates.',
      { reference: rawReference },
    );
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new TemplateError(
      'SBT009',
      `Installed template path ${dir} is not a regular directory.`,
      'Remove the entry manually after inspecting it; SpecBridge will not follow symlinks.',
      { path: dir },
    );
  }
  return { templateId: reference.id, ref: `project:${reference.id}`, dir };
}

export interface TemplateUninstallResult {
  plan: TemplateUninstallPlan;
  recordId: string;
}

/**
 * Remove the template directory. The directory is atomically renamed out of
 * `.specbridge/templates/` first (so the catalog can never see a half-deleted
 * pack) and then deleted. Specs generated from the template and past
 * application records are untouched.
 */
export function executeTemplateUninstall(
  workspace: WorkspaceInfo,
  plan: TemplateUninstallPlan,
  clock: Clock = systemClock,
  recordId?: string,
): TemplateUninstallResult {
  const tmpParent = path.join(workspace.sidecarDir, 'tmp');
  const tempDir = path.join(
    tmpParent,
    `template-uninstall-${plan.templateId}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(tmpParent, { recursive: true });
  renameSync(plan.dir, tempDir);
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } finally {
    try {
      rmdirSync(tmpParent);
    } catch {
      // Not empty or already gone — either is fine.
    }
  }

  const id = recordId ?? newTemplateRecordId(clock);
  appendTemplateRecord(workspace, {
    schemaVersion: '1.0.0',
    recordId: id,
    type: 'template-uninstall',
    createdAt: nowIso(clock),
    result: 'ok',
    templateRef: plan.ref,
    templateId: plan.templateId,
    uninstalledPath: path.relative(workspace.rootDir, plan.dir).split(path.sep).join('/'),
  });

  return { plan, recordId: id };
}
