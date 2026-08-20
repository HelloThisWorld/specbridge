import type { FailureCategory } from './vocabulary.js';

/**
 * Stable orchestration error codes (`SBO###`).
 *
 * A separate registry from the CLI's `SpecBridgeErrorCode` and the MCP
 * server's `SBMCP###` codes, deliberately: those are already-published
 * numbering spaces and renumbering them would break the v1.x contract. The
 * MCP layer maps these onto its own codes in one place
 * (packages/mcp-server/src/tools/orchestration-shared.ts) instead of each
 * handler inventing a message.
 *
 * Every code carries a safe message, remediation, and retry semantics. Raw
 * exceptions are never surfaced as user-facing failure semantics.
 */
export const SBO_CODES = {
  SBO001: 'orchestration disabled by policy',
  SBO002: 'orchestration run not found',
  SBO003: 'orchestration state invalid',
  SBO004: 'invalid phase transition',
  SBO005: 'orchestration run already final',
  SBO006: 'intent assessment required',
  SBO007: 'clarification required',
  SBO008: 'clarification rounds exhausted',
  SBO009: 'execution plan required',
  SBO010: 'execution plan invalid',
  SBO011: 'execution plan stale',
  SBO012: 'plan review required',
  SBO013: 'replan budget exhausted',
  SBO014: 'iteration budget exhausted',
  SBO015: 'repair budget exhausted',
  SBO016: 'no progress detected',
  SBO017: 'transient retry budget exhausted',
  SBO018: 'elapsed time budget exhausted',
  SBO019: 'action not allowed in current phase',
  SBO020: 'orchestration event history full',
  SBO021: 'input too large',
  SBO022: 'completion requires verified evidence',
  SBO023: 'orchestration prerequisite unsatisfied',
  SBO024: 'orchestration request rejected',
  // v1.2 job orchestration codes. Additive: nothing above may be renumbered.
  SBO025: 'jobs disabled by policy',
  SBO026: 'job already final',
  SBO027: 'invalid job transition',
  SBO028: 'invalid node transition',
  SBO029: 'job not found',
  SBO030: 'job state invalid',
  SBO031: 'job graph invalid',
  SBO032: 'job budget exhausted',
  SBO033: 'human decision required',
  SBO034: 'no worker available for role',
  SBO035: 'local inference not configured',
  SBO036: 'local model process failure',
  SBO037: 'invalid agent output',
  SBO038: 'job prerequisite unsatisfied',
  // Objective-runtime codes. Additive: nothing above may be renumbered.
  SBO039: 'work graph invalid',
  SBO040: 'work unit state invalid',
  SBO041: 'context projection stale',
  SBO042: 'worker identity rejected',
  SBO043: 'candidate artifact invalid',
  SBO044: 'evaluation failed closed',
  SBO045: 'contract conflict requires decision',
  SBO046: 'aggregation prerequisite unsatisfied',
  SBO047: 'integration failed',
  SBO048: 'worktree operation failed',
  // Survival-runtime codes (vNext.1). Additive: nothing above may be renumbered.
  SBO049: 'execution attempt state invalid',
  SBO050: 'task checkpoint invalid',
  SBO051: 'context reconstruction failed',
} as const;

export type SboCode = keyof typeof SBO_CODES;

export interface OrchestrationErrorOptions {
  remediation?: string[];
  details?: Record<string, unknown>;
  failureCategory?: FailureCategory;
  /** True only for failures a bounded automatic retry may address. */
  retryable?: boolean;
}

export class OrchestrationError extends Error {
  readonly code: SboCode;
  readonly category: string;
  readonly remediation: string[];
  readonly details: Record<string, unknown>;
  readonly failureCategory: FailureCategory | undefined;
  readonly retryable: boolean;

  constructor(code: SboCode, message: string, options: OrchestrationErrorOptions = {}) {
    super(message);
    this.name = 'OrchestrationError';
    this.code = code;
    this.category = SBO_CODES[code];
    this.remediation = options.remediation ?? [];
    this.details = options.details ?? {};
    this.failureCategory = options.failureCategory;
    this.retryable = options.retryable ?? false;
  }
}

export function isOrchestrationError(value: unknown): value is OrchestrationError {
  return value instanceof OrchestrationError;
}
