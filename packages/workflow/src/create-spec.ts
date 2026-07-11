import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import type {
  ConcreteSpecType,
  ConcreteWorkflowMode,
  SpecWorkflowState,
  WorkspaceInfo,
} from '@specbridge/core';
import {
  KIRO_DIR_NAME,
  KIRO_SPECS_DIR,
  SpecBridgeError,
  assertInsideWorkspace,
  ioError,
  specStatePath,
  writeFileAtomic,
  writeSpecState,
} from '@specbridge/core';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import { newSpecState } from './approval.js';
import { validateSpecName, titleFromSpecName } from './spec-name.js';
import type { RenderedSpecFile } from './templates.js';
import {
  DEFAULT_BUGFIX_DESCRIPTION,
  DEFAULT_FEATURE_DESCRIPTION,
  renderSpecTemplates,
} from './templates.js';

/**
 * Spec creation.
 *
 * Creation is planned first (pure, no writes — this powers `--dry-run`),
 * then executed atomically: files are written into a temp directory under
 * `.specbridge/tmp/` and renamed into `.kiro/specs/<name>` in one step.
 * A failure at any point leaves no partial spec directory behind.
 */

/** Description files larger than this are rejected (configurable per call). */
export const DEFAULT_MAX_DESCRIPTION_BYTES = 1024 * 1024;

export interface SpecCreationRequest {
  name: string;
  specType?: ConcreteSpecType;
  mode?: ConcreteWorkflowMode;
  title?: string;
  description?: string;
  /** Path to a UTF-8 Markdown/text file with the description. */
  fromFile?: string;
  /** Base directory for resolving a relative `fromFile` (defaults to the workspace root). */
  cwd?: string;
  maxDescriptionBytes?: number;
}

export interface SpecCreationPlan {
  specName: string;
  specType: ConcreteSpecType;
  mode: ConcreteWorkflowMode;
  title: string;
  description: string;
  /** True when the description is the generated placeholder text. */
  descriptionIsPlaceholder: boolean;
  /** Absolute target directory: `<root>/.kiro/specs/<name>`. */
  dir: string;
  files: RenderedSpecFile[];
  state: SpecWorkflowState;
  statePath: string;
}

export interface SpecCreationResult {
  plan: SpecCreationPlan;
  /** Absolute paths of the files that were written. */
  writtenFiles: string[];
  statePath: string;
}

function readDescriptionFile(
  workspace: WorkspaceInfo,
  fromFile: string,
  cwd: string,
  maxBytes: number,
): string {
  const resolved = path.resolve(cwd, fromFile);
  // Description files must live inside the workspace: the CLI never reads
  // arbitrary machine paths on behalf of a spec.
  assertInsideWorkspace(workspace.rootDir, resolved);

  let stats;
  try {
    stats = statSync(resolved);
  } catch (cause) {
    throw ioError('read description file', resolved, cause);
  }
  if (stats.isDirectory()) {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      `--from-file points at a directory: ${resolved}. Point it at a UTF-8 text file.`,
    );
  }
  if (stats.size > maxBytes) {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      `--from-file is too large (${stats.size} bytes; limit ${maxBytes}). ` +
        'Spec descriptions should be a short problem statement, not a document dump.',
    );
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(resolved);
  } catch (cause) {
    throw ioError('read description file', resolved, cause);
  }
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      `--from-file is not valid UTF-8: ${resolved}. Re-save the file as UTF-8 and retry.`,
    );
  }
  const description = text.replace(new RegExp('^\\uFEFF'), '').trim();
  if (description.length === 0) {
    throw new SpecBridgeError('INVALID_ARGUMENT', `--from-file is empty: ${resolved}.`);
  }
  return description;
}

/**
 * Validate a creation request and produce the full plan without writing
 * anything. Throws `SpecBridgeError` with actionable messages on invalid
 * input or an already-existing spec.
 */
export function planSpecCreation(
  workspace: WorkspaceInfo,
  request: SpecCreationRequest,
  clock: Clock = systemClock,
): SpecCreationPlan {
  const nameCheck = validateSpecName(request.name);
  if (!nameCheck.valid) {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      `Invalid spec name "${request.name}":\n${nameCheck.problems.map((p) => `  - ${p}`).join('\n')}\n` +
        'Valid examples: notification-preferences, auth-v2, payment-retry.',
    );
  }

  const specType = request.specType ?? 'feature';
  const mode = request.mode ?? 'requirements-first';

  if (request.description !== undefined && request.fromFile !== undefined) {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      'Use either --description or --from-file, not both.',
    );
  }

  let description = request.description?.trim();
  if (description !== undefined && description.length === 0) {
    throw new SpecBridgeError('INVALID_ARGUMENT', '--description must not be empty.');
  }
  if (request.fromFile !== undefined) {
    description = readDescriptionFile(
      workspace,
      request.fromFile,
      request.cwd ?? workspace.rootDir,
      request.maxDescriptionBytes ?? DEFAULT_MAX_DESCRIPTION_BYTES,
    );
  }
  const descriptionIsPlaceholder = description === undefined;
  if (description === undefined) {
    description = specType === 'bugfix' ? DEFAULT_BUGFIX_DESCRIPTION : DEFAULT_FEATURE_DESCRIPTION;
  }

  const requestedTitle = request.title?.trim();
  const title =
    requestedTitle !== undefined && requestedTitle.length > 0
      ? requestedTitle
      : titleFromSpecName(request.name);

  const dir = assertInsideWorkspace(
    workspace.rootDir,
    path.join(workspace.rootDir, KIRO_DIR_NAME, KIRO_SPECS_DIR, request.name),
  );

  if (existsSync(dir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir).sort((a, b) => a.localeCompare(b, 'en'));
    } catch {
      // A file (not a directory) with the spec name also blocks creation.
    }
    throw new SpecBridgeError(
      'SPEC_ALREADY_EXISTS',
      `Spec "${request.name}" already exists at ${dir}.\n` +
        (entries.length > 0 ? `Existing files: ${entries.join(', ')}.\n` : '') +
        `SpecBridge never overwrites an existing spec. Inspect it with "spec show ${request.name}", ` +
        'or choose a different name.',
    );
  }

  const files = renderSpecTemplates(specType, mode, { title, description });
  const state = newSpecState(request.name, specType, mode, clock);

  return {
    specName: request.name,
    specType,
    mode,
    title,
    description,
    descriptionIsPlaceholder,
    dir,
    files,
    state,
    statePath: specStatePath(workspace, request.name),
  };
}

/**
 * Execute a creation plan atomically:
 * 1. render every file into `.specbridge/tmp/<unique>/`,
 * 2. rename that directory to `.kiro/specs/<name>` (one atomic step),
 * 3. write sidecar state.
 *
 * If the state write fails, the freshly renamed spec directory (which cannot
 * contain user edits yet) is removed again — all or nothing.
 */
export function executeSpecCreation(
  workspace: WorkspaceInfo,
  plan: SpecCreationPlan,
): SpecCreationResult {
  const tmpParent = path.join(workspace.sidecarDir, 'tmp');
  const tempDir = path.join(
    tmpParent,
    `spec-new-${plan.specName}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );

  const specsDir = path.dirname(plan.dir);
  const writtenFiles: string[] = [];

  try {
    mkdirSync(tempDir, { recursive: true });
    for (const file of plan.files) {
      writeFileAtomic(path.join(tempDir, file.fileName), file.content);
    }

    mkdirSync(specsDir, { recursive: true });
    // Re-check just before the rename: another process may have created the
    // spec since planning. rename onto an existing directory fails anyway,
    // but this produces the friendlier error.
    if (existsSync(plan.dir)) {
      throw new SpecBridgeError(
        'SPEC_ALREADY_EXISTS',
        `Spec "${plan.specName}" already exists at ${plan.dir}; nothing was written.`,
      );
    }
    try {
      renameSync(tempDir, plan.dir);
    } catch (cause) {
      throw ioError('create spec directory', plan.dir, cause);
    }
    for (const file of plan.files) {
      writtenFiles.push(path.join(plan.dir, file.fileName));
    }

    let statePath: string;
    try {
      statePath = writeSpecState(workspace, plan.state);
    } catch (cause) {
      // The spec directory was created by this very call and holds only
      // rendered templates; remove it so the workspace is unchanged.
      rmSync(plan.dir, { recursive: true, force: true });
      throw cause;
    }

    return { plan, writtenFiles, statePath };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    try {
      rmdirSync(tmpParent);
    } catch {
      // Not empty or already gone — either is fine.
    }
  }
}

/** Plan and execute in one step (the non-dry-run `spec new` path). */
export function createSpec(
  workspace: WorkspaceInfo,
  request: SpecCreationRequest,
  clock: Clock = systemClock,
): SpecCreationResult {
  return executeSpecCreation(workspace, planSpecCreation(workspace, request, clock));
}
