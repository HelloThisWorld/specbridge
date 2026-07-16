import { SpecBridgeError } from '@specbridge/core';

/**
 * Stable registry error codes SBR001–SBR015.
 *
 * The registry below is the single source of truth. Codes are stable: they
 * are never renumbered, and a removed code would leave a documented gap.
 * Every raised error carries an actionable remediation in its message.
 */
export const REGISTRY_ERROR_CODES = {
  SBR001: 'registry not found',
  SBR002: 'invalid registry name',
  SBR003: 'invalid registry configuration',
  SBR004: 'registry network flag required',
  SBR005: 'registry fetch failed',
  SBR006: 'registry response too large',
  SBR007: 'invalid registry index',
  SBR008: 'unsupported registry schema',
  SBR009: 'registry redirect rejected',
  SBR010: 'registry cache unavailable',
  SBR011: 'extension version not found',
  SBR012: 'archive integrity metadata missing',
  SBR013: 'archive download failed',
  SBR014: 'archive checksum mismatch',
  SBR015: 'registry operation failed',
} as const;

export type RegistryErrorCode = keyof typeof REGISTRY_ERROR_CODES;

/**
 * A registry-domain error. Extends `SpecBridgeError` so existing CLI and MCP
 * error handling render it without special cases; the stable `SBR` code is
 * embedded in the message and carried in `details.registryCode`.
 */
export class RegistryError extends SpecBridgeError {
  readonly registryCode: RegistryErrorCode;
  /** Actionable next step, always present. */
  readonly remediation: string;

  constructor(
    registryCode: RegistryErrorCode,
    detail: string,
    remediation: string,
    details?: Record<string, unknown>,
  ) {
    super(
      'REGISTRY_ERROR',
      `${registryCode} (${REGISTRY_ERROR_CODES[registryCode]}): ${detail} ${remediation}`,
      { ...details, registryCode },
    );
    this.name = 'RegistryError';
    this.registryCode = registryCode;
    this.remediation = remediation;
  }
}

export function isRegistryError(value: unknown): value is RegistryError {
  return value instanceof RegistryError;
}
