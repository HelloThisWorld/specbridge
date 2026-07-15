import { SpecBridgeError } from '@specbridge/core';

/**
 * Stable template error codes SBT001–SBT025.
 *
 * The registry below is the single source of truth. Codes are stable: they are
 * never renumbered, and a removed code would leave a documented gap rather
 * than shifting later codes. Every raised error carries an actionable
 * remediation in its message; stack traces are never part of normal output.
 */
export const TEMPLATE_ERROR_CODES = {
  SBT001: 'template not found',
  SBT002: 'ambiguous template reference',
  SBT003: 'invalid template ID',
  SBT004: 'invalid manifest',
  SBT005: 'unsupported template schema',
  SBT006: 'incompatible SpecBridge version',
  SBT007: 'invalid source path',
  SBT008: 'path traversal detected',
  SBT009: 'symlink rejected',
  SBT010: 'undeclared template file',
  SBT011: 'invalid target file',
  SBT012: 'duplicate target file',
  SBT013: 'missing required variable',
  SBT014: 'unknown variable',
  SBT015: 'invalid variable value',
  SBT016: 'unresolved placeholder',
  SBT017: 'rendered output invalid',
  SBT018: 'rendered output too large',
  SBT019: 'template pack too large',
  SBT020: 'spec already exists',
  SBT021: 'template already installed',
  SBT022: 'built-in template cannot be uninstalled',
  SBT023: 'candidate hash mismatch',
  SBT024: 'acknowledgement required',
  SBT025: 'template operation failed',
} as const;

export type TemplateErrorCode = keyof typeof TEMPLATE_ERROR_CODES;

/**
 * A template-domain error. Extends `SpecBridgeError` so the existing CLI and
 * MCP error handling render it without special cases; the stable `SBT` code
 * is embedded in the message and carried in `details.templateCode`.
 */
export class TemplateError extends SpecBridgeError {
  readonly templateCode: TemplateErrorCode;
  /** Actionable next step, always present. */
  readonly remediation: string;

  constructor(
    templateCode: TemplateErrorCode,
    detail: string,
    remediation: string,
    details?: Record<string, unknown>,
  ) {
    super('TEMPLATE_ERROR', `${templateCode} (${TEMPLATE_ERROR_CODES[templateCode]}): ${detail} ${remediation}`, {
      ...details,
      templateCode,
    });
    this.name = 'TemplateError';
    this.templateCode = templateCode;
    this.remediation = remediation;
  }
}

export function isTemplateError(value: unknown): value is TemplateError {
  return value instanceof TemplateError;
}
