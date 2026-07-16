import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EXTENSION_KINDS } from '@specbridge/extension-sdk';
import { readRegistriesConfig, readRegistryCache, searchRegistryIndexes } from '@specbridge/registry';
import type { ServerContext } from '../context.js';
import { registerDefinedTool } from './helpers.js';
import { readableRegistryIndexes, registryHitShape } from './extension-shared.js';

/**
 * Read-only registry discovery tools. Adding, removing, and updating
 * registries stay explicit CLI actions; these tools only read configuration
 * and previously validated caches — no network access ever happens here.
 */
export function registerRegistryListTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'registry_list',
    title: 'List extension registries',
    description:
      'List configured extension registries with cache status. Read-only and offline; ' +
      'registry updates require the explicit CLI command with --network.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {},
    outputSchema: {
      registries: z.array(
        z.object({
          name: z.string(),
          type: z.string(),
          enabled: z.boolean(),
          source: z.string(),
          cacheStatus: z.string(),
          lastUpdate: z.string().nullable(),
          extensionCount: z.number().int().nullable(),
        }),
      ),
      totalCount: z.number().int(),
    },
    handler: async () => {
      const workspace = context.requireWorkspace();
      const { config } = readRegistriesConfig(workspace);
      const readable = new Map(
        readableRegistryIndexes(workspace).map((entry) => [entry.registryName, entry.index]),
      );
      const registries = config.registries.map((source) => {
        const cache = source.type === 'https' ? readRegistryCache(workspace, source.name) : undefined;
        return {
          name: source.name,
          type: source.type,
          enabled: source.enabled,
          source: source.type === 'https' ? source.url : source.type === 'local-file' ? source.file : 'embedded',
          cacheStatus:
            source.type === 'https'
              ? cache?.cache !== undefined
                ? 'cached'
                : 'no-cache'
              : readable.has(source.name)
                ? 'readable'
                : 'invalid',
          lastUpdate: cache?.cache?.retrievedAt ?? null,
          extensionCount: readable.get(source.name)?.extensions.length ?? null,
        };
      });
      return {
        text: registries.map((row) => `- ${row.name} (${row.type}, ${row.cacheStatus})`).join('\n') || 'No registries.',
        structured: { registries, totalCount: registries.length },
      };
    },
  });
}

export function registerRegistrySearchTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'registry_search',
    title: 'Search extension registries',
    description:
      'Search validated cached registry indexes with deterministic lexical ranking ' +
      '(exact ID, ID prefix, keyword, name token, description token). Offline: never fetches.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      query: z.string().min(1).max(200),
      registry: z.string().max(40).optional(),
      kind: z.enum(EXTENSION_KINDS).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    outputSchema: {
      results: z.array(registryHitShape),
      totalCount: z.number().int(),
    },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      const hits = searchRegistryIndexes(readableRegistryIndexes(workspace, args.registry), args.query, {
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      }).map((hit) => ({
        registryName: hit.registryName,
        id: hit.entry.id,
        kind: hit.entry.kind,
        displayName: hit.entry.displayName,
        description: hit.entry.description,
        latestVersion: hit.entry.latestVersion,
        license: hit.entry.license,
        score: hit.score,
      }));
      return {
        text:
          hits.length === 0
            ? 'No matches in readable registry indexes.'
            : hits.map((hit) => `- ${hit.id}@${hit.latestVersion} (${hit.kind}, from ${hit.registryName})`).join('\n'),
        structured: { results: hits, totalCount: hits.length },
      };
    },
  });
}

export function registerRegistryShowTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'registry_show',
    title: 'Show registry extension metadata',
    description:
      'Show registry metadata for one extension: versions, archive integrity metadata, ' +
      'permissions summary, and compatibility. Never downloads an archive. ' +
      'Registry listing is not endorsement.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { extensionId: z.string().min(1).max(64) },
    outputSchema: {
      matches: z.array(
        z.object({
          registryName: z.string(),
          id: z.string(),
          kind: z.string(),
          displayName: z.string(),
          description: z.string(),
          latestVersion: z.string(),
          license: z.string(),
          deprecated: z.boolean(),
          versions: z.array(
            z.object({
              version: z.string(),
              archiveUrl: z.string(),
              sha256: z.string(),
              specbridge: z.string(),
              permissions: z.record(z.unknown()),
            }),
          ),
        }),
      ),
      totalCount: z.number().int(),
    },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      const matches = readableRegistryIndexes(workspace).flatMap(({ registryName, index }) =>
        index.extensions
          .filter((entry) => entry.id === args.extensionId)
          .map((entry) => ({
            registryName,
            id: entry.id,
            kind: entry.kind,
            displayName: entry.displayName,
            description: entry.description,
            latestVersion: entry.latestVersion,
            license: entry.license,
            deprecated: entry.deprecated === true,
            versions: entry.versions.map((version) => ({
              version: version.version,
              archiveUrl: version.archiveUrl,
              sha256: version.sha256,
              specbridge: version.manifest.compatibility.specbridge,
              permissions: version.manifest.permissions,
            })),
          })),
      );
      return {
        text:
          matches.length === 0
            ? `Extension "${args.extensionId}" was not found in any readable registry index.`
            : matches
                .map((match) => `${match.registryName}: ${match.id}@${match.latestVersion} (${match.kind}, ${match.license})`)
                .join('\n'),
        structured: { matches, totalCount: matches.length },
      };
    },
  });
}
