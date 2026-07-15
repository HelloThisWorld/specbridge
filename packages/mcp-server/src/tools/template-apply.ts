import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executeTemplateApplication, planTemplateApplication } from '@specbridge/templates';
import type { ServerContext } from '../context.js';
import { LIMITS } from '../limits.js';
import { McpToolError } from '../errors.js';
import { repoRelative } from '../schemas/common.js';
import { registerDefinedTool } from './helpers.js';
import { catalogFor, templateVariablesInput } from './template-shared.js';

/**
 * template_apply — hash-bound, acknowledgement-gated spec creation from a
 * template.
 *
 * The caller must have run template_preview, reviewed the rendered output,
 * and pass back the candidate hash. The tool re-renders from the same
 * inputs and refuses to write when the result differs (template changed,
 * variables changed, clock-dependent content changed) — the reviewed
 * content is exactly the content written, or nothing is.
 */

const inputSchema = {
  reference: z.string().min(1).max(150).describe('Template reference (qualified or unique unqualified)'),
  specName: z.string().min(1).max(120).describe('Name of the spec to create'),
  mode: z.enum(['requirements-first', 'design-first', 'quick']).optional(),
  title: z.string().max(300).optional(),
  description: z.string().max(LIMITS.maximumShortTextChars).optional(),
  variables: templateVariablesInput,
  expectedCandidateHash: z
    .string()
    .min(1)
    .describe('candidateHash returned by template_preview for these exact inputs'),
  acknowledgement: z
    .literal('apply-reviewed-template')
    .describe('Confirms the rendered preview was reviewed'),
};

const outputSchema = {
  applied: z.boolean(),
  template: z.object({ ref: z.string(), version: z.string(), source: z.string() }),
  specName: z.string(),
  specKind: z.enum(['feature', 'bugfix']),
  mode: z.enum(['requirements-first', 'design-first', 'quick']),
  candidateHash: z.string(),
  createdPaths: z.array(z.string()).describe('Repository-relative paths that were created'),
  statePath: z.string(),
  initialStatus: z.string().describe('All generated stages start unapproved'),
  recordId: z.string().describe('Append-only template-apply record ID'),
  suggestedNextSteps: z.array(z.string()),
};

export function registerTemplateApplyTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'template_apply',
    title: 'Apply a reviewed template',
    description:
      'Create a new spec from a template, atomically, after template_preview. Requires the candidate ' +
      'hash from the preview and the acknowledgement string. Never overwrites an existing spec, never ' +
      'marks a stage approved, and appends an auditable template-apply record.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema,
    outputSchema,
    handler: async (args) =>
      context.withWriteLock(async () => {
        const workspace = context.requireWorkspace();
        const catalog = catalogFor(context);
        const plan = planTemplateApplication(
          workspace,
          catalog,
          {
            reference: args.reference,
            specName: args.specName,
            ...(args.mode !== undefined ? { mode: args.mode } : {}),
            ...(args.title !== undefined ? { title: args.title } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            variables: args.variables ?? {},
          },
          context.clock,
        );

        if (plan.candidateHash !== args.expectedCandidateHash) {
          throw new McpToolError(
            'SBMCP002',
            `SBT023 (candidate hash mismatch): the re-rendered candidate (${plan.candidateHash}) does not match ` +
              `expectedCandidateHash (${args.expectedCandidateHash}). The template or the inputs changed since the preview.`,
            {
              remediation: [
                'Call template_preview again with the same inputs.',
                'Review the new rendered output.',
                'Retry template_apply with the new candidateHash.',
              ],
              details: { expected: args.expectedCandidateHash, actual: plan.candidateHash },
            },
          );
        }

        const result = executeTemplateApplication(workspace, plan, context.clock);
        const createdPaths = [
          ...result.creation.writtenFiles.map((file) => repoRelative(workspace, file)),
          repoRelative(workspace, result.creation.statePath),
        ];

        return {
          text:
            `Created spec "${plan.specPlan.specName}" from ${plan.templateRef} v${plan.templateVersion} ` +
            `(${plan.specPlan.specType}, ${plan.mode}). All stages start unapproved. Record: ${result.recordId}.`,
          structured: {
            applied: true,
            template: { ref: plan.templateRef, version: plan.templateVersion, source: plan.templateSource },
            specName: plan.specPlan.specName,
            specKind: plan.specPlan.specType,
            mode: plan.mode,
            candidateHash: plan.candidateHash,
            createdPaths,
            statePath: repoRelative(workspace, result.creation.statePath),
            initialStatus: plan.specPlan.state.status,
            recordId: result.recordId,
            suggestedNextSteps: [
              'Replace the remaining placeholders in the first stage document with real content.',
              `Validate with spec_analyze ("${plan.specPlan.specName}").`,
              'Approval stays a human CLI action: specbridge spec approve.',
            ],
          },
        };
      }),
  });
}
