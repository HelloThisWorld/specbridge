import type { Command } from 'commander';
import type { MarkdownDocument } from '@specbridge/compat-kiro';
import { analyzeSpec, parseTasks, requireSpec } from '@specbridge/compat-kiro';
import { CLI_BIN, EXIT_CODES, SpecBridgeError, stateStage } from '@specbridge/core';
import type { TaskEvidenceRecord } from '@specbridge/evidence';
import { EVIDENCE_SCHEMA_VERSION, captureGitSnapshot, writeTaskEvidence } from '@specbridge/evidence';
import {
  buildEvidenceSpecContext,
  completeTaskCheckbox,
  readRunRecord,
  selectTask,
} from '@specbridge/execution';
import {
  createJsonReport,
  dim,
  okLine,
  reportTitle,
  serializeJsonReport,
  warnLine,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { relPath } from '../context.js';
import { loadExecutionContext } from '../execution-context.js';
import { VERSION } from '../version.js';
import { randomUUID } from 'node:crypto';

/**
 * `specbridge spec accept-task <name> --task <id> --reason <text>` —
 * explicit HUMAN acceptance of a task. Recorded distinctly from automated
 * verification (`manually-accepted`, actor `local-user`, with the reason),
 * then the checkbox is updated surgically. This is the only sanctioned way
 * to complete a task without deterministic evidence — and it never pretends
 * automated verification passed.
 */

interface AcceptTaskOptions {
  task?: string;
  reason?: string;
  run?: string;
  json?: boolean;
}

export function registerSpecAcceptTaskCommand(spec: Command, runtime: CliRuntime): void {
  spec
    .command('accept-task <name>')
    .description('Manually accept a task (recorded as manually-accepted, never as verified)')
    .requiredOption('--task <task-id>', 'task to accept (e.g. 2.3)')
    .requiredOption('--reason <text>', 'why you accept it (required, recorded verbatim)')
    .option('--run <run-id>', 'run this acceptance refers to')
    .option('--json', 'output a machine-readable JSON report')
    .addHelpText(
      'after',
      `
Manual acceptance records: actor local-user, your reason, the timestamp,
and the referenced run (when given) in an append-only evidence record under
.specbridge/evidence/. Reports always show manual acceptance distinctly from
automated verification.

Exit codes: 0 accepted · 1 task already complete or checkbox race · 2 usage.

Example:
  ${CLI_BIN} spec accept-task notification-preferences --task 2.3 \\
    --run 8d4f1c22-… --reason "Verified manually in the local dev environment."`,
    )
    .action(async (name: string, options: AcceptTaskOptions) => {
      const reason = options.reason?.trim() ?? '';
      if (reason.length === 0) {
        throw new SpecBridgeError('INVALID_ARGUMENT', 'Manual acceptance requires a non-empty --reason.');
      }
      const taskId = options.task?.trim() ?? '';
      if (taskId.length === 0) {
        throw new SpecBridgeError('INVALID_ARGUMENT', 'Manual acceptance requires --task <task-id>.');
      }

      const context = loadExecutionContext(runtime);
      const workspace = context.workspace;
      const folder = requireSpec(workspace, name);
      const spec = analyzeSpec(workspace, folder);
      const tasksDocument = spec.documents.tasks;
      if (tasksDocument === undefined) {
        throw new SpecBridgeError('SPEC_FILE_NOT_FOUND', `Spec "${folder.name}" has no tasks.md.`);
      }
      const model = spec.tasks ?? parseTasks(tasksDocument as MarkdownDocument);
      const selection = selectTask(model, tasksDocument, { taskId });
      if (!selection.ok) {
        runtime.err(selection.message);
        runtime.exitCode =
          selection.reason === 'task-already-complete' ? EXIT_CODES.gateFailure : EXIT_CODES.usageError;
        return;
      }
      const task = selection.task;

      let referencedRunId: string | undefined;
      if (options.run !== undefined) {
        const run = readRunRecord(workspace, options.run);
        if (run === undefined) {
          throw new SpecBridgeError('INVALID_ARGUMENT', `Run "${options.run}" was not found under .specbridge/runs/.`);
        }
        if (run.specName !== folder.name || run.taskId !== task.id) {
          throw new SpecBridgeError(
            'INVALID_ARGUMENT',
            `Run ${run.runId} belongs to ${run.specName} task ${run.taskId ?? '(none)'}, not to ${folder.name} task ${task.id}.`,
          );
        }
        referencedRunId = run.runId;
      }

      const clock = (): Date => runtime.now();
      const snapshot = await captureGitSnapshot(workspace.rootDir, { clock });
      const acceptedAt = runtime.now().toISOString();
      const evidenceRunId = referencedRunId ?? `manual-${randomUUID()}`;

      // Checkbox first (it can fail safely on a race); evidence records the result.
      const update = completeTaskCheckbox(
        workspace,
        folder.name,
        { line: task.line, rawLineText: task.rawLineText },
        clock,
      );

      const record: TaskEvidenceRecord = {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        runId: evidenceRunId,
        specName: folder.name,
        taskId: task.id,
        status: 'manually-accepted',
        runner: 'local-user',
        repository: {
          ...(snapshot.head !== undefined ? { headBefore: snapshot.head, headAfter: snapshot.head } : {}),
          ...(snapshot.branch !== undefined ? { branch: snapshot.branch } : {}),
          dirtyBefore: !snapshot.clean,
          dirtyAfter: !snapshot.clean,
        },
        changedFiles: [],
        verificationCommands: [],
        verificationSkipped: true,
        runnerClaims: { changedFiles: [], commandsReported: [], testsReported: [] },
        violations: [],
        warnings: ['manual acceptance: no automated verification was performed'],
        evaluatedAt: acceptedAt,
        manualAcceptance: {
          actor: 'local-user',
          reason,
          acceptedAt,
          ...(referencedRunId !== undefined ? { referencedRunId } : {}),
        },
        specContext: buildEvidenceSpecContext(workspace, folder.name, spec.state, task),
      };
      const evidencePath = writeTaskEvidence(workspace, record);

      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.accept-task/1', `${CLI_BIN} ${VERSION}`, {
              specName: folder.name,
              taskId: task.id,
              status: 'manually-accepted',
              actor: 'local-user',
              reason,
              acceptedAt,
              referencedRunId: referencedRunId ?? null,
              evidencePath,
              checkbox: { file: update.filePath, line: update.line + 1 },
            }),
          ),
        );
        return;
      }

      runtime.out(reportTitle(`Manually accepted: ${folder.name} — task ${task.id}`));
      runtime.out();
      runtime.out(okLine(`Task ${task.id} checkbox updated`, '(surgical [ ] → [x] edit)'));
      runtime.out(okLine('Recorded as MANUALLY ACCEPTED', `actor: local-user`));
      runtime.out(warnLine('No automated verification was performed for this acceptance.'));
      runtime.out(`  Reason: ${reason}`);
      if (referencedRunId !== undefined) runtime.out(`  Referenced run: ${referencedRunId}`);
      const tasksApproved = spec.state !== undefined && stateStage(spec.state, 'tasks')?.status === 'approved';
      if (update.approvalRehashed) {
        runtime.out(dim('  The tasks approval hash was re-recorded for this sanctioned edit.'));
      } else if (tasksApproved) {
        runtime.out(warnLine('The tasks stage approval could not be re-recorded; run spec status.'));
      }
      runtime.out(dim(`  Evidence: ${relPath(workspace, evidencePath)}`));
    });
}
