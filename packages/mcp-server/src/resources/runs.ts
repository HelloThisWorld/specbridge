import { existsSync, readdirSync } from 'node:fs';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listRuns, readRunRecord, runDir } from '@specbridge/execution';
import type { ServerContext } from '../context.js';
import { buildRunDetail } from '../schemas/run-views.js';
import { assertPlainName, jsonContents, resourceNotFound } from './helpers.js';

/**
 * specbridge://runs/{runId} — the safe run summary as JSON. Raw prompts,
 * raw runner output, and full command logs never leave the local run
 * directory.
 */

const REDACTED_ARTIFACTS = new Set(['prompt.md', 'raw-stdout.log', 'raw-stderr.log']);

export function registerRunResources(server: McpServer, context: ServerContext): void {
  server.registerResource(
    'run',
    new ResourceTemplate('specbridge://runs/{runId}', {
      list: () => {
        const workspace = context.tryWorkspace();
        if (workspace === undefined) return { resources: [] };
        return {
          resources: listRuns(workspace)
            .runs.slice(0, 50)
            .map((record) => ({
              uri: `specbridge://runs/${encodeURIComponent(record.runId)}`,
              name: record.runId,
              description: `${record.kind} run for spec "${record.specName}"`,
              mimeType: 'application/json',
            })),
        };
      },
    }),
    {
      title: 'Run summary',
      description: 'Safe summary of one recorded run (no raw prompts or runner output).',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const runId = assertPlainName('run id', String(variables['runId'] ?? ''));
      const workspace = context.requireWorkspace();
      const record = readRunRecord(workspace, runId);
      if (record === undefined) {
        throw resourceNotFound(`Run "${runId}"`, 'List runs with the run_list tool.');
      }
      const directory = runDir(workspace, record.runId);
      const artifactNames = existsSync(directory)
        ? readdirSync(directory)
            .filter((name) => !REDACTED_ARTIFACTS.has(name))
            .sort((a, b) => a.localeCompare(b, 'en'))
        : [];
      return jsonContents(context, uri.href, buildRunDetail(workspace, record, artifactNames));
    },
  );
}
