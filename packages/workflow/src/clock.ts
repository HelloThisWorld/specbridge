/**
 * Injectable clock. Everything that stamps a timestamp accepts a `Clock`
 * so tests (and dry runs) can be fully deterministic.
 */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

export function isoNow(clock: Clock): string {
  return clock().toISOString();
}
