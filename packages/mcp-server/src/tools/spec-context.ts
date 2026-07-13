import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  buildAgentContextJson,
  buildAgentContextMarkdown,
  findTask,
  listSteeringFiles,
  loadSteeringDocument,
} from '@specbridge/compat-kiro';
import type { SteeringDocument } from '@specbridge/compat-kiro';
import { readAgentConfig } from '@specbridge/core';
import type { ServerContext } from '../context.js';
import { McpToolError } from '../errors.js';
import { LIMITS, truncateText } from '../limits.js';
import { specNameArg } from '../schemas/common.js';
import { evaluateSpecBundle } from '../schemas/spec-views.js';
import { registerDefinedTool } from './helpers.js';
import { MCP_SERVER_VERSION } from '../version.js';

/**
 * spec_context — bounded, deterministic agent-ready context for one spec.
 * Assembled entirely from disk (steering + spec documents + approval state
 * + verification policy); no model is ever invoked and no unrelated
 * repository content is included.
 */

const inputSchema = {
  specName: specNameArg,
  taskId: z.string().max(64).optional().describe('Highlight one task in the context'),
  format: z.enum(['markdown', 'structured']).optional().describe('Output format (default markdown)'),
  maximumCharacters: z
    .number()
    .int()
    .min(1000)
    .max(LIMITS.maximumContextCharacters)
    .optional()
    .describe(`Character bound for markdown output (default ${LIMITS.maximumContextCharacters})`),
};

const outputSchema = {
  specName: z.string(),
  format: z.enum(['markdown', 'structured']),
  markdown: z.string().optional(),
  structured: z.record(z.unknown()).optional(),
  truncated: z.boolean(),
  approvalSummary: z.object({
    health: z.enum(['ok', 'stale', 'unmanaged', 'invalid']),
    workflowStatus: z.string(),
  }),
  verificationCommands: z.array(
    z.object({ name: z.string(), required: z.boolean() }),
  ),
  selectedTask: z
    .object({ id: z.string(), title: z.string(), state: z.string() })
    .optional(),
};

function inlinedSteering(workspace: Parameters<typeof listSteeringFiles>[0]): SteeringDocument[] {
  const documents: SteeringDocument[] = [];
  for (const info of listSteeringFiles(workspace)) {
    if (info.inclusion !== 'always' && info.inclusion !== 'unknown') continue;
    try {
      documents.push(loadSteeringDocument(workspace, info.name));
    } catch {
      // Unreadable steering is reported by workspace_detect; skip here.
    }
  }
  return documents;
}

export function registerSpecContextTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'spec_context',
    title: 'Build agent context',
    description:
      'Assemble bounded agent-ready context for a spec: steering, spec documents, task progress, ' +
      'approval state, and configured verification command names. Deterministic and read-only; no model involved.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema,
    outputSchema,
    handler: async (args) => {
      const { workspace, analysis } = context.requireSpecAnalysis(args.specName);
      const bundle = evaluateSpecBundle(workspace, analysis);
      const format = args.format ?? 'markdown';

      let selectedTask: { id: string; title: string; state: string } | undefined;
      if (args.taskId !== undefined) {
        if (analysis.tasks === undefined) {
          throw new McpToolError('SBMCP007', `Spec "${analysis.folder.name}" has no readable tasks.md.`);
        }
        const task = findTask(analysis.tasks, args.taskId);
        if (task === undefined) {
          throw new McpToolError('SBMCP007', `Task "${args.taskId}" was not found in tasks.md.`, {
            remediation: ['List tasks with the task_list tool.'],
          });
        }
        selectedTask = { id: task.id, title: task.title, state: task.state };
      }

      const steering = inlinedSteering(workspace);
      const conditionalSteering = listSteeringFiles(workspace)
        .filter((info) => info.inclusion === 'fileMatch' || info.inclusion === 'manual')
        .map((info) => ({
          name: info.name,
          inclusion: info.inclusion,
          ...(info.fileMatchPattern !== undefined ? { fileMatchPattern: info.fileMatchPattern } : {}),
        }));

      const contextInput = {
        workspace,
        analysis,
        steering,
        conditionalSteering,
        generatorVersion: MCP_SERVER_VERSION,
      };

      const configRead = readAgentConfig(workspace);
      const verificationCommands = (configRead.config?.verification.commands ?? []).map(
        (command) => ({ name: command.name, required: command.required }),
      );
      const approvalSummary = {
        health: bundle.approvalHealth,
        workflowStatus: bundle.workflowStatus,
      };

      if (format === 'structured') {
        const structured = buildAgentContextJson(contextInput, { target: 'generic' });
        // MCP output never carries absolute local paths; the v0.1 JSON shape
        // records the workspace root for local consumers, so relativize it.
        const redacted = {
          ...structured,
          workspace: { root: '.', kiroDir: '.kiro' },
        };
        return {
          text: `Structured context for "${analysis.folder.name}" (schema ${structured.schema}).`,
          structured: {
            specName: analysis.folder.name,
            format,
            structured: redacted as unknown as Record<string, unknown>,
            truncated: false,
            approvalSummary,
            verificationCommands,
            ...(selectedTask !== undefined ? { selectedTask } : {}),
          },
        };
      }

      let markdown = buildAgentContextMarkdown(contextInput, { target: 'generic' });
      const extras: string[] = ['', '## Approval state', ''];
      extras.push(`- Workflow status: ${approvalSummary.workflowStatus}`);
      extras.push(`- Approval health: ${approvalSummary.health}`);
      if (selectedTask !== undefined) {
        extras.push('', '## Selected task', '', `- ${selectedTask.id}: ${selectedTask.title} (${selectedTask.state})`);
      }
      if (verificationCommands.length > 0) {
        extras.push('', '## Trusted verification commands', '');
        for (const command of verificationCommands) {
          extras.push(`- ${command.name}${command.required ? ' (required)' : ' (optional)'}`);
        }
      }
      markdown = `${markdown}${extras.join('\n')}\n`;

      const maximumCharacters = args.maximumCharacters ?? LIMITS.maximumContextCharacters;
      let truncated = false;
      if (markdown.length > maximumCharacters) {
        markdown = `${markdown.slice(0, maximumCharacters)}\n\n[context truncated at ${maximumCharacters} characters]\n`;
        truncated = true;
      }
      const bounded = truncateText(markdown, LIMITS.maximumDocumentBytes);

      return {
        text: bounded.text,
        structured: {
          specName: analysis.folder.name,
          format,
          markdown: bounded.text,
          truncated: truncated || bounded.truncated,
          approvalSummary,
          verificationCommands,
          ...(selectedTask !== undefined ? { selectedTask } : {}),
        },
      };
    },
  });
}
