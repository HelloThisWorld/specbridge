import path from 'node:path';
import type { ConcreteWorkflowMode, Diagnostic, WorkspaceInfo } from '@specbridge/core';
import { isSpecBridgeError, sha256Hex } from '@specbridge/core';
import type { Clock, RenderedSpecFile, SpecCreationPlan, SpecCreationResult } from '@specbridge/workflow';
import {
  DEFAULT_BUGFIX_DESCRIPTION,
  DEFAULT_FEATURE_DESCRIPTION,
  executeSpecCreation,
  planSpecCreationFromFiles,
  systemClock,
  titleFromSpecName,
} from '@specbridge/workflow';
import type { TemplateCatalog, TemplateCatalogEntry } from './catalog.js';
import { resolveValidTemplate } from './catalog.js';
import type { TemplateEntrySource } from './ids.js';
import { TemplateError } from './errors.js';
import type { TemplateManifest } from './manifest.js';
import { TARGET_STAGES } from './manifest.js';
import { checkRenderedDocument } from './pack.js';
import { renderTemplateText } from './renderer.js';
import type { TemplateRecord } from './records.js';
import { appendTemplateRecord, newTemplateRecordId, nowIso } from './records.js';
import type { SuppliedVariableValue } from './variables.js';
import { resolveVariables } from './variables.js';

/**
 * Template preview and apply.
 *
 * ONE rendering path: `planTemplateApplication` is pure (no writes, no
 * model, no network) and powers `template preview`, `template apply
 * --dry-run`, the MCP preview tool, and the real apply. Apply then hands the
 * plan to the existing atomic spec-creation machinery — there is no second
 * renderer and no second spec writer.
 */

export interface TemplateApplicationRequest {
  /** Template reference: `rest-api`, `builtin:rest-api`, `project:x`. */
  reference: string;
  specName: string;
  mode?: ConcreteWorkflowMode;
  title?: string;
  description?: string;
  variables?: Readonly<Record<string, SuppliedVariableValue>>;
}

export interface TemplateApplicationPlan {
  templateRef: string;
  templateId: string;
  templateVersion: string;
  templateSource: TemplateEntrySource;
  manifest: TemplateManifest;
  /** sha256 of the manifest text, binding the plan to the exact template. */
  manifestHash: string;
  mode: ConcreteWorkflowMode;
  /** Names of manifest variables that were supplied or defaulted. */
  variableNames: string[];
  /** The underlying spec-creation plan (dir, files, sidecar state). */
  specPlan: SpecCreationPlan;
  /**
   * Deterministic hash over the template identity, spec identity, and every
   * rendered file. MCP apply requires the caller to echo this back so the
   * reviewed content is exactly the content written.
   */
  candidateHash: string;
  /** Advisory findings (deprecation, structural warnings). Never blocking. */
  diagnostics: Diagnostic[];
}

export interface TemplateApplicationResult {
  plan: TemplateApplicationPlan;
  creation: SpecCreationResult;
  recordId: string;
}

function rethrowSpecExists(cause: unknown, specName: string): never {
  if (isSpecBridgeError(cause) && cause.code === 'SPEC_ALREADY_EXISTS') {
    throw new TemplateError(
      'SBT020',
      `Spec "${specName}" already exists.`,
      'SpecBridge never overwrites an existing spec. Choose a different --name or inspect the existing spec ' +
        `with "specbridge spec show ${specName}".`,
      { specName },
    );
  }
  throw cause;
}

export function candidateHashForFiles(
  identity: {
    templateRef: string;
    templateVersion: string;
    manifestHash: string;
    specName: string;
    kind: string;
    mode: string;
  },
  files: readonly RenderedSpecFile[],
): string {
  const payload = {
    schema: 'specbridge.template-candidate/1',
    ...identity,
    files: files.map((file) => ({ target: file.fileName, hash: sha256Hex(file.content) })),
  };
  return sha256Hex(JSON.stringify(payload));
}

/**
 * Resolve, validate, and render a template application without writing
 * anything. Throws `TemplateError`/`SpecBridgeError` with remediation on any
 * failure; returns the full plan (rendered files included) on success.
 */
export function planTemplateApplication(
  workspace: WorkspaceInfo,
  catalog: TemplateCatalog,
  request: TemplateApplicationRequest,
  clock: Clock = systemClock,
): TemplateApplicationPlan {
  const entry: TemplateCatalogEntry = resolveValidTemplate(catalog, request.reference);
  const manifest = entry.pack.manifest;
  const manifestText = entry.pack.manifestText;
  if (manifest === undefined || manifestText === undefined) {
    throw new TemplateError('SBT004', `Template ${entry.ref} has no readable manifest.`, 'Re-install the template.');
  }

  const diagnostics: Diagnostic[] = [];
  if (manifest.deprecated === true) {
    diagnostics.push({
      severity: 'warning',
      code: 'TEMPLATE_DEPRECATED',
      message:
        `Template ${entry.ref} is deprecated.` +
        (manifest.replacement !== undefined ? ` Consider "${manifest.replacement}" instead.` : ''),
    });
  }

  const mode = request.mode ?? manifest.defaultMode;
  if (!manifest.supportedModes.includes(mode)) {
    throw new TemplateError(
      'SBT015',
      `Template ${entry.ref} does not support mode "${mode}".`,
      `Supported modes: ${manifest.supportedModes.join(', ')} (default: ${manifest.defaultMode}).`,
      { reference: entry.ref, mode },
    );
  }

  // Fail fast on an invalid or already-taken spec name before variables are
  // even looked at — reusing the exact same validation the whole product uses.
  try {
    planSpecCreationFromFiles(
      workspace,
      {
        name: request.specName,
        specType: manifest.kind,
        mode,
        title: 'placeholder',
        description: 'placeholder',
        descriptionIsPlaceholder: true,
        files: [],
      },
      clock,
    );
  } catch (cause) {
    rethrowSpecExists(cause, request.specName);
  }

  const requestedTitle = request.title?.trim();
  const title =
    requestedTitle !== undefined && requestedTitle.length > 0
      ? requestedTitle
      : titleFromSpecName(request.specName);
  const requestedDescription = request.description?.trim();
  const descriptionIsPlaceholder = requestedDescription === undefined || requestedDescription.length === 0;
  const description = descriptionIsPlaceholder
    ? manifest.kind === 'bugfix'
      ? DEFAULT_BUGFIX_DESCRIPTION
      : DEFAULT_FEATURE_DESCRIPTION
    : requestedDescription;

  const resolved = resolveVariables(manifest, request.variables ?? {}, {
    specName: request.specName,
    title,
    description,
    kind: manifest.kind,
    mode,
    clock,
  });

  const files: RenderedSpecFile[] = [];
  for (const file of manifest.files) {
    const source = entry.pack.files.get(file.source);
    if (source === undefined) {
      throw new TemplateError(
        'SBT007',
        `Template ${entry.ref} declares "${file.source}" but the pack does not contain it.`,
        `Run "specbridge template validate ${entry.ref}".`,
        { reference: entry.ref, source: file.source },
      );
    }
    const content = renderTemplateText(file.source, source, resolved.values);
    const stage = TARGET_STAGES[file.target];
    if (stage === undefined) {
      throw new TemplateError(
        'SBT011',
        `Template ${entry.ref} declares invalid target "${file.target}".`,
        `Run "specbridge template validate ${entry.ref}".`,
        { reference: entry.ref, target: file.target },
      );
    }
    const structural = checkRenderedDocument(file.source, file.target, content);
    const errors = structural.filter((issueItem) => issueItem.severity === 'error');
    if (errors.length > 0) {
      throw new TemplateError(
        'SBT017',
        `Rendered "${file.target}" is not a valid spec document: ${errors
          .map((issueItem) => issueItem.message)
          .join(' | ')}`,
        'Fix the template file or the supplied variable values, then preview again.',
        { reference: entry.ref, target: file.target },
      );
    }
    for (const warningItem of structural) {
      diagnostics.push({
        severity: 'warning',
        code: 'TEMPLATE_RENDER_WARNING',
        message: warningItem.message,
      });
    }
    files.push({ fileName: file.target, stage, content });
  }

  let specPlan: SpecCreationPlan;
  try {
    specPlan = planSpecCreationFromFiles(
      workspace,
      {
        name: request.specName,
        specType: manifest.kind,
        mode,
        title,
        description,
        descriptionIsPlaceholder,
        files,
      },
      clock,
    );
  } catch (cause) {
    rethrowSpecExists(cause, request.specName);
  }

  const manifestHash = sha256Hex(manifestText);
  const candidateHash = candidateHashForFiles(
    {
      templateRef: entry.ref,
      templateVersion: manifest.version,
      manifestHash,
      specName: request.specName,
      kind: manifest.kind,
      mode,
    },
    files,
  );

  return {
    templateRef: entry.ref,
    templateId: entry.id,
    templateVersion: manifest.version,
    templateSource: entry.source,
    manifest,
    manifestHash,
    mode,
    variableNames: resolved.variableNames,
    specPlan,
    candidateHash,
    diagnostics,
  };
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join('/');
}

/**
 * Execute a template application plan: atomic spec creation through the
 * existing workflow machinery (temp dir + single rename + sidecar state),
 * then an append-only template-apply record. Generated stages start
 * unapproved — templates never bypass the approval workflow.
 */
export function executeTemplateApplication(
  workspace: WorkspaceInfo,
  plan: TemplateApplicationPlan,
  clock: Clock = systemClock,
  recordId?: string,
): TemplateApplicationResult {
  let creation: SpecCreationResult;
  try {
    creation = executeSpecCreation(workspace, plan.specPlan);
  } catch (cause) {
    rethrowSpecExists(cause, plan.specPlan.specName);
  }

  const id = recordId ?? newTemplateRecordId(clock);
  const record: TemplateRecord = {
    schemaVersion: '1.0.0',
    recordId: id,
    type: 'template-apply',
    createdAt: nowIso(clock),
    result: 'ok',
    templateRef: plan.templateRef,
    templateId: plan.templateId,
    templateVersion: plan.templateVersion,
    templateSource: plan.templateSource,
    manifestHash: plan.manifestHash,
    specName: plan.specPlan.specName,
    specKind: plan.specPlan.specType,
    workflowMode: plan.mode,
    renderedFiles: plan.specPlan.files.map((file) => ({
      target: file.fileName,
      hash: sha256Hex(file.content),
    })),
    variableNames: plan.variableNames,
    createdPaths: [
      ...creation.writtenFiles.map((file) => toPosix(path.relative(workspace.rootDir, file))),
      toPosix(path.relative(workspace.rootDir, creation.statePath)),
    ],
  };
  appendTemplateRecord(workspace, record);

  return { plan, creation, recordId: id };
}
