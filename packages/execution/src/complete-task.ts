import {
  MarkdownDocument,
  applyCheckboxState,
  taskPlanHash,
  writeDocumentAtomic,
} from '@specbridge/compat-kiro';
import type { StageName, WorkspaceInfo } from '@specbridge/core';
import {
  SpecBridgeError,
  TASK_PLAN_HASH_SEMANTICS_VERSION,
  readSpecState,
  sha256File,
  stateStage,
  writeSpecState,
} from '@specbridge/core';
import type { Clock } from '@specbridge/workflow';
import { isoNow } from '@specbridge/workflow';
import { stageDocumentPath } from './write-stage.js';

/**
 * Surgical, verified-only task completion.
 *
 * Only evidence status `verified` or `manually-accepted` reaches this code.
 * The update flips exactly one checkbox character on exactly one line; every
 * other byte of tasks.md stays identical (the v0.1 round-trip guarantee).
 *
 * Because SpecBridge itself made this sanctioned edit, the recorded tasks
 * approval hash is re-recorded against the new bytes — otherwise its own
 * checkbox update would trip the stale-approval detector.
 */

export interface CheckboxUpdateResult {
  filePath: string;
  /** 0-based line index that changed. */
  line: number;
  before: string;
  after: string;
  /** True when the tasks approval hash was re-recorded after the edit. */
  approvalRehashed: boolean;
  newHash?: string;
}

export function completeTaskCheckbox(
  workspace: WorkspaceInfo,
  specName: string,
  expected: { line: number; rawLineText: string },
  clock: Clock,
): CheckboxUpdateResult {
  const filePath = stageDocumentPath(workspace, specName, 'tasks' as StageName);
  const document = MarkdownDocument.load(filePath);

  if (expected.line >= document.lineCount) {
    throw new SpecBridgeError(
      'INVALID_STATE',
      `tasks.md changed since the task was selected: line ${expected.line + 1} no longer exists. The checkbox was NOT updated.`,
    );
  }
  const currentText = document.lineAt(expected.line).text;
  if (currentText !== expected.rawLineText) {
    throw new SpecBridgeError(
      'INVALID_STATE',
      `tasks.md changed since the task was selected: line ${expected.line + 1} no longer matches the selected task. ` +
        'The checkbox was NOT updated. Re-run the task selection.',
      { expected: expected.rawLineText, actual: currentText },
    );
  }

  const originalLines = document.lines.map((line) => line.text);
  const changed = applyCheckboxState(document, expected.line, 'done');
  if (!changed.changed) {
    throw new SpecBridgeError(
      'INVALID_STATE',
      `Task checkbox on line ${expected.line + 1} is already [x]; refusing a redundant update.`,
    );
  }

  // Safety net: exactly one line may differ from the original.
  const changedLines = document.lines.filter((line, index) => line.text !== originalLines[index]);
  if (changedLines.length !== 1) {
    throw new SpecBridgeError(
      'INVALID_STATE',
      `Checkbox update would have changed ${changedLines.length} lines; refusing to write.`,
    );
  }

  writeDocumentAtomic(document, filePath, { workspaceRoot: workspace.rootDir });
  const after = document.lineAt(expected.line).text;

  // Re-record the tasks approval hash for SpecBridge's own sanctioned edit.
  // The checkbox-normalized plan hash (semantics v2) is recorded alongside —
  // a checkbox flip cannot change it, so this also migrates pre-v0.4 state
  // that only stored the exact byte hash.
  let approvalRehashed = false;
  let newHash: string | undefined;
  const stateRead = readSpecState(workspace, specName);
  if (stateRead.state !== undefined) {
    const tasksStage = stateStage(stateRead.state, 'tasks');
    if (tasksStage !== undefined && tasksStage.status === 'approved') {
      newHash = sha256File(filePath);
      const planHash = taskPlanHash(MarkdownDocument.load(filePath));
      const nextState = {
        ...stateRead.state,
        stages: {
          ...stateRead.state.stages,
          tasks: {
            ...tasksStage,
            approvedHash: newHash,
            approvedAt: isoNow(clock),
            approvedPlanHash: planHash,
            hashAlgorithm: 'sha256' as const,
            hashSemanticsVersion: TASK_PLAN_HASH_SEMANTICS_VERSION,
          },
        },
        updatedAt: isoNow(clock),
      };
      writeSpecState(workspace, nextState);
      approvalRehashed = true;
    }
  }

  return {
    filePath,
    line: expected.line,
    before: expected.rawLineText,
    after,
    approvalRehashed,
    ...(newHash !== undefined ? { newHash } : {}),
  };
}
