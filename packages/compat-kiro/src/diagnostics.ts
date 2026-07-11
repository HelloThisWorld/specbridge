import type { Diagnostic, SpecWorkflowState, TaskProgress, WorkspaceInfo } from '@specbridge/core';
import { EMPTY_TASK_PROGRESS, hasErrors, readSpecState } from '@specbridge/core';
import { extractFrontMatter } from './steering-loader.js';
import type { SteeringFileInfo } from './steering-loader.js';
import { listSteeringFiles, listUnknownSteeringEntries } from './steering-loader.js';
import type { SpecFolder } from './spec-discovery.js';
import { discoverSpecs, listLooseSpecEntries } from './spec-discovery.js';
import type { SpecClassification } from './spec-classifier.js';
import { classifySpec } from './spec-classifier.js';
import { MarkdownDocument } from './markdown-document.js';
import type { RequirementsModel } from './requirements-parser.js';
import { parseRequirements } from './requirements-parser.js';
import type { DesignModel } from './design-parser.js';
import { parseDesign } from './design-parser.js';
import type { TasksModel } from './tasks-parser.js';
import { parseTasks } from './tasks-parser.js';
import type { BugfixModel } from './bugfix-parser.js';
import { parseBugfix } from './bugfix-parser.js';
import type { RoundTripCheck } from './roundtrip-writer.js';
import { checkNoopRoundTrip } from './roundtrip-writer.js';

/**
 * Whole-spec and whole-workspace analysis: everything the CLI needs to
 * render `doctor`, `spec list`, `spec show`, and `spec context` from one
 * read-only pass. No function in this module writes to disk.
 */

export interface SpecAnalysis {
  folder: SpecFolder;
  classification: SpecClassification;
  state?: SpecWorkflowState;
  documents: Partial<Record<'requirements' | 'design' | 'tasks' | 'bugfix', MarkdownDocument>>;
  requirements?: RequirementsModel;
  design?: DesignModel;
  tasks?: TasksModel;
  bugfix?: BugfixModel;
  taskProgress: TaskProgress;
  /** No-op round-trip verification for every Markdown file in the spec folder. */
  roundTrip: RoundTripCheck[];
  diagnostics: Diagnostic[];
}

export interface LineEndingSummary {
  lf: number;
  crlf: number;
  cr: number;
  mixed: number;
  none: number;
}

export interface WorkspaceAnalysis {
  workspace: WorkspaceInfo;
  steering: SteeringFileInfo[];
  unknownSteeringEntries: string[];
  looseSpecEntries: string[];
  specs: SpecAnalysis[];
  lineEndings: LineEndingSummary;
  diagnostics: Diagnostic[];
  /** True when every Markdown file reserializes byte-identically. */
  roundTripSafe: boolean;
  /** True when no error-severity diagnostics exist anywhere. */
  healthy: boolean;
}

/** Detect SpecBridge-style metadata smuggled into a `.kiro` file (must never happen). */
function scanForForeignMetadata(document: MarkdownDocument): boolean {
  const frontMatter = extractFrontMatter(document);
  if (!frontMatter.present || frontMatter.data === undefined) return false;
  return Object.keys(frontMatter.data).some((key) => key.toLowerCase().includes('specbridge'));
}

export function analyzeSpec(workspace: WorkspaceInfo, folder: SpecFolder): SpecAnalysis {
  const diagnostics: Diagnostic[] = [];
  const documents: SpecAnalysis['documents'] = {};
  const roundTrip: RoundTripCheck[] = [];

  const stateResult = readSpecState(workspace, folder.name);
  diagnostics.push(...stateResult.diagnostics);

  const classification = classifySpec(folder, stateResult.state);
  diagnostics.push(...classification.diagnostics);

  let requirements: RequirementsModel | undefined;
  let design: DesignModel | undefined;
  let tasks: TasksModel | undefined;
  let bugfix: BugfixModel | undefined;

  for (const file of folder.files) {
    if (!file.fileName.toLowerCase().endsWith('.md')) continue;

    roundTrip.push(checkNoopRoundTrip(file.path));

    let document: MarkdownDocument;
    try {
      document = MarkdownDocument.load(file.path);
    } catch (cause) {
      diagnostics.push({
        severity: 'error',
        code: 'SPEC_FILE_UNREADABLE',
        message: cause instanceof Error ? cause.message : String(cause),
        file: file.path,
      });
      continue;
    }

    if (!document.encodingSafe) {
      diagnostics.push({
        severity: 'error',
        code: 'FILE_NOT_UTF8',
        message: 'File is not valid UTF-8; SpecBridge reads it best-effort but will never edit it.',
        file: file.path,
      });
    }
    if (document.dominantEol() === 'mixed') {
      diagnostics.push({
        severity: 'warning',
        code: 'FILE_MIXED_LINE_ENDINGS',
        message: 'File mixes LF and CRLF line endings. SpecBridge preserves them exactly as-is.',
        file: file.path,
      });
    }
    if (file.sizeBytes === 0) {
      diagnostics.push({
        severity: 'warning',
        code: 'SPEC_FILE_EMPTY',
        message: 'File is empty.',
        file: file.path,
      });
    }
    if (scanForForeignMetadata(document)) {
      diagnostics.push({
        severity: 'error',
        code: 'FOREIGN_METADATA_IN_KIRO_FILE',
        message:
          'Found SpecBridge-branded front matter inside a .kiro file. SpecBridge never writes metadata into .kiro; please report how this happened.',
        file: file.path,
      });
    }

    switch (file.kind) {
      case 'requirements':
        documents.requirements = document;
        requirements = parseRequirements(document);
        diagnostics.push(...requirements.diagnostics);
        break;
      case 'design':
        documents.design = document;
        design = parseDesign(document);
        diagnostics.push(...design.diagnostics);
        break;
      case 'tasks':
        documents.tasks = document;
        tasks = parseTasks(document);
        diagnostics.push(...tasks.diagnostics);
        break;
      case 'bugfix':
        documents.bugfix = document;
        bugfix = parseBugfix(document);
        diagnostics.push(...bugfix.diagnostics);
        break;
      case 'other':
        // Unknown files are listed and preserved; never parsed.
        break;
    }
  }

  for (const missing of classification.missingKinds) {
    diagnostics.push({
      severity: 'info',
      code: 'SPEC_STAGE_MISSING',
      message: `${missing}.md is not present yet (${classification.type} specs usually gain it in a later stage).`,
      file: folder.dir,
    });
  }

  return {
    folder,
    classification,
    ...(stateResult.state !== undefined ? { state: stateResult.state } : {}),
    documents,
    ...(requirements !== undefined ? { requirements } : {}),
    ...(design !== undefined ? { design } : {}),
    ...(tasks !== undefined ? { tasks } : {}),
    ...(bugfix !== undefined ? { bugfix } : {}),
    taskProgress: tasks?.progress ?? EMPTY_TASK_PROGRESS,
    roundTrip,
    diagnostics,
  };
}

export function analyzeWorkspace(workspace: WorkspaceInfo): WorkspaceAnalysis {
  const diagnostics: Diagnostic[] = [];

  const steering = listSteeringFiles(workspace);
  for (const info of steering) diagnostics.push(...info.diagnostics);
  const unknownSteeringEntries = listUnknownSteeringEntries(workspace);
  const looseSpecEntries = listLooseSpecEntries(workspace);

  if (workspace.steeringDir === undefined) {
    diagnostics.push({
      severity: 'info',
      code: 'STEERING_DIR_MISSING',
      message: '.kiro/steering does not exist. This is fine; steering is optional.',
    });
  }
  if (workspace.specsDir === undefined) {
    diagnostics.push({
      severity: 'info',
      code: 'SPECS_DIR_MISSING',
      message: '.kiro/specs does not exist. This is fine; create your first spec to add it.',
    });
  }
  if (looseSpecEntries.length > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'SPECS_LOOSE_FILES',
      message: `.kiro/specs contains loose files that are not spec folders: ${looseSpecEntries.join(', ')}. They are preserved and ignored.`,
    });
  }

  const specs = discoverSpecs(workspace).map((folder) => analyzeSpec(workspace, folder));

  // Steering round-trip checks participate in the workspace-wide guarantee.
  const steeringRoundTrip = steering
    .filter((info) => info.diagnostics.every((d) => d.code !== 'STEERING_UNREADABLE'))
    .map((info) => checkNoopRoundTrip(info.path));

  const lineEndings: LineEndingSummary = { lf: 0, crlf: 0, cr: 0, mixed: 0, none: 0 };
  const allChecks = [...steeringRoundTrip, ...specs.flatMap((spec) => spec.roundTrip)];
  for (const check of allChecks) {
    if (check.eol === 'lf') lineEndings.lf += 1;
    else if (check.eol === 'crlf') lineEndings.crlf += 1;
    else if (check.eol === 'cr') lineEndings.cr += 1;
    else if (check.eol === 'mixed') lineEndings.mixed += 1;
    else lineEndings.none += 1;
  }

  const roundTripSafe = allChecks.every((check) => check.identical);
  if (!roundTripSafe) {
    for (const check of allChecks.filter((c) => !c.identical)) {
      diagnostics.push({
        severity: 'error',
        code: 'ROUND_TRIP_UNSAFE',
        message: `No-op round trip is not byte-identical (${check.reason ?? 'unknown reason'}).`,
        file: check.file,
      });
    }
  }

  const allDiagnostics = [...diagnostics, ...specs.flatMap((spec) => spec.diagnostics)];

  return {
    workspace,
    steering,
    unknownSteeringEntries,
    looseSpecEntries,
    specs,
    lineEndings,
    diagnostics,
    roundTripSafe,
    healthy: !hasErrors(allDiagnostics),
  };
}
