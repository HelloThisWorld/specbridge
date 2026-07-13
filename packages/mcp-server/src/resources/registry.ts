import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerContext } from '../context.js';
import { registerWorkspaceResource } from './workspace.js';
import { registerSteeringResources } from './steering.js';
import { registerSpecResources } from './specs.js';
import { registerRunResources } from './runs.js';
import { registerVerificationRulesResource } from './verification-rules.js';

/**
 * Read-only resource registry. Every resource is repository-bounded: URIs
 * address well-known names/ids only, never filesystem paths, and content is
 * size-limited before it is returned.
 */

export interface ResourceRegistryEntry {
  name: string;
  uri: string;
  mimeType: string;
  summary: string;
}

export const RESOURCE_CATALOG: readonly ResourceRegistryEntry[] = [
  {
    name: 'workspace',
    uri: 'specbridge://workspace',
    mimeType: 'application/json',
    summary: 'Workspace detection summary',
  },
  {
    name: 'steering',
    uri: 'specbridge://steering/{name}',
    mimeType: 'text/markdown',
    summary: 'One steering document by name',
  },
  {
    name: 'spec-document',
    uri: 'specbridge://specs/{specName}/{document}',
    mimeType: 'text/markdown',
    summary: 'Canonical spec document (requirements | bugfix | design | tasks)',
  },
  {
    name: 'spec-status',
    uri: 'specbridge://specs/{specName}/status',
    mimeType: 'application/json',
    summary: 'Authoritative workflow status for one spec',
  },
  {
    name: 'spec-context',
    uri: 'specbridge://specs/{specName}/context',
    mimeType: 'text/markdown',
    summary: 'Bounded agent-ready context for one spec',
  },
  {
    name: 'run',
    uri: 'specbridge://runs/{runId}',
    mimeType: 'application/json',
    summary: 'Safe summary of one recorded run',
  },
  {
    name: 'verification-rules',
    uri: 'specbridge://verification/rules',
    mimeType: 'application/json',
    summary: 'The stable deterministic verification rule registry',
  },
] as const;

export function registerAllResources(server: McpServer, context: ServerContext): void {
  registerWorkspaceResource(server, context);
  registerSteeringResources(server, context);
  registerSpecResources(server, context);
  registerRunResources(server, context);
  registerVerificationRulesResource(server, context);
}
