import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executeSpecCreation, planSpecCreation } from '@specbridge/workflow';
import type { ServerContext } from '../context.js';
import { LIMITS, assertInputSize } from '../limits.js';
import { repoRelative } from '../schemas/common.js';
import { registerDefinedTool } from './helpers.js';

/**
 * spec_create — offline Kiro-compatible spec templates.
 *
 * Preview-first: `apply: false` (the default) renders the exact files and
 * initial sidecar state without writing anything. `apply: true` re-validates
 * the identical request and creates the spec atomically (temp directory +
 * rename), refusing existing directories. All v0.2 name validation and path
 * protections apply unchanged.
 */

const inputSchema = {
  name: z
    .string()
    .min(1)
    .max(120)
    .describe('Spec name (lowercase letters, digits, dashes — validated like the CLI)'),
  type: z.enum(['feature', 'bugfix']).optional().describe('Spec type (default feature)'),
  mode: z
    .enum(['requirements-first', 'design-first', 'quick'])
    .optional()
    .describe('Workflow mode (default requirements-first)'),
  title: z.string().max(300).optional(),
  description: z.string().max(LIMITS.maximumShortTextChars).optional(),
  apply: z
    .boolean()
    .optional()
    .describe('false (default): preview only, write nothing. true: create the spec atomically.'),
};

const fileShape = z.object({
  path: z.string().describe('Repository-relative path'),
  bytes: z.number().int(),
  content: z.string().optional().describe('Rendered content (preview only)'),
});

const outputSchema = {
  applied: z.boolean(),
  specName: z.string(),
  specType: z.enum(['feature', 'bugfix']),
  mode: z.enum(['requirements-first', 'design-first', 'quick']),
  title: z.string(),
  descriptionIsPlaceholder: z.boolean(),
  files: z.array(fileShape),
  statePath: z.string().describe('Repository-relative sidecar state path'),
  initialStatus: z.string(),
  suggestedNextSteps: z.array(z.string()),
};

export function registerSpecCreateTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'spec_create',
    title: 'Create a spec (preview-first)',
    description:
      'Create an offline Kiro-compatible spec template. Default is a pure preview (apply: false) that ' +
      'renders the proposed files and initial state without writing. apply: true creates the spec ' +
      'atomically and never overwrites an existing spec.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema,
    outputSchema,
    handler: async (args) => {
      if (args.description !== undefined) {
        assertInputSize('description', args.description, LIMITS.maximumShortTextChars);
      }
      const apply = args.apply === true;
      const request = {
        name: args.name,
        ...(args.type !== undefined ? { specType: args.type } : {}),
        ...(args.mode !== undefined ? { mode: args.mode } : {}),
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
      };

      const run = async (): Promise<{
        text: string;
        structured: z.objectOutputType<typeof outputSchema, z.ZodTypeAny>;
      }> => {
        const workspace = context.requireWorkspace();
        // Plan validates everything (name, collisions, sizes) without writing.
        const plan = planSpecCreation(workspace, request, context.clock);

        const previewFiles = plan.files.map((file) => ({
          path: repoRelative(workspace, `${plan.dir}/${file.fileName}`),
          bytes: Buffer.byteLength(file.content, 'utf8'),
          ...(apply ? {} : { content: file.content }),
        }));

        let suggestedNextSteps: string[];
        if (apply) {
          executeSpecCreation(workspace, plan);
          suggestedNextSteps = [
            `Author the first stage: draft candidate Markdown, then spec_stage_validate + spec_stage_apply.`,
            `Check status any time with spec_status ("${plan.specName}").`,
          ];
        } else {
          suggestedNextSteps = [
            'Review the rendered files above.',
            'Call spec_create again with apply: true to create the spec.',
          ];
        }

        const text = apply
          ? `Created spec "${plan.specName}" (${plan.specType}, ${plan.mode}) with ${plan.files.length} file(s). ` +
            `Initial status: ${plan.state.status}.`
          : `Preview of spec "${plan.specName}" (${plan.specType}, ${plan.mode}) — nothing was written.\n` +
            previewFiles.map((file) => `- ${file.path} (${file.bytes} bytes)`).join('\n');

        return {
          text,
          structured: {
            applied: apply,
            specName: plan.specName,
            specType: plan.specType,
            mode: plan.mode,
            title: plan.title,
            descriptionIsPlaceholder: plan.descriptionIsPlaceholder,
            files: previewFiles,
            statePath: repoRelative(workspace, plan.statePath),
            initialStatus: plan.state.status,
            suggestedNextSteps,
          },
        };
      };

      // Writes serialize; previews stay concurrent.
      return apply ? context.withWriteLock(run) : run();
    },
  });
}
