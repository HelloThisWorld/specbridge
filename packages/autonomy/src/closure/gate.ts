import type { WorkspaceInfo } from '@specbridge/core';
import type { CompletionAssessment, CompletionGate } from '@specbridge/orchestration';
import { readClosureLedger } from './service.js';
import { missionMayComplete } from './oracle.js';

/**
 * The Contract Closure Ledger, viewed as orchestration's `CompletionGate`.
 *
 * This is the adapter that makes DoD item 13 real at the one place it has to
 * be real: `completeJobIfDone`, the function that actually writes
 * `COMPLETED`. Everything else in the closure machinery can be right and the
 * product can still be declared finished with unimplemented requirements if
 * that function does not ask.
 *
 * Deliberately trivial. All the judgment is in `missionMayComplete`, which is
 * pure and reads only evidence; this file's whole job is to fetch the ledger
 * and translate. A gate with logic of its own would be a second place where
 * "is it complete?" is decided.
 */
export function createClosureCompletionGate(workspace: WorkspaceInfo): CompletionGate {
  return {
    assess(jobId: string): CompletionAssessment {
      const ledger = readClosureLedger(workspace, jobId);
      if (ledger === undefined) {
        // No ledger means this job is not governed by a seal. Refusing here
        // would break every unsealed job, so the gate abstains — and the
        // driver only ever installs a gate for a job that HAS one.
        return { mayComplete: true, reason: 'no closure ledger governs this job', unclosed: 0 };
      }
      const verdict = missionMayComplete(ledger);
      return {
        mayComplete: verdict.mayComplete,
        reason: verdict.reason,
        unclosed: verdict.unclosedIds.length,
      };
    },
  };
}

/**
 * Whether this job is governed by a closure ledger at all.
 *
 * Used to decide whether to install the gate. A job with no ledger completes
 * exactly as it did in v1.2, which is what every unsealed workspace needs.
 */
export function hasClosureLedger(workspace: WorkspaceInfo, jobId: string): boolean {
  return readClosureLedger(workspace, jobId) !== undefined;
}
