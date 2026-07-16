import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EXTENSION_KINDS } from '@specbridge/extension-sdk';
import {
  describeEnablement,
  installedVersions,
  listInstalledExtensions,
  probeExtensionHandshake,
  readExtensionState,
  requireEnabledExtension,
  searchInstalledExtensions,
} from '@specbridge/extensions';
import { searchRegistryIndexes } from '@specbridge/registry';
import type { ServerContext } from '../context.js';
import { clampListLimit, paginate } from '../limits.js';
import { registerDefinedTool } from './helpers.js';
import {
  extensionSummaryShape,
  readableRegistryIndexes,
  registryHitShape,
} from './extension-shared.js';

/**
 * Read-only extension discovery tools. Install, uninstall, enable, disable,
 * conformance, and packaging are deliberately NOT exposed over MCP — those
 * stay explicit CLI actions with explicit permission acceptance.
 */
const kindInput = z.enum(EXTENSION_KINDS).optional();

export function registerExtensionListTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'extension_list',
    title: 'List installed extensions',
    description:
      'List installed SpecBridge extensions with enablement, permission, compatibility, and ' +
      'conformance status. Read-only and offline; never starts an extension process.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      kind: kindInput.describe('Filter by extension kind'),
      enabled: z.boolean().optional().describe('Only enabled (true) or only disabled (false)'),
      limit: z.number().int().min(1).optional(),
      cursor: z.string().optional(),
    },
    outputSchema: {
      extensions: z.array(extensionSummaryShape),
      totalCount: z.number().int(),
      nextCursor: z.string().nullable(),
    },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      const catalog = listInstalledExtensions(workspace);
      let entries = [...catalog.entries];
      if (args.kind !== undefined) {
        entries = entries.filter((entry) => entry.kind === args.kind);
      }
      if (args.enabled !== undefined) {
        entries = entries.filter((entry) => entry.enabled === args.enabled);
      }
      const page = paginate(entries, {
        limit: clampListLimit(args.limit),
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        token: 'extension-list',
      });
      const text =
        page.items.length === 0
          ? 'No installed extensions match the given filters.'
          : page.items
              .map((entry) => `- ${entry.id}@${entry.version} (${entry.kind}, ${entry.enabled ? 'enabled' : 'disabled'})`)
              .join('\n');
      return {
        text,
        structured: { extensions: page.items, totalCount: entries.length, nextCursor: page.nextCursor ?? null },
      };
    },
  });
}

export function registerExtensionSearchTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'extension_search',
    title: 'Search extensions',
    description:
      'Search installed extensions and validated cached registry indexes with deterministic ' +
      'lexical ranking. Offline: never fetches a registry and never downloads anything.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      query: z.string().min(1).max(200),
      registry: z.string().max(40).optional().describe('Search one registry only'),
      kind: kindInput,
      limit: z.number().int().min(1).max(50).optional(),
    },
    outputSchema: {
      installed: z.array(extensionSummaryShape),
      registry: z.array(registryHitShape),
      totalCount: z.number().int(),
    },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      const installed =
        args.registry === undefined
          ? searchInstalledExtensions(listInstalledExtensions(workspace), args.query, {
              ...(args.kind === undefined ? {} : { kind: args.kind }),
              limit: args.limit ?? 20,
            })
          : [];
      const registryHits = searchRegistryIndexes(
        readableRegistryIndexes(workspace, args.registry),
        args.query,
        { ...(args.kind === undefined ? {} : { kind: args.kind }), ...(args.limit === undefined ? {} : { limit: args.limit }) },
      ).map((hit) => ({
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
          installed.length + registryHits.length === 0
            ? 'No matches.'
            : [
                ...installed.map((hit) => `- installed: ${hit.id}@${hit.version} (${hit.kind})`),
                ...registryHits.map((hit) => `- ${hit.registryName}: ${hit.id}@${hit.latestVersion} (${hit.kind})`),
              ].join('\n'),
        structured: { installed, registry: registryHits, totalCount: installed.length + registryHits.length },
      };
    },
  });
}

export function registerExtensionShowTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'extension_show',
    title: 'Show extension details',
    description:
      'Show an installed extension: manifest summary, permissions, permission hash, enablement, ' +
      'grant status, and the exact CLI command needed to enable it. Never exposes secret values.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { extensionId: z.string().min(1).max(64) },
    outputSchema: {
      id: z.string(),
      installedVersions: z.array(z.string()),
      enabledVersion: z.string().nullable(),
      kind: z.string(),
      displayName: z.string(),
      description: z.string(),
      permissions: z.record(z.unknown()),
      permissionLines: z.array(z.string()),
      permissionHash: z.string(),
      grantStatus: z.string(),
      compatibility: z.string(),
      enableCommand: z.string(),
    },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      const { state } = readExtensionState(workspace);
      const versions = installedVersions(state, args.extensionId);
      const preview = describeEnablement(workspace, args.extensionId);
      const enableCommand = `specbridge extension enable ${args.extensionId} --accept-permissions ${preview.permissionHash}`;
      return {
        text:
          `${preview.manifest.displayName} v${preview.record.version} (${preview.manifest.kind}) — ` +
          `${preview.enabled ? 'enabled' : 'disabled'}, grant ${preview.grantStatus}.\n` +
          `Permission hash: ${preview.permissionHash}\nEnable with: ${enableCommand}`,
        structured: {
          id: args.extensionId,
          installedVersions: versions.map((record) => record.version),
          enabledVersion: state.enabled[args.extensionId]?.version ?? null,
          kind: preview.manifest.kind,
          displayName: preview.manifest.displayName,
          description: preview.manifest.description,
          permissions: preview.manifest.permissions,
          permissionLines: [...preview.permissionLines],
          permissionHash: preview.permissionHash,
          grantStatus: preview.grantStatus,
          compatibility: preview.manifest.compatibility.specbridge,
          enableCommand,
        },
      };
    },
  });
}

export function registerExtensionDoctorTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'extension_doctor',
    title: 'Extension health check',
    description:
      'Read-only health check for an installed extension: package integrity, grant status, ' +
      'compatibility, and — only for enabled executable extensions — a bounded no-operation ' +
      'initialize handshake. Never invokes a business operation and never touches the network.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { extensionId: z.string().min(1).max(64) },
    outputSchema: {
      id: z.string(),
      version: z.string(),
      integrity: z.string(),
      enabled: z.boolean(),
      grantStatus: z.string(),
      handshake: z.object({ ok: z.boolean(), detail: z.string() }),
      ok: z.boolean(),
    },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      const preview = describeEnablement(workspace, args.extensionId);
      let handshake = {
        ok: true,
        detail:
          preview.manifest.entrypoint === undefined
            ? 'data-only extension; no process to probe'
            : 'not enabled; handshake skipped',
      };
      if (preview.enabled && preview.manifest.entrypoint !== undefined) {
        const enabled = requireEnabledExtension(workspace, args.extensionId);
        const probe = await probeExtensionHandshake(enabled);
        handshake = { ok: probe.ok, detail: probe.detail };
      }
      const ok = handshake.ok && preview.grantStatus !== 'stale';
      return {
        text: `${args.extensionId}@${preview.record.version}: ${ok ? 'healthy' : 'unhealthy'} (${handshake.detail})`,
        structured: {
          id: args.extensionId,
          version: preview.record.version,
          integrity: 'valid',
          enabled: preview.enabled,
          grantStatus: preview.grantStatus,
          handshake,
          ok,
        },
      };
    },
  });
}
