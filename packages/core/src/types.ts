/**
 * Shared vocabulary for the whole SpecBridge toolchain.
 *
 * Branding note: the project working name is "SpecBridge". Keep every
 * user-visible brand string routed through these constants so a rename
 * only touches this file and the package manifests.
 */

export const PRODUCT_NAME = 'SpecBridge';
export const CLI_BIN = 'specbridge';

/** Directory owned by Kiro-compatible tooling. Always the source of truth. */
export const KIRO_DIR_NAME = '.kiro';
export const KIRO_STEERING_DIR = 'steering';
export const KIRO_SPECS_DIR = 'specs';

/** Directory owned by SpecBridge for runtime state. Never mixed into `.kiro`. */
export const SIDECAR_DIR_NAME = '.specbridge';

/** Steering files Kiro creates by default. Any other `.md` file is "additional". */
export const DEFAULT_STEERING_FILES = ['product.md', 'tech.md', 'structure.md'] as const;

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  /** Stable machine-readable code, e.g. `TASKS_MALFORMED_CHECKBOX`. */
  code: string;
  message: string;
  /** Absolute or workspace-relative file path the diagnostic refers to. */
  file?: string;
  /** 1-based line number for display. */
  line?: number;
}

export type SpecFileKind = 'requirements' | 'design' | 'tasks' | 'bugfix' | 'other';

export type SpecType = 'feature' | 'bugfix' | 'unknown';

export type WorkflowMode = 'requirements-first' | 'design-first' | 'quick' | 'unknown';

/** Spec type as stored in sidecar state — never `unknown` once managed. */
export type ConcreteSpecType = 'feature' | 'bugfix';

/** Workflow mode as stored in sidecar state — never `unknown` once managed. */
export type ConcreteWorkflowMode = 'requirements-first' | 'design-first' | 'quick';

/**
 * Approvable workflow stages. Feature specs use requirements/design/tasks;
 * bugfix specs replace the requirements stage with bugfix.
 */
export const STAGE_NAMES = ['requirements', 'bugfix', 'design', 'tasks'] as const;
export type StageName = (typeof STAGE_NAMES)[number];

/**
 * Stored per-stage status. `blocked` means prerequisite stages are not
 * approved yet; `draft` means the stage is editable and approvable.
 * Approval is only ever recorded here — never inferred from file existence.
 */
export type StageStatus = 'blocked' | 'draft' | 'approved';

/** How the sidecar state for a spec came to exist. */
export type SpecOrigin = 'created-by-specbridge' | 'existing-kiro-workspace';

/**
 * Workflow status values stored in sidecar state. Which values a spec can
 * reach depends on its type and workflow mode (see @specbridge/workflow).
 */
export const WORKFLOW_STATUS_VALUES = [
  'REQUIREMENTS_DRAFT',
  'REQUIREMENTS_APPROVED',
  'BUGFIX_DRAFT',
  'BUGFIX_APPROVED',
  'DESIGN_DRAFT',
  'DESIGN_APPROVED',
  'TASKS_DRAFT',
  'READY_FOR_REVIEW',
  'READY_FOR_IMPLEMENTATION',
] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUS_VALUES)[number];

/**
 * Overall approval health of a spec, computed at read time:
 * - `ok`        — every recorded approval still matches the file bytes
 * - `stale`     — an approved file changed after approval (or a dependent
 *                 approval was invalidated by that change)
 * - `unmanaged` — the spec has no sidecar state (existing Kiro workspace)
 * - `invalid`   — sidecar state exists but could not be used
 */
export type ApprovalHealth = 'ok' | 'stale' | 'unmanaged' | 'invalid';

export type SpecCompleteness = 'complete' | 'partial' | 'empty';

export interface TaskProgress {
  /** Required (non-optional) tasks. */
  total: number;
  completed: number;
  inProgress: number;
  /** Tasks flagged optional (`- [ ]*` or "(optional)" in the title). */
  optionalTotal: number;
  optionalCompleted: number;
}

export const EMPTY_TASK_PROGRESS: TaskProgress = {
  total: 0,
  completed: 0,
  inProgress: 0,
  optionalTotal: 0,
  optionalCompleted: 0,
};

export function maxSeverity(diagnostics: readonly Diagnostic[]): DiagnosticSeverity | undefined {
  let max: DiagnosticSeverity | undefined;
  for (const d of diagnostics) {
    if (d.severity === 'error') return 'error';
    if (d.severity === 'warning') max = 'warning';
    else if (max === undefined) max = 'info';
  }
  return max;
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}
