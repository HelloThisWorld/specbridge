export type SpecBridgeErrorCode =
  | 'WORKSPACE_NOT_FOUND'
  | 'SPEC_NOT_FOUND'
  | 'STEERING_NOT_FOUND'
  | 'SPEC_FILE_NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'PARSE_ERROR'
  | 'IO_ERROR'
  | 'INVALID_STATE'
  | 'NOT_IMPLEMENTED';

export class SpecBridgeError extends Error {
  readonly code: SpecBridgeErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: SpecBridgeErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'SpecBridgeError';
    this.code = code;
    this.details = details;
  }
}

export function isSpecBridgeError(value: unknown): value is SpecBridgeError {
  return value instanceof SpecBridgeError;
}

/**
 * Honest placeholder for functionality that is documented on the roadmap but
 * intentionally not implemented yet. Callers must surface the message as-is
 * instead of pretending the feature exists.
 */
export function notImplemented(feature: string, plannedPhase: string): SpecBridgeError {
  return new SpecBridgeError(
    'NOT_IMPLEMENTED',
    `${feature} is not implemented yet. It is planned for ${plannedPhase}. ` +
      'See docs/roadmap.md for the current status.',
    { feature, plannedPhase },
  );
}

/** Wrap a filesystem error with the path that caused it. */
export function ioError(action: string, targetPath: string, cause: unknown): SpecBridgeError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new SpecBridgeError('IO_ERROR', `Failed to ${action} ${targetPath}: ${reason}`, {
    path: targetPath,
  });
}
