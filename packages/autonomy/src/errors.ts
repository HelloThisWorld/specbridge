/**
 * Stable autonomy error codes (`SBA###`).
 *
 * A separate registry from the CLI's `SpecBridgeErrorCode`, the mission
 * package's `SBM###`, and orchestration's `SBO###`. Those are published
 * numbering spaces; renumbering any of them would break the v1.x contract,
 * and folding autonomy into one of them would make the dependency direction
 * ambiguous. Every code carries a safe message and remediation. Raw
 * exceptions are never surfaced as user-facing failure semantics.
 */
export const SBA_CODES = {
  SBA001: 'autonomy disabled by policy',
  SBA002: 'mission seal not found',
  SBA003: 'mission seal invalid',
  SBA004: 'mission seal not executable',
  SBA005: 'mission seal incomplete',
  SBA006: 'autonomy policy drift since seal',
  SBA007: 'product authority required',
  SBA008: 'supervisor lease held by another owner',
  SBA009: 'supervisor state invalid',
  SBA010: 'supervisor restart budget exhausted',
  SBA011: 'overnight preflight refused launch',
  SBA012: 'toolsmith capability denied',
  SBA013: 'toolsmith grant budget exhausted',
  SBA014: 'environment plan invalid',
  SBA015: 'environment provisioning failed',
  SBA016: 'environment runtime unavailable',
  SBA017: 'browser scenario invalid',
  SBA018: 'browser runtime unavailable',
  SBA019: 'ux critique rejected',
  SBA020: 'contract closure incomplete',
  SBA021: 'closure budget exhausted',
  SBA022: 'control plane repair refused',
  SBA023: 'control plane repair would weaken an invariant',
  SBA024: 'autonomy record invalid',
  SBA025: 'certification run invalid',
} as const;

export type SbaCode = keyof typeof SBA_CODES;

export interface AutonomyErrorOptions {
  remediation?: string[];
  details?: Record<string, unknown>;
  /** True only for failures a bounded automatic retry may address. */
  retryable?: boolean;
}

export class AutonomyError extends Error {
  readonly code: SbaCode;
  readonly category: string;
  readonly remediation: string[];
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(code: SbaCode, message: string, options: AutonomyErrorOptions = {}) {
    super(message);
    this.name = 'AutonomyError';
    this.code = code;
    this.category = SBA_CODES[code];
    this.remediation = options.remediation ?? [];
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? false;
  }
}

export function isAutonomyError(value: unknown): value is AutonomyError {
  return value instanceof AutonomyError;
}
