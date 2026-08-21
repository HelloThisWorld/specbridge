import type { ExecutionOutcome } from '@specbridge/core';
import type { NormalizedRunnerError } from '../contracts/errors.js';
import { runnerError } from '../contracts/errors.js';
import type { DshFailure } from './sdk-adapter.js';

/**
 * DeepSeek Harness failure normalization: every SDK/transport/runtime
 * failure becomes one of the stable SpecBridge runner error codes before it
 * reaches orchestration, attempt records, or reports.
 *
 * Raw upstream errors may carry environment details or provider payloads —
 * normalized errors never do. Messages are adapter-authored; the only
 * upstream fragments preserved are bounded failure texts and numeric
 * JSON-RPC codes (as `providerCode`).
 */

const AUTH_PATTERN = /unauthorized|unauthenticated|authentication|api key|401/i;
const QUOTA_PATTERN = /insufficient_quota|quota|usage limit|out of credits|balance/i;
const RATE_PATTERN = /rate limit|too many requests|429/i;
const MODEL_PATTERN = /unknown (model|provider)|model .* not (found|available)|no adapter/i;

/** Classify one adapter failure plus the run's turn-end errors. */
export function classifyDshFailure(
  failure: DshFailure,
  turnErrors: readonly string[] = [],
): { error: NormalizedRunnerError; outcome: ExecutionOutcome } {
  switch (failure.kind) {
    case 'closed-by-adapter': {
      if (failure.closeCause === 'cancelled') {
        return {
          outcome: 'cancelled',
          error: runnerError({
            code: 'cancelled',
            message: 'The DeepSeek Harness run was cancelled; the runtime was shut down and reaped.',
          }),
        };
      }
      if (failure.closeCause === 'timed-out') {
        return {
          outcome: 'timed-out',
          error: runnerError({
            code: 'timed_out',
            message:
              'The DeepSeek Harness run exceeded the configured timeout. The wire protocol has ' +
              'no mid-turn cancel, so the runtime was shut down and reaped.',
            remediation: ['Increase the profile timeoutMs or narrow the task.'],
          }),
        };
      }
      return {
        outcome: 'failed',
        error: runnerError({
          code: 'session_unavailable',
          message:
            'The DSH session referenced for resume did not restore its history (the runtime ' +
            'started it empty). The run was stopped before any agentic work.',
          remediation: [
            'Continue from the SpecBridge checkpoint with a fresh attempt — canonical task state never depends on provider sessions.',
          ],
        }),
      };
    }
    case 'launch':
      return {
        outcome: 'failed',
        error: runnerError({
          code: 'executable_not_found',
          message: 'The configured DeepSeek Harness runtime command could not be started.',
          remediation: [
            'Check runnerProfiles.<profile>.command — the launch spec is explicit; SpecBridge never assumes a global "dsh" command.',
          ],
        }),
      };
    case 'identity-mismatch':
      return {
        outcome: 'failed',
        error: runnerError({
          code: 'runner_incompatible',
          message: failure.message,
          remediation: [
            'Point the profile command at a DeepSeek Harness SDK runtime (`dsh-jsonrpc-agent`).',
          ],
        }),
      };
    case 'request-timeout':
      return {
        outcome: 'timed-out',
        error: runnerError({
          code: 'timed_out',
          message: 'A DeepSeek Harness protocol request exceeded its bound; the runtime was reaped.',
          remediation: ['Raise handshakeTimeoutMs if the runtime is legitimately slow to start.'],
        }),
      };
    case 'protocol-violation':
      return {
        outcome: 'failed',
        error: runnerError({
          code: 'runner_incompatible',
          message:
            'The DeepSeek Harness runtime answered outside its documented protocol. The tested ' +
            'SDK pin may not match the launched runtime version.',
          remediation: ['Align the runtime with the pinned SDK (see runner doctor for versions).'],
        }),
      };
    case 'rpc-error': {
      const text = failure.message;
      if (AUTH_PATTERN.test(text)) {
        return {
          outcome: 'failed',
          error: runnerError({
            code: 'authentication_required',
            message: 'The DeepSeek Harness runtime reported an authentication failure.',
            remediation: [
              'Authenticate the runtime profile yourself (SpecBridge never handles credentials).',
            ],
            ...(failure.rpcCode !== undefined ? { providerCode: String(failure.rpcCode) } : {}),
          }),
        };
      }
      if (QUOTA_PATTERN.test(text)) {
        return {
          outcome: 'failed',
          error: runnerError({
            code: 'quota_exceeded',
            message: 'The provider behind the DeepSeek Harness runtime reported an exhausted quota.',
            ...(failure.rpcCode !== undefined ? { providerCode: String(failure.rpcCode) } : {}),
          }),
        };
      }
      if (RATE_PATTERN.test(text)) {
        return {
          outcome: 'failed',
          error: runnerError({
            code: 'rate_limited',
            message: 'The provider behind the DeepSeek Harness runtime reported a rate limit.',
            remediation: ['Wait and retry explicitly.'],
            ...(failure.rpcCode !== undefined ? { providerCode: String(failure.rpcCode) } : {}),
          }),
        };
      }
      if (MODEL_PATTERN.test(text)) {
        return {
          outcome: 'failed',
          error: runnerError({
            code: 'model_not_found',
            message: 'The DeepSeek Harness runtime rejected the configured provider/model route.',
            remediation: ['Fix the profile provider/model to a route the runtime actually mounts.'],
            ...(failure.rpcCode !== undefined ? { providerCode: String(failure.rpcCode) } : {}),
          }),
        };
      }
      return {
        outcome: 'failed',
        error: runnerError({
          code: 'api_error',
          message: `The DeepSeek Harness runtime returned a protocol error: ${boundedMessage(text)}`,
          ...(failure.rpcCode !== undefined ? { providerCode: String(failure.rpcCode) } : {}),
        }),
      };
    }
    case 'transport-closed':
      return {
        outcome: 'failed',
        error: runnerError({
          code: 'process_failed',
          message: `The DeepSeek Harness runtime process died mid-run: ${boundedMessage(failure.message)}`,
          remediation: [
            'Inspect the retained notification log in the run directory; a fresh attempt resumes from the SpecBridge checkpoint.',
          ],
        }),
      };
    case 'unknown':
      return {
        outcome: 'failed',
        error: runnerError({
          code: 'process_failed',
          message: `The DeepSeek Harness run failed: ${boundedMessage(failure.message)}${
            turnErrors.length > 0 ? ` (turn errors: ${boundedMessage(turnErrors.join('; '))})` : ''
          }`,
        }),
      };
  }
}

function boundedMessage(text: string): string {
  return text.length <= 500 ? text : `${text.slice(0, 500)}… [truncated]`;
}
