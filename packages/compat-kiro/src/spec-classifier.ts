import type {
  Diagnostic,
  SpecCompleteness,
  SpecFileKind,
  SpecType,
  SpecWorkflowState,
  WorkflowMode,
} from '@specbridge/core';
import type { SpecFolder } from './spec-discovery.js';
import { specFile } from './spec-discovery.js';

/**
 * Spec classification.
 *
 * The file layout alone cannot distinguish requirements-first, design-first,
 * and quick feature specs — the on-disk shape is identical. When sidecar
 * state is available we report the recorded workflow; otherwise we say
 * `unknown` instead of inventing an answer.
 */

export interface SpecClassification {
  type: SpecType;
  workflowMode: WorkflowMode;
  completeness: SpecCompleteness;
  presentKinds: SpecFileKind[];
  missingKinds: SpecFileKind[];
  diagnostics: Diagnostic[];
}

const FEATURE_REQUIRED: SpecFileKind[] = ['requirements', 'design', 'tasks'];
const BUGFIX_REQUIRED: SpecFileKind[] = ['bugfix', 'design', 'tasks'];

export function classifySpec(folder: SpecFolder, state?: SpecWorkflowState): SpecClassification {
  const diagnostics: Diagnostic[] = [];
  const presentKinds: SpecFileKind[] = [...new Set(folder.files.map((f) => f.kind))].filter(
    (kind): kind is SpecFileKind => kind !== 'other',
  );

  const hasBugfix = specFile(folder, 'bugfix') !== undefined;
  let type: SpecType;
  if (hasBugfix) {
    type = 'bugfix';
    if (specFile(folder, 'requirements') !== undefined) {
      diagnostics.push({
        severity: 'info',
        code: 'SPEC_MIXED_TYPE_FILES',
        message:
          'Spec contains both bugfix.md and requirements.md; classified as a bugfix spec.',
        file: folder.dir,
      });
    }
  } else if (presentKinds.length > 0) {
    type = 'feature';
  } else {
    type = 'unknown';
    diagnostics.push({
      severity: 'warning',
      code: 'SPEC_NO_KNOWN_FILES',
      message:
        'Spec folder contains no recognized files (requirements.md, design.md, tasks.md, bugfix.md).',
      file: folder.dir,
    });
  }

  if (state !== undefined && state.specType !== type && type !== 'unknown') {
    diagnostics.push({
      severity: 'warning',
      code: 'SIDECAR_TYPE_MISMATCH',
      message: `Sidecar state records type "${state.specType}" but the files look like a ${type} spec.`,
      file: folder.dir,
    });
  }

  const workflowMode: WorkflowMode = state?.workflowMode ?? 'unknown';

  const required = type === 'bugfix' ? BUGFIX_REQUIRED : FEATURE_REQUIRED;
  const missingKinds = required.filter((kind) => !presentKinds.includes(kind));
  let completeness: SpecCompleteness;
  if (presentKinds.length === 0) completeness = 'empty';
  else if (missingKinds.length === 0) completeness = 'complete';
  else completeness = 'partial';

  return { type, workflowMode, completeness, presentKinds, missingKinds, diagnostics };
}
