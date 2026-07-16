import { z } from 'zod';

/**
 * Stable extension kinds. `template-provider` extensions are data-only; the
 * remaining kinds declare an executable entrypoint that SpecBridge runs out
 * of process over the stdio protocol.
 */
export const EXTENSION_KINDS = [
  'template-provider',
  'analyzer',
  'verifier',
  'exporter',
  'runner',
] as const;

export type ExtensionKind = (typeof EXTENSION_KINDS)[number];

export const EXECUTABLE_EXTENSION_KINDS = [
  'analyzer',
  'verifier',
  'exporter',
  'runner',
] as const satisfies readonly ExtensionKind[];

export function isExecutableKind(kind: ExtensionKind): boolean {
  return kind !== 'template-provider';
}

/**
 * The operations each kind may declare. Runner operations mirror the frozen
 * v0.6.0 runner adapter semantics; not every runner operation is required —
 * declared operations determine which protocol methods the host may invoke.
 *
 * `template-provider` declares no operations: template packs are read as data
 * by the existing template system and no extension process is ever started
 * for them.
 */
export const EXTENSION_OPERATIONS_BY_KIND: Record<ExtensionKind, readonly string[]> = {
  'template-provider': [],
  analyzer: ['analyzer.analyze'],
  verifier: ['verifier.verify'],
  exporter: ['exporter.export'],
  runner: [
    'runner.detect',
    'runner.generateStage',
    'runner.refineStage',
    'runner.executeTask',
    'runner.resumeTask',
    'runner.listModels',
  ],
};

export const ALL_EXTENSION_OPERATIONS: readonly string[] = Object.freeze(
  Object.values(EXTENSION_OPERATIONS_BY_KIND).flat(),
);

export type ExtensionOperation = string;

export const MAX_DECLARED_OPERATIONS = 16;

export const extensionCapabilitiesSchema = z
  .object({
    operations: z
      .array(z.string().min(1).max(80))
      .max(MAX_DECLARED_OPERATIONS),
  })
  .strict();

export type ExtensionCapabilities = z.infer<typeof extensionCapabilitiesSchema>;

/** Operations that `kind` extensions are allowed to declare. */
export function operationsForKind(kind: ExtensionKind): readonly string[] {
  return EXTENSION_OPERATIONS_BY_KIND[kind];
}

export function isOperationAllowedForKind(kind: ExtensionKind, operation: string): boolean {
  return EXTENSION_OPERATIONS_BY_KIND[kind].includes(operation);
}

/** The minimum operations a kind must declare to be useful. */
export const REQUIRED_OPERATIONS_BY_KIND: Record<ExtensionKind, readonly string[]> = {
  'template-provider': [],
  analyzer: ['analyzer.analyze'],
  verifier: ['verifier.verify'],
  exporter: ['exporter.export'],
  runner: ['runner.detect'],
};
