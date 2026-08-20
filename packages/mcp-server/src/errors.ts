import { isSpecBridgeError } from '@specbridge/core';
import { isMissionError } from '@specbridge/mission';
import { isOrchestrationError } from '@specbridge/orchestration';

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
  // v1.1 governed orchestration. Additive: no existing code changes meaning.
  SBMCP021: 'orchestration disabled',
  SBMCP022: 'orchestration run not found',
  SBMCP023: 'orchestration state invalid',
  SBMCP024: 'orchestration phase invalid',
  SBMCP025: 'clarification required',
  SBMCP026: 'execution plan required',
  SBMCP027: 'execution plan stale',
  SBMCP028: 'plan review required',
  SBMCP029: 'orchestration budget exhausted',
  SBMCP030: 'orchestration request rejected',
  // Mission Discovery. Additive: no existing code changes meaning.
  SBMCP031: 'mission not found',
  SBMCP032: 'mission state invalid',
  SBMCP033: 'mission request rejected',
  SBMCP034: 'mission decision requires a human',
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
  // Orchestration domain errors carry their own stable SBO code, remediation,
  // and retry semantics. Mapping happens here, once, so no handler invents an
  // ad-hoc message for a governed refusal.
  if (isOrchestrationError(cause)) {
    const code = sbmcpCodeForOrchestrationError(cause.code);
    return {
      code,
      category: SBMCP_CODES[code],
      message: cause.message,
      remediation: cause.remediation,
      details: {
        ...cause.details,
        orchestrationCode: cause.code,
        ...(cause.failureCategory !== undefined ? { failureCategory: cause.failureCategory } : {}),
        retryable: cause.retryable,
      },
    };
  }
  // Mission domain errors carry their own stable SBM code and remediation.
  if (isMissionError(cause)) {
    const code = sbmcpCodeForMissionError(cause.code);
    return {
      code,
      category: SBMCP_CODES[code],
      message: cause.message,
      remediation: cause.remediation,
      details: { ...cause.details, missionCode: cause.code },
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

/** SBO (orchestration domain) → SBMCP (MCP contract). One place, no drift. */
function sbmcpCodeForOrchestrationError(code: string): SbmcpCode {
  switch (code) {
    case 'SBO001':
      return 'SBMCP021';
    case 'SBO002':
      return 'SBMCP022';
    case 'SBO003':
      return 'SBMCP023';
    case 'SBO004':
    case 'SBO005':
    case 'SBO019':
      return 'SBMCP024';
    case 'SBO006':
    case 'SBO007':
    case 'SBO008':
      return 'SBMCP025';
    case 'SBO009':
    case 'SBO010':
      return 'SBMCP026';
    case 'SBO011':
      return 'SBMCP027';
    case 'SBO012':
      return 'SBMCP028';
    case 'SBO013':
    case 'SBO014':
    case 'SBO015':
    case 'SBO016':
    case 'SBO017':
    case 'SBO018':
    case 'SBO020':
      return 'SBMCP029';
    case 'SBO021':
      return 'SBMCP018';
    case 'SBO022':
    case 'SBO024':
      return 'SBMCP030';
    case 'SBO023':
      return 'SBMCP006';
    default:
      return 'SBMCP020';
  }
}

function sbmcpCodeForMissionError(code: string): SbmcpCode {
  switch (code) {
    case 'SBM001':
      return 'SBMCP031';
    case 'SBM002':
      return 'SBMCP032';
    case 'SBM003':
    case 'SBM004':
    case 'SBM005':
    case 'SBM006':
    case 'SBM009':
    case 'SBM010':
    case 'SBM011':
    case 'SBM013':
    case 'SBM014':
      return 'SBMCP033';
    case 'SBM007':
    case 'SBM008':
    case 'SBM012':
      return 'SBMCP034';
    default:
      return 'SBMCP020';
  }
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
