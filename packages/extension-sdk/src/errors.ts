/**
 * Stable extension error codes SBE001–SBE030.
 *
 * The registry below is the single source of truth and is part of the public
 * extension contract: extension authors, the SpecBridge host, and generated
 * documentation all reference these codes. Codes are stable — they are never
 * renumbered, and a removed code would leave a documented gap rather than
 * shifting later codes.
 */
export const EXTENSION_ERROR_CODES = {
  SBE001: 'extension not found',
  SBE002: 'ambiguous extension reference',
  SBE003: 'invalid extension ID',
  SBE004: 'invalid extension manifest',
  SBE005: 'unsupported extension schema',
  SBE006: 'incompatible SpecBridge version',
  SBE007: 'incompatible protocol version',
  SBE008: 'invalid extension package',
  SBE009: 'checksum mismatch',
  SBE010: 'forbidden package file',
  SBE011: 'symlink rejected',
  SBE012: 'invalid entrypoint',
  SBE013: 'extension already installed',
  SBE014: 'extension not installed',
  SBE015: 'extension disabled',
  SBE016: 'permission acknowledgement required',
  SBE017: 'permission hash mismatch',
  SBE018: 'permission grant stale',
  SBE019: 'extension handshake failed',
  SBE020: 'extension identity mismatch',
  SBE021: 'unsupported extension operation',
  SBE022: 'extension protocol corrupted',
  SBE023: 'extension timed out',
  SBE024: 'extension cancelled',
  SBE025: 'extension output too large',
  SBE026: 'extension process failed',
  SBE027: 'extension conformance failed',
  SBE028: 'extension in use',
  SBE029: 'active profile references extension',
  SBE030: 'extension operation failed',
} as const;

export type ExtensionErrorCode = keyof typeof EXTENSION_ERROR_CODES;

/** Validation issue categories mirrored from the template validation model. */
export const EXTENSION_VALIDATION_CATEGORIES = [
  'manifest',
  'compatibility',
  'permissions',
  'capabilities',
  'paths',
  'files',
  'checksums',
  'limits',
  'protocol',
  'documentation',
] as const;

export type ExtensionValidationCategory = (typeof EXTENSION_VALIDATION_CATEGORIES)[number];

/**
 * A non-throwing validation finding. Validation APIs accumulate issues so a
 * single run reports every problem instead of stopping at the first one.
 */
export interface ExtensionValidationIssue {
  readonly code: ExtensionErrorCode;
  readonly category: ExtensionValidationCategory;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly file?: string;
}

export function extensionIssue(
  code: ExtensionErrorCode,
  category: ExtensionValidationCategory,
  severity: 'error' | 'warning',
  message: string,
  file?: string,
): ExtensionValidationIssue {
  return file === undefined
    ? { code, category, severity, message }
    : { code, category, severity, message, file };
}
