/**
 * Stable spec-intake error codes (`SBI###`).
 *
 * A separate registry from the CLI's `SpecBridgeError`, the mission
 * package's `SBM###`, orchestration's `SBO###`, and autonomy's `SBA###`.
 * Those are published numbering spaces; folding intake into one of them
 * would make the dependency direction ambiguous and renumbering any of them
 * would break the v1.x contract.
 *
 * Every code carries a safe message and remediation. Raw exceptions are
 * never surfaced as user-facing failure semantics.
 */
export const SBI_CODES = {
  SBI001: 'spec intake not found',
  SBI002: 'spec intake state invalid',
  SBI003: 'invalid spec intake transition',
  SBI004: 'spec intake already final',
  SBI005: 'spec intake input rejected',
  SBI006: 'spec intake bound exceeded',
  SBI007: 'source specification unreadable',
  SBI008: 'repository grounding failed',
  SBI009: 'delta authority analysis incomplete',
  SBI010: 'intake is not ready for approval',
  SBI011: 'intake approval not found',
  SBI012: 'intake approval is not human authority',
  SBI013: 'derived approval refused: the artifact diverges from approved truth',
  SBI014: 'build lifecycle step failed',
  SBI015: 'overnight prerequisite requires a person',
  SBI016: 'product baseline invalid',
  SBI017: 'intake record already exists',
} as const;

export type SbiCode = keyof typeof SBI_CODES;

export interface IntakeErrorOptions {
  remediation?: string[];
  details?: Record<string, unknown>;
  /** True only for failures a bounded automatic retry may address. */
  retryable?: boolean;
}

export class IntakeError extends Error {
  readonly code: SbiCode;
  readonly category: string;
  readonly remediation: string[];
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(code: SbiCode, message: string, options: IntakeErrorOptions = {}) {
    super(message);
    this.name = 'IntakeError';
    this.code = code;
    this.category = SBI_CODES[code];
    this.remediation = options.remediation ?? [];
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? false;
  }
}

export function isIntakeError(value: unknown): value is IntakeError {
  return value instanceof IntakeError;
}
