import { SpecBridgeError } from '@specbridge/core';
import { EXTENSION_ERROR_CODES, type ExtensionErrorCode } from '@specbridge/extension-sdk';

export { EXTENSION_ERROR_CODES } from '@specbridge/extension-sdk';
export type { ExtensionErrorCode } from '@specbridge/extension-sdk';

/**
 * An extension-domain error. Extends `SpecBridgeError` so the existing CLI
 * and MCP error handling render it without special cases; the stable `SBE`
 * code is embedded in the message and carried in `details.extensionCode`.
 */
export class ExtensionError extends SpecBridgeError {
  readonly extensionCode: ExtensionErrorCode;
  /** Actionable next step, always present. */
  readonly remediation: string;

  constructor(
    extensionCode: ExtensionErrorCode,
    detail: string,
    remediation: string,
    details?: Record<string, unknown>,
  ) {
    super(
      'EXTENSION_ERROR',
      `${extensionCode} (${EXTENSION_ERROR_CODES[extensionCode]}): ${detail} ${remediation}`,
      { ...details, extensionCode },
    );
    this.name = 'ExtensionError';
    this.extensionCode = extensionCode;
    this.remediation = remediation;
  }
}

export function isExtensionError(value: unknown): value is ExtensionError {
  return value instanceof ExtensionError;
}
