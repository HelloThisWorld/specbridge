import type { NativeCompactionMode } from './vocabulary.js';

/**
 * Provider-native compaction boundary.
 *
 * Some providers can compact their own session working memory (an agent CLI
 * compacting its conversation, an API exposing an opaque compacted
 * representation). SpecBridge integrates with that through this adapter so
 * the runtime never branches on provider names — it asks the adapter.
 *
 * THE RULE, stated once and enforced by the architecture:
 *
 *   Provider-native compaction is provider/session WORKING MEMORY only.
 *   It never replaces the structured SpecBridge Checkpoint, and it is never
 *   canonical state. A provider-A compacted session cannot carry a task to
 *   provider B; cross-provider continuity relies exclusively on SpecBridge
 *   durable state (Job, Task, Attempt, Checkpoint) plus repository state.
 *
 * A provider without native compaction simply reports mode 'none' and the
 * generic SpecBridge compaction path applies.
 */

/** Opaque reference to one provider session (working memory, disposable). */
export interface ProviderSessionRef {
  providerId: string;
  sessionId: string;
  model?: string | undefined;
}

export interface NativeCompactionResult {
  ok: boolean;
  /** The session to continue with (may be the same reference). */
  session: ProviderSessionRef;
  /** What happened, for the execution ledger — never reasoning content. */
  detail: string;
}

export interface NativeCompactionAdapter {
  readonly providerId: string;
  /** How this provider compacts its own working memory. */
  readonly mode: NativeCompactionMode;
  supportsNativeCompaction(): boolean;
  /**
   * Compact the provider session's working memory. Only meaningful for
   * mode 'explicit'; 'automatic' providers return ok with a detail note,
   * 'none' providers return ok:false.
   */
  compact(session: ProviderSessionRef): Promise<NativeCompactionResult>;
  /**
   * Resume the provider session where the provider supports it. Resuming a
   * session is an OPTIMIZATION — losing the session must never lose the
   * task, because canonical state lives in SpecBridge.
   */
  resume(session: ProviderSessionRef): Promise<NativeCompactionResult>;
}

/**
 * Adapter for providers whose compaction is automatic (self-managed) or
 * absent. Both are honest no-ops from SpecBridge's side; the difference is
 * reported, never acted on.
 */
export function passthroughNativeCompaction(
  providerId: string,
  mode: Extract<NativeCompactionMode, 'automatic' | 'none'>,
): NativeCompactionAdapter {
  return {
    providerId,
    mode,
    supportsNativeCompaction: () => mode === 'automatic',
    compact: (session) =>
      Promise.resolve({
        ok: mode === 'automatic',
        session,
        detail:
          mode === 'automatic'
            ? `Provider ${providerId} compacts its own session working memory; nothing to trigger.`
            : `Provider ${providerId} has no native compaction; SpecBridge generic compaction applies.`,
      }),
    resume: (session) =>
      Promise.resolve({
        ok: true,
        session,
        detail: `Session ${session.sessionId} passed through; canonical state remains SpecBridge durable state.`,
      }),
  };
}
