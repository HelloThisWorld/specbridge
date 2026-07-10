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
