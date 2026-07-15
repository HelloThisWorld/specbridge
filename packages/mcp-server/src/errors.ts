import { isSpecBridgeError } from '@specbridge/core';

/**
 * Stable application error codes for MCP tool results.
 *
 * Ordinary failures are returned as tool results with `isError: true`, a
 * stable `SBMCP` code, an actionable message, and remediation steps —
 * never as JSON-RPC protocol errors. Protocol errors are reserved for
 * malformed MCP requests and schema-invalid arguments, which the SDK
 * rejects before a handler runs.
 *
 * Stack traces never appear in tool results; they are only written to
 * stderr when debug logging is explicitly enabled.
 */

export const SBMCP_CODES = {
  SBMCP001: 'workspace not found',
  SBMCP002: 'invalid tool input',
  SBMCP003: 'spec not found',
  SBMCP004: 'stage not applicable',
  SBMCP005: 'approval stale',
  SBMCP006: 'approval required',
  SBMCP007: 'task not found',
  SBMCP008: 'task already complete',
  SBMCP009: 'dirty working tree',
  SBMCP010: 'interactive run already active',
  SBMCP011: 'run not found',
  SBMCP012: 'run state invalid',
  SBMCP013: 'repository diverged',
  SBMCP014: 'verification failed',
  SBMCP015: 'protected path modified',
  SBMCP016: 'candidate analysis failed',
  SBMCP017: 'current document hash mismatch',
  SBMCP018: 'input too large',
  SBMCP019: 'output too large',
  SBMCP020: 'internal runtime failure',
} as const;

export type SbmcpCode = keyof typeof SBMCP_CODES;

export class McpToolError extends Error {
  readonly code: SbmcpCode;
  readonly remediation: string[];
  readonly details: Record<string, unknown>;

  constructor(
    code: SbmcpCode,
    message: string,
    options: { remediation?: string[]; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'McpToolError';
    this.code = code;
    this.remediation = options.remediation ?? [];
    this.details = options.details ?? {};
  }
}

export function isMcpToolError(value: unknown): value is McpToolError {
  return value instanceof McpToolError;
}

/** Serializable error envelope embedded in `isError` tool results. */
export interface ToolErrorEnvelope {
  code: SbmcpCode;
  category: string;
  message: string;
  remediation: string[];
  details: Record<string, unknown>;
}

/** Map any thrown value onto the stable error envelope. */
export function toErrorEnvelope(cause: unknown): ToolErrorEnvelope {
  if (isMcpToolError(cause)) {
    return {
      code: cause.code,
      category: SBMCP_CODES[cause.code],
      message: cause.message,
      remediation: cause.remediation,
      details: cause.details,
    };
  }
  if (isSpecBridgeError(cause)) {
    const code = sbmcpCodeForSpecBridgeError(cause.code);
    return {
      code,
      category: SBMCP_CODES[code],
      message: cause.message,
      remediation: [],
      details: {},
    };
  }
  return {
    code: 'SBMCP020',
    category: SBMCP_CODES.SBMCP020,
    message: cause instanceof Error ? cause.message : String(cause),
    remediation: [],
    details: {},
  };
}

function sbmcpCodeForSpecBridgeError(code: string): SbmcpCode {
  switch (code) {
    case 'WORKSPACE_NOT_FOUND':
      return 'SBMCP001';
    case 'SPEC_NOT_FOUND':
      return 'SBMCP003';
    // TEMPLATE_ERROR carries its stable SBT code and remediation in the
    // message; at the MCP layer template failures are invalid-input.
    case 'SPEC_ALREADY_EXISTS':
    case 'INVALID_ARGUMENT':
    case 'STEERING_NOT_FOUND':
    case 'SPEC_FILE_NOT_FOUND':
    case 'PATH_OUTSIDE_WORKSPACE':
    case 'TEMPLATE_ERROR':
      return 'SBMCP002';
    case 'INVALID_STATE':
      return 'SBMCP012';
    default:
      return 'SBMCP020';
  }
}
