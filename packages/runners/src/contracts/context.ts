import { z } from 'zod';

/**
 * Provider context capabilities (vNext.1 Survival Runtime, additive).
 *
 * What a runner declares about its context handling so the survival runtime
 * can budget and plan compaction WITHOUT branching on provider names:
 *
 *   - how large the model context window is (when the adapter knows);
 *   - whether the provider compacts its own session working memory, exposes
 *     an explicit compaction operation, or has none;
 *   - whether provider sessions persist across invocations (resume).
 *
 * The rule this layer encodes, identical to @specbridge/context:
 * provider-native compaction and provider sessions are WORKING MEMORY. They
 * never replace the structured SpecBridge checkpoint, and cross-provider
 * continuity never depends on them. A provider that reports nothing here
 * still executes — SpecBridge falls back to its configured default budget
 * and its own generic compaction.
 *
 * Additive exactly like `declaredSupportLevel` (v0.6.1): an optional
 * readonly on the adapter; existing external adapters are unaffected.
 */

export const RUNNER_CONTEXT_CAPABILITIES_SCHEMA_VERSION = '1.0.0';

/** Mirrors @specbridge/context NATIVE_COMPACTION_MODES (kept dependency-free). */
export const RUNNER_NATIVE_COMPACTION_MODES = ['none', 'automatic', 'explicit'] as const;
export type RunnerNativeCompactionMode = (typeof RUNNER_NATIVE_COMPACTION_MODES)[number];

export const runnerContextCapabilitiesSchema = z
  .object({
    schemaVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .default(RUNNER_CONTEXT_CAPABILITIES_SCHEMA_VERSION),
    /**
     * Advertised context window in tokens; null when the adapter cannot know
     * (e.g. the model is user-configured). Never guessed: null means "use
     * the configured default budget".
     */
    contextWindowTokens: z.number().int().min(1_000).nullable().default(null),
    /** How the provider compacts its own session working memory. */
    nativeCompaction: z.enum(RUNNER_NATIVE_COMPACTION_MODES).default('none'),
    /** True when provider sessions can be resumed across invocations. */
    supportsSessionPersistence: z.boolean().default(false),
  })
  .strict();
export type RunnerContextCapabilities = z.infer<typeof runnerContextCapabilitiesSchema>;

/** The conservative declaration for adapters that say nothing. */
export function defaultRunnerContextCapabilities(): RunnerContextCapabilities {
  return runnerContextCapabilitiesSchema.parse({});
}
