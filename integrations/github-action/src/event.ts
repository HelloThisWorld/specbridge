import type { ComparisonRequest } from '@specbridge/drift';
import { isSafeGitRef } from '@specbridge/drift';

/**
 * GitHub event → git comparison resolution.
 *
 *   pull_request / pull_request_target:  base SHA … head SHA from the event
 *   push:                                before SHA … after SHA (GITHUB_SHA)
 *   workflow_dispatch and anything else: explicit base-ref/head-ref inputs,
 *                                        otherwise fail with instructions
 *
 * Nothing here assumes `main`, assumes the default branch exists locally, or
 * fetches anything. Unresolvable SHAs are diagnosed downstream by the
 * comparison resolver with the fetch-depth guidance.
 */

const ZERO_SHA = /^0{40}$/;

export interface EventResolutionInput {
  eventName: string | undefined;
  /** Parsed GITHUB_EVENT_PATH payload (undefined when absent/unreadable). */
  payload: unknown;
  /** GITHUB_SHA. */
  sha: string | undefined;
  baseRef: string | undefined;
  headRef: string | undefined;
}

export type EventResolution =
  | { ok: true; request: ComparisonRequest; source: string }
  | { ok: false; message: string };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function safeDiff(base: string, head: string, source: string): EventResolution {
  for (const [role, ref] of [
    ['base', base],
    ['head', head],
  ] as const) {
    if (!isSafeGitRef(ref)) {
      return { ok: false, message: `The ${role} ref "${ref}" (${source}) is not a valid git ref.` };
    }
  }
  return { ok: true, request: { mode: 'diff', base, head }, source };
}

export function resolveComparisonFromEvent(input: EventResolutionInput): EventResolution {
  // Explicit inputs always win — they are the only way to steer dispatch runs.
  if (input.baseRef !== undefined) {
    return safeDiff(input.baseRef, input.headRef ?? 'HEAD', 'explicit base-ref/head-ref inputs');
  }
  if (input.headRef !== undefined) {
    return {
      ok: false,
      message: 'Input "head-ref" was set without "base-ref"; a comparison needs both (head-ref defaults to HEAD).',
    };
  }

  const payload = asRecord(input.payload);

  if (input.eventName === 'pull_request' || input.eventName === 'pull_request_target') {
    const pullRequest = asRecord(payload['pull_request']);
    const baseSha = stringField(asRecord(pullRequest['base'])['sha']);
    const headSha = stringField(asRecord(pullRequest['head'])['sha']);
    if (baseSha === undefined || headSha === undefined) {
      return {
        ok: false,
        message:
          'The pull_request event payload has no base/head SHAs; pass base-ref and head-ref explicitly.',
      };
    }
    return safeDiff(baseSha, headSha, `${input.eventName} event`);
  }

  if (input.eventName === 'push') {
    const before = stringField(payload['before']);
    const after = stringField(payload['after']) ?? input.sha;
    if (before === undefined || after === undefined) {
      return {
        ok: false,
        message: 'The push event payload has no before/after SHAs; pass base-ref and head-ref explicitly.',
      };
    }
    if (ZERO_SHA.test(before)) {
      return {
        ok: false,
        message:
          'This push created the branch, so there is no "before" commit to compare against. ' +
          'Pass base-ref explicitly (for example the default branch ref).',
      };
    }
    return safeDiff(before, after, 'push event');
  }

  return {
    ok: false,
    message:
      `Event "${input.eventName ?? '(unknown)'}" carries no comparison range. ` +
      'Set the base-ref (and optionally head-ref) inputs, e.g. base-ref: ${{ github.event.repository.default_branch }}.',
  };
}
