import type { BrowserObservation, BrowserScenario, BrowserStep } from './state.js';

/**
 * The browser driver contract.
 *
 * SpecBridge does not want to own a browser automation library, and it does
 * not want to be one. What it owns is the SCENARIO MODEL and the EVIDENCE:
 * which assertions ran, what they observed, what was captured, and whether
 * any of it may close a contract item. The driver below is the thin thing in
 * the middle.
 *
 * Three properties the contract enforces on any implementation:
 *
 *   A step either succeeds or reports why it did not. It never throws for an
 *   ordinary assertion failure, because a failing assertion is the expected
 *   outcome of half the scenarios that matter.
 *
 *   Contexts are isolated. `Player A` and `Player B` must not share cookies,
 *   storage, or a session, or a multi-user scenario proves nothing about
 *   multi-user behaviour.
 *
 *   Observations accumulate. Console errors and failed requests are collected
 *   throughout, not sampled at the end, because the interesting ones happen
 *   during a transition and are gone by the time the scenario finishes.
 */

export interface BrowserStepOutcome {
  ok: boolean;
  /** One line. Never a page dump, never a full response body. */
  detail: string;
  /** Bytes of evidence this step produced, e.g. a screenshot. */
  evidence?: { kind: 'SCREENSHOT' | 'DOM_SNAPSHOT'; label: string; data: Buffer | string } | undefined;
}

export interface BrowserSession {
  /** Run one step in its named context. */
  step(step: BrowserStep): Promise<BrowserStepOutcome>;
  /** Everything observed so far. */
  observations(): readonly BrowserObservation[];
  /** Capture the current DOM of one context, bounded. */
  snapshot(context: string, maxBytes: number): Promise<string>;
  close(): Promise<void>;
}

export interface BrowserDriverOpenRequest {
  scenario: BrowserScenario;
  /** Viewport applied to every context before the first step. */
  viewport: { width: number; height: number };
  navigationTimeoutMs: number;
  signal?: AbortSignal | undefined;
}

export interface BrowserDriver {
  readonly label: string;
  /**
   * Whether this driver can actually run right now.
   *
   * Separate from `open` on purpose: "the browser runtime is not installed"
   * is a SKIP with a reason, and a driver that discovered that by throwing
   * inside `open` would be indistinguishable from a scenario that failed.
   */
  available(): Promise<{ ok: true } | { ok: false; reason: string }>;
  open(request: BrowserDriverOpenRequest): Promise<BrowserSession>;
}

/** Parse a `WIDTHxHEIGHT` viewport string. */
export function parseViewport(value: string): { width: number; height: number } {
  const [width, height] = value.split('x').map((part) => Number.parseInt(part, 10));
  return { width: width ?? 1280, height: height ?? 800 };
}
