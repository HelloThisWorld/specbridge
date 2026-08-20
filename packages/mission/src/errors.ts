/**
 * Stable mission error codes (`SBM###`).
 *
 * A separate registry from the CLI's `SpecBridgeErrorCode`, the MCP server's
 * `SBMCP###` codes, and orchestration's `SBO###` codes — those are published
 * numbering spaces and the mission package must not depend on
 * @specbridge/orchestration (the dependency points the other way: the
 * objective runtime reads mission contracts).
 *
 * Every code carries a safe message and remediation. Raw exceptions are
 * never surfaced as user-facing failure semantics.
 */
export const SBM_CODES = {
  SBM001: 'mission not found',
  SBM002: 'mission state invalid',
  SBM003: 'invalid mission transition',
  SBM004: 'mission already final',
  SBM005: 'mission input rejected',
  SBM006: 'mission record bound exceeded',
  SBM007: 'insufficient provenance for a decision',
  SBM008: 'mission coverage gate unsatisfied',
  SBM009: 'mission artifact not found',
  SBM010: 'mission artifact conflict',
  SBM011: 'spec synthesis failed validation',
  SBM012: 'human decision required',
  SBM013: 'contract change request invalid',
  SBM014: 'mission prerequisite unsatisfied',
} as const;

export type SbmCode = keyof typeof SBM_CODES;

export interface MissionErrorOptions {
  remediation?: string[];
  details?: Record<string, unknown>;
}

export class MissionError extends Error {
  readonly code: SbmCode;
  readonly category: string;
  readonly remediation: string[];
  readonly details: Record<string, unknown>;

  constructor(code: SbmCode, message: string, options: MissionErrorOptions = {}) {
    super(message);
    this.name = 'MissionError';
    this.code = code;
    this.category = SBM_CODES[code];
    this.remediation = options.remediation ?? [];
    this.details = options.details ?? {};
  }
}

export function isMissionError(value: unknown): value is MissionError {
  return value instanceof MissionError;
}
