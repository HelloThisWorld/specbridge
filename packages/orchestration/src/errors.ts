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
