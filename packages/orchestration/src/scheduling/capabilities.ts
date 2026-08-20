import type { AgentConfig } from '@specbridge/core';
import { validateLocalInferenceConfig } from '@specbridge/core';

/**
 * Local provider capabilities (vNext.2): an explicit, honest record of what
 * the local integration actually provides — derived from configuration,
 * never asserted optimistically.
 *
 * The local model is a NATIVE MODEL endpoint: SpecBridge drives the loop.
 * It therefore has no tool calling, no shell, and no native compaction;
 * file editing exists only as SpecBridge-applied structured edits behind
 * deterministic verification, and context is managed entirely by the
 * SpecBridge ContextLifecycleManager. Fields describing the model's own
 * reasoning/coding strength are configuration-declared coarse levels used
 * for documentation and diagnostics — routing decides by suitability class
 * and verification, never by these labels.
 */

export type LocalCapabilityLevel = 'none' | 'basic' | 'moderate';

export interface LocalProviderCapabilities {
  /** The provider is configured, enabled, and coherent. */
  available: boolean;
  /** Configuration problems when not available. */
  problems: string[];
  structuredOutput: boolean;
  toolCalling: false;
  shellAccess: false;
  /** Source mutation happens only as SpecBridge-applied validated edits. */
  fileEditing: 'none' | 'specbridge-applied';
  /** The local endpoint has no native compaction; SpecBridge compacts. */
  nativeCompaction: 'none';
  /** Context window configured for the managed server, in tokens. */
  contextLimitTokens: number;
  /** Prompt ceiling per request, in characters. */
  maxInputCharacters: number;
  reasoningLevel: LocalCapabilityLevel;
  codingLevel: LocalCapabilityLevel;
}

/** Derive the local capability record from configuration. Pure. */
export function localProviderCapabilities(config: AgentConfig): LocalProviderCapabilities {
  const local = config.localInference;
  const validation = validateLocalInferenceConfig(local);
  const available = local.enabled && validation.ok;
  const allowExecution = config.orchestration.jobs.scheduler.allowLocalExecution;
  return {
    available,
    problems: validation.problems,
    structuredOutput: true,
    toolCalling: false,
    shellAccess: false,
    fileEditing: available && allowExecution ? 'specbridge-applied' : 'none',
    nativeCompaction: 'none',
    contextLimitTokens: local.contextSize,
    maxInputCharacters: local.maximumInputCharacters,
    // Coarse honest defaults for a Qwen-class small model; diagnostics only.
    reasoningLevel: available ? 'moderate' : 'none',
    codingLevel: available ? 'basic' : 'none',
  };
}
