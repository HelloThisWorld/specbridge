import type { DriveOptions, DriverDeps, DriverStop } from '@specbridge/orchestration';
import { driveJob } from '@specbridge/orchestration';

/**
 * How the supervisor actually runs a driver.
 *
 * An interface rather than a call, for three reasons that all matter:
 *
 *   The certification injects a host that CRASHES on demand. Proving
 *   "a terminated driver is restarted without a human" needs a driver that
 *   can be terminated deterministically, and killing real processes in a
 *   test suite is neither deterministic nor kind to CI.
 *
 *   In-process and child-process supervision are genuinely different
 *   trade-offs, and both are legitimate. In-process is simpler and is what
 *   `specbridge mission build --unattended` uses; child-process survives a
 *   driver that corrupts its own heap, at the cost of a process boundary.
 *
 *   The supervisor's own logic should not know or care. Every decision it
 *   makes is about lease state, job status, and progress — none of which
 *   changes depending on where the driver ran.
 *
 * A host NEVER throws for an ordinary driver failure. It returns a
 * `crashed` outcome, because a crashed driver is a normal event in this
 * runtime and an exception would make the supervisor's own loop the thing
 * that has to be exception-safe on every path.
 */

export type DriverRunOutcome =
  | { kind: 'exited'; stop: DriverStop }
  | { kind: 'crashed'; error: string }
  | { kind: 'aborted' };

export interface DriverHostRequest {
  jobId: string;
  signal?: AbortSignal | undefined;
  onEvent?: ((event: { kind: string; message: string }) => void) | undefined;
}

export interface DriverHost {
  readonly label: string;
  run(request: DriverHostRequest): Promise<DriverRunOutcome>;
}

/**
 * The in-process host: calls the real driver in this process.
 *
 * The `catch` is the point. `driveJob` throws for genuine defects — an
 * invalid state document, a budget assertion, a runner contract violation —
 * and in an INTERACTIVE session that exception is the right user experience.
 * Under supervision it is an event: the driver died, the job's durable state
 * is whatever it committed before dying, and the supervisor decides whether
 * restarting is worth it. Converting the throw here rather than in the loop
 * keeps the supervisor free of driver-specific error handling.
 */
export function createInProcessDriverHost(
  deps: DriverDeps,
  options: Omit<DriveOptions, 'signal' | 'onEvent'> = {},
): DriverHost {
  return {
    label: 'in-process',
    async run(request: DriverHostRequest): Promise<DriverRunOutcome> {
      try {
        const result = await driveJob(deps, request.jobId, {
          ...options,
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
          ...(request.onEvent !== undefined
            ? { onEvent: (event) => request.onEvent?.({ kind: event.kind, message: event.message }) }
            : {}),
        });
        if (result.stop.kind === 'interrupted' && request.signal?.aborted === true) {
          return { kind: 'aborted' };
        }
        return { kind: 'exited', stop: result.stop };
      } catch (cause) {
        return {
          kind: 'crashed',
          error: (cause instanceof Error ? cause.message : String(cause)).slice(0, 2_000),
        };
      }
    },
  };
}
