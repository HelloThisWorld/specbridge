import { z } from 'zod';
import { validateRunnerBaseUrl } from './url-safety.js';

/**
 * Optional research policy (vNext.10.2 Phase 2).
 *
 * Research is deliberately disabled twice by default: both the generic
 * layer and its initial provider must be enabled. Merely upgrading an
 * existing workspace therefore cannot create network traffic.
 */

export const RESEARCH_STRATEGIES = ['ON_DEMAND'] as const;
export type ResearchStrategy = (typeof RESEARCH_STRATEGIES)[number];

const environmentVariableNameSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'must be an environment-variable NAME; SpecBridge never stores token values',
  );

export const deerFlowResearchProviderConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().min(1).max(2048).default('http://127.0.0.1:2026'),
    /** Name of the environment variable holding the internal-auth token. */
    internalAuthTokenEnvironmentVariable: environmentVariableNameSchema.nullable().default(null),
    /** Non-secret isolation key sent with internal authentication. */
    ownerUserId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:@-]+$/)
      .default('specbridge'),
    timeoutMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
    maxEventBytes: z.number().int().min(1_024).max(2_097_152).default(262_144),
    maxTotalResponseBytes: z.number().int().min(1_024).max(16_777_216).default(2_097_152),
    /** Explicit development-only override for a remote plain-HTTP endpoint. */
    allowInsecureHttp: z.boolean().default(false),
  })
  .passthrough()
  .superRefine((config, ctx) => {
    const validation = validateRunnerBaseUrl(config.baseUrl, {
      allowInsecureHttp: config.allowInsecureHttp,
    });
    for (const problem of validation.problems) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['baseUrl'], message: problem });
    }
  });
export type DeerFlowResearchProviderConfig = z.infer<
  typeof deerFlowResearchProviderConfigSchema
>;

export const researchPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/).default('deerflow'),
    strategy: z.enum(RESEARCH_STRATEGIES).default('ON_DEMAND'),
    maxQuickPerOperation: z.number().int().min(0).max(100).default(5),
    maxDeepPerOperation: z.number().int().min(0).max(20).default(2),
    maxResearchPerJob: z.number().int().min(0).max(200).default(6),
    providers: z
      .object({
        deerflow: deerFlowResearchProviderConfigSchema.default({}),
      })
      .passthrough()
      .default({}),
  })
  .passthrough();
export type ResearchPolicy = z.infer<typeof researchPolicySchema>;
