import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  assertInsideWorkspace,
  writeFileAtomic,
  type Diagnostic,
  type WorkspaceInfo,
} from '@specbridge/core';
import { RegistryError } from './errors.js';
import { MAX_REGISTRY_NAME_LENGTH, REGISTRY_NAME_PATTERN } from './schema.js';

/**
 * Registry source configuration: `.specbridge/registries.json`.
 *
 * Three source kinds exist — `builtin` (the example index embedded in this
 * repository), `local-file` (a validated index file on disk), and `https`
 * (a remote index that is fetched only on explicit `--network` update).
 * Reading configuration never touches the network.
 */
export const REGISTRIES_FILE_NAME = 'registries.json';
export const REGISTRIES_SCHEMA_VERSION = '1.0.0';

/** The always-available built-in example registry. */
export const BUILTIN_REGISTRY_NAME = 'examples';

const HTTPS_SOURCE_URL = z
  .string()
  .min(9)
  .max(1000)
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not a valid URL' });
      return;
    }
    if (parsed.protocol !== 'https:') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'only https:// registry URLs are allowed' });
    }
    if (parsed.username !== '' || parsed.password !== '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'registry URLs must not embed credentials' });
    }
  });

const NAME = z
  .string()
  .min(1)
  .max(MAX_REGISTRY_NAME_LENGTH)
  .regex(REGISTRY_NAME_PATTERN, 'registry names use lowercase letters, digits, and single hyphens');

export const registrySourceSchema = z.discriminatedUnion('type', [
  z.object({ name: NAME, type: z.literal('builtin'), enabled: z.boolean().default(true) }).strict(),
  z
    .object({
      name: NAME,
      type: z.literal('local-file'),
      /** Workspace-relative path to a registry index JSON file. */
      file: z.string().min(1).max(500),
      enabled: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      name: NAME,
      type: z.literal('https'),
      url: HTTPS_SOURCE_URL,
      enabled: z.boolean().default(true),
    })
    .strict(),
]);

export type RegistrySource = z.infer<typeof registrySourceSchema>;

export const registriesConfigSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    registries: z.array(registrySourceSchema).max(20),
  })
  .passthrough();

export type RegistriesConfig = z.infer<typeof registriesConfigSchema>;

export function registriesConfigPath(workspace: WorkspaceInfo): string {
  return path.join(workspace.sidecarDir, REGISTRIES_FILE_NAME);
}

export function defaultRegistriesConfig(): RegistriesConfig {
  return {
    schemaVersion: REGISTRIES_SCHEMA_VERSION,
    registries: [{ name: BUILTIN_REGISTRY_NAME, type: 'builtin', enabled: true }],
  };
}

export interface RegistriesConfigReadResult {
  readonly config: RegistriesConfig;
  readonly diagnostics: readonly Diagnostic[];
  readonly exists: boolean;
}

/**
 * Read the registries configuration. Missing file → defaults (built-in
 * example registry only). Invalid file → defaults plus error diagnostics —
 * never a crash and never a silent repair.
 */
export function readRegistriesConfig(workspace: WorkspaceInfo): RegistriesConfigReadResult {
  const filePath = registriesConfigPath(workspace);
  if (!existsSync(filePath)) {
    return { config: defaultRegistriesConfig(), diagnostics: [], exists: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (cause) {
    return {
      config: defaultRegistriesConfig(),
      exists: true,
      diagnostics: [
        {
          severity: 'error',
          code: 'REGISTRIES_INVALID_JSON',
          message: `registries.json is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
          file: filePath,
        },
      ],
    };
  }
  const result = registriesConfigSchema.safeParse(parsed);
  if (!result.success) {
    return {
      config: defaultRegistriesConfig(),
      exists: true,
      diagnostics: [
        {
          severity: 'error',
          code: 'REGISTRIES_INVALID_SHAPE',
          message: `registries.json does not match the schema: ${result.error.issues[0]?.message ?? 'unknown'}`,
          file: filePath,
        },
      ],
    };
  }
  const names = new Set<string>();
  for (const source of result.data.registries) {
    if (names.has(source.name)) {
      return {
        config: defaultRegistriesConfig(),
        exists: true,
        diagnostics: [
          {
            severity: 'error',
            code: 'REGISTRIES_DUPLICATE_NAME',
            message: `registries.json declares "${source.name}" more than once`,
            file: filePath,
          },
        ],
      };
    }
    names.add(source.name);
  }
  // The built-in example registry is always present.
  const config = result.data.registries.some((source) => source.type === 'builtin')
    ? result.data
    : {
        ...result.data,
        registries: [
          { name: BUILTIN_REGISTRY_NAME, type: 'builtin' as const, enabled: true },
          ...result.data.registries,
        ],
      };
  return { config, diagnostics: [], exists: true };
}

export function writeRegistriesConfig(workspace: WorkspaceInfo, config: RegistriesConfig): void {
  const filePath = registriesConfigPath(workspace);
  assertInsideWorkspace(workspace.rootDir, filePath);
  writeFileAtomic(filePath, `${JSON.stringify(registriesConfigSchema.parse(config), null, 2)}\n`);
}

export function requireRegistrySource(config: RegistriesConfig, name: string): RegistrySource {
  const source = config.registries.find((candidate) => candidate.name === name);
  if (source === undefined) {
    throw new RegistryError(
      'SBR001',
      `registry "${name}" is not configured.`,
      `Configured registries: ${config.registries.map((candidate) => candidate.name).join(', ')}. ` +
        'Add one with `specbridge registry add <name> --file <path>` or `--url <https-url>`.',
      { name },
    );
  }
  return source;
}

export function addRegistrySource(workspace: WorkspaceInfo, source: RegistrySource): RegistriesConfig {
  const parsed = registrySourceSchema.safeParse(source);
  if (!parsed.success) {
    throw new RegistryError(
      'SBR003',
      `registry configuration is invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}.`,
      'Check the name, file path, or https URL.',
    );
  }
  const { config } = readRegistriesConfig(workspace);
  if (config.registries.some((candidate) => candidate.name === source.name)) {
    throw new RegistryError(
      'SBR003',
      `registry "${source.name}" already exists.`,
      'Remove it first with `specbridge registry remove <name>` or pick another name.',
      { name: source.name },
    );
  }
  const next = { ...config, registries: [...config.registries, parsed.data] };
  writeRegistriesConfig(workspace, next);
  return next;
}

export function removeRegistrySource(workspace: WorkspaceInfo, name: string): RegistriesConfig {
  if (name === BUILTIN_REGISTRY_NAME) {
    throw new RegistryError(
      'SBR003',
      'the built-in example registry cannot be removed.',
      'Disable it by ignoring it; it never touches the network.',
    );
  }
  const { config } = readRegistriesConfig(workspace);
  requireRegistrySource(config, name);
  const next = {
    ...config,
    registries: config.registries.filter((candidate) => candidate.name !== name),
  };
  writeRegistriesConfig(workspace, next);
  return next;
}
