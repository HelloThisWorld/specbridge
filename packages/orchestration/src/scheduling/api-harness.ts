import type { HarnessExecutionResult, LocalHarnessExecutionInput } from './local-harness.js';
import { dispatchLocalHarnessExecution } from './local-harness.js';

/**
 * API-lane harness execution (vNext.5).
 *
 * This module is deliberately thin, and its thinness is the design:
 *
 *   SpecBridge
 *       ↓
 *   API ExecutionAttempt
 *       ↓
 *   DeepSeekHarnessRunner          (the vNext.3 runner, unchanged)
 *       ↓
 *   DSH remote/PAYG profile
 *       ↓
 *   agentic work
 *       ↓
 *   SpecBridge Evidence            (the completion authority, unchanged)
 *
 * There is no `ApiAgentLoop`, no `ApiShellRuntime`, and no `ApiFileTools`.
 * A second agentic execution path inside SpecBridge would be a second place
 * for "done" to be decided, a second set of bounds to keep in sync, and a
 * second dependency to maintain — for the sole benefit of the lane that
 * costs money. Paid execution reuses the harness that already exists.
 *
 * The dependency firewall from vNext.3 is preserved exactly: nothing above
 * the runner imports a DSH session, a Cordis context, or a provider
 * internal type. The API scheduler reasons only about neutral SpecBridge
 * structures — `ApiHarnessBinding`, `ApiCostEstimate`, `ExecutionLane.API`,
 * `ApiBudgetReservation`.
 */

export interface ApiHarnessExecutionInput extends Omit<LocalHarnessExecutionInput, 'lane'> {
  /**
   * The bound API harness profile name. Its compute locality has already
   * been verified REMOTE (or admitted by the explicit override) by
   * `resolveApiHarnessBinding`; this function does not re-derive economics
   * from the profile name, because names are not evidence.
   */
  profileName: string;
}

/**
 * Run ONE bounded paid agentic attempt through the interactive evidence
 * path — the same begin → execute → verify pipeline every other lane uses.
 *
 * What is deliberately NOT different for paid work: the wall-clock bound,
 * the protected paths, the trusted verification commands, the failure
 * classification, and above all the verdict. A more expensive model saying
 * "done" carries exactly the authority a local model's claim does, which is
 * none — the repository diff and the verification commands decide.
 */
export function dispatchApiHarnessExecution(
  input: ApiHarnessExecutionInput,
): Promise<HarnessExecutionResult> {
  return dispatchLocalHarnessExecution({ ...input, lane: 'API' });
}
