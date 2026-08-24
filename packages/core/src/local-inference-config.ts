import path from 'node:path';
import { z } from 'zod';

/**
 * Local copy of the safe-string refinement (agent-config.ts defines the
 * canonical one). Duplicated rather than imported because agent-config.ts
 * imports this module: a load-time zod cycle would evaluate one of the two
 * schemas against an uninitialised binding.
 */
const safeNonEmptyString = z
  .string()
  .refine((value) => !value.includes('\0'), { message: 'must not contain null bytes' })
  .refine((value) => value.length > 0, { message: 'must not be empty' });

/**
 * Local inference configuration (v1.2): a SpecBridge-managed llama.cpp
 * server used for inexpensive reasoning roles (classification, planning,
 * critique, diagnosis, replanning). Stored additively inside
 * `.specbridge/config.json` — NEVER inside `.kiro`, which stays free of
 * machine-specific runtime configuration.
 *
 * Safety rules, enforced here and re-asserted by the process manager:
 *   - disabled by default; nothing is spawned until the user opts in
 *   - the server binds to loopback only; there is no configuration value
 *     that can widen the bind address
 *   - `extraArgs` may tune model parameters but can never override the
 *     host, port, or path arguments the manager owns
 *   - paths are file paths on the user's machine; they are validated for
 *     existence at start time, never copied into the repository, and never
 *     required to be inside the workspace
 *   - no credentials: a local llama.cpp server has none, and no field here
 *     accepts one
 */

export const LOCAL_INFERENCE_PROVIDERS = ['llama.cpp'] as const;
export type LocalInferenceProvider = (typeof LOCAL_INFERENCE_PROVIDERS)[number];

/**
 * Arguments the LocalModelManager owns. Allowing them in `extraArgs` would
 * let configuration silently rebind the server away from loopback or detach
 * it from the managed model file, so they are rejected at parse time.
 */
export const RESERVED_LLAMA_SERVER_FLAGS = [
  '--host',
  '--port',
  '-m',
  '--model',
  '--path',
  '--api-key',
  '--api-key-file',
  '--ssl-key-file',
  '--ssl-cert-file',
] as const;

const boundedArgsSchema = (fieldName: string) =>
  z
    .array(safeNonEmptyString.refine((value) => value.length <= 256, { message: 'argument too long' }))
    .max(32)
    .default([])
    .superRefine((args, ctx) => {
      for (const argument of args) {
        const flag = argument.split('=')[0] ?? argument;
        if ((RESERVED_LLAMA_SERVER_FLAGS as readonly string[]).includes(flag)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `${fieldName} must not contain "${flag}": the local model manager owns binding, ` +
              'model selection, and credentials-related flags.',
          });
        }
      }
    });

const extraArgsSchema = boundedArgsSchema('extraArgs');

export const localInferenceConfigSchema = z
  .object({
    provider: z.enum(LOCAL_INFERENCE_PROVIDERS).default('llama.cpp'),
    /** Nothing starts until this is explicitly true. */
    enabled: z.boolean().default(false),
    /** Path to the llama.cpp server executable (e.g. llama-server[.exe]). */
    executable: safeNonEmptyString.nullable().default(null),
    /**
     * Arguments placed BEFORE the managed flags (wrapper launchers, e.g. a
     * script interpreter). Reserved flags are rejected here exactly as in
     * extraArgs; the managed `--host 127.0.0.1` always follows these.
     */
    executableArgs: boundedArgsSchema('executableArgs'),
    /** Path to the GGUF model file. */
    model: safeNonEmptyString.nullable().default(null),
    /** TCP port; 0 (default) allocates a free loopback port per start. */
    port: z.number().int().min(0).max(65_535).default(0),
    /** Context window passed to the server (`-c`). */
    contextSize: z.number().int().min(512).max(1_048_576).default(8_192),
    /**
     * Parallel request slots (`-np`): one managed server serves several
     * logical roles, so a couple of slots avoid head-of-line blocking while
     * bounding memory.
     */
    parallel: z.number().int().min(1).max(8).default(2),
    /** GPU layers (`-ngl`); null omits the flag (llama.cpp default). */
    gpuLayers: z.number().int().min(0).max(1_000).nullable().default(null),
    /** Sampling temperature for role requests (0 = deterministic-ish). */
    temperature: z.number().min(0).max(2).default(0),
    /** How long a model load may take before startup counts as failed. */
    startupTimeoutMs: z.number().int().min(5_000).max(1_800_000).default(180_000),
    /** Per-request inference timeout. */
    requestTimeoutMs: z.number().int().min(1_000).max(3_600_000).default(180_000),
    /** Stop the managed server after this long without a request. */
    idleShutdownMs: z.number().int().min(10_000).max(86_400_000).default(300_000),
    /** Bounded automatic restarts after an unexpected exit. */
    maxRestarts: z.number().int().min(0).max(5).default(1),
    /** Response ceiling per inference request. */
    maxOutputBytes: z.number().int().min(1_024).max(16_777_216).default(1_048_576),
    /** Bounded stdout/stderr retention from the server process. */
    maxLogBytes: z.number().int().min(4_096).max(4_194_304).default(262_144),
    /** Prompt ceiling per role request, in characters. */
    maximumInputCharacters: z.number().int().min(1_000).max(2_000_000).default(48_000),
    /** Extra llama-server arguments (reserved flags rejected above). */
    extraArgs: extraArgsSchema,
  })
  .passthrough();
export type LocalInferenceConfig = z.infer<typeof localInferenceConfigSchema>;

export function defaultLocalInferenceConfig(): LocalInferenceConfig {
  return localInferenceConfigSchema.parse({});
}


/**
 * Characters per token, deliberately LOW.
 *
 * Under-estimating how much text a token holds under-estimates how much text
 * the context holds, which is the safe direction: the guard refuses a packet
 * slightly too early rather than handing the server one it will reject.
 * Code and JSON tokenize closer to 3 characters than English prose does.
 */
const CHARACTERS_PER_TOKEN = 3;

/** Share of the context the PROMPT may occupy; the rest is for the answer. */
const INPUT_SHARE_OF_CONTEXT = 0.6;

/**
 * The prompt ceiling that actually holds, in characters.
 *
 * `maximumInputCharacters` and `contextSize` are configured independently and
 * their defaults contradict each other: 48,000 characters is roughly 14,000
 * tokens, and the default context is 8,192. A packet between the two limits
 * passed every check SpecBridge made and was then refused by the server as a
 * bare HTTP 400.
 *
 * The vNext.10.1 dogfood lost a task to exactly that. The semantic evaluator's
 * packet cleared the character guard, llama-server answered 400, and the unit
 * was rejected — while an oversize packet caught HERE escalates to the large
 * tier and never fails the task at all. The difference between a clean
 * escalation and a burnt budget was one unenforced relationship.
 */
export function effectiveLocalInputCharacters(config: {
  maximumInputCharacters: number;
  contextSize: number;
}): number {
  const fitsInContext = Math.floor(
    config.contextSize * CHARACTERS_PER_TOKEN * INPUT_SHARE_OF_CONTEXT,
  );
  return Math.max(1_000, Math.min(config.maximumInputCharacters, fitsInContext));
}

export interface LocalInferenceValidation {
  ok: boolean;
  problems: string[];
}

/**
 * Static validation of a local-inference block: is it complete enough to
 * start a server? File existence is checked by the manager at start time —
 * this answers "is the configuration coherent", not "is the machine ready".
 */
export function validateLocalInferenceConfig(
  config: LocalInferenceConfig,
): LocalInferenceValidation {
  const problems: string[] = [];
  if (!config.enabled) {
    problems.push('localInference.enabled is false; the managed local model is off.');
  }
  if (config.executable === null) {
    problems.push('localInference.executable is not set (path to llama-server).');
  } else if (!path.isAbsolute(config.executable)) {
    problems.push('localInference.executable must be an absolute path.');
  }
  if (config.model === null) {
    problems.push('localInference.model is not set (path to a GGUF model file).');
  } else if (!path.isAbsolute(config.model)) {
    problems.push('localInference.model must be an absolute path.');
  }
  return { ok: problems.length === 0, problems };
}
