import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { planTemplateApplication } from '@specbridge/templates';
import type { ServerContext } from '../context.js';
import { LIMITS, truncateText } from '../limits.js';
import { repoRelative } from '../schemas/common.js';
import { registerDefinedTool } from './helpers.js';
import { catalogFor, templateVariablesInput } from './template-shared.js';

/**
 * template_preview — read-only rendering of a template application.
 *
 * Renders through the exact same path as apply and returns the candidate
 * hash that template_apply requires. Writes nothing, invokes no model,
 * accesses no network.
 */

const inputSchema = {
  reference: z.string().min(1).max(150).describe('Template reference (qualified or unique unqualified)'),
  specName: z.string().min(1).max(120).describe('Name of the spec that would be created'),
  mode: z
    .enum(['requirements-first', 'design-first', 'quick'])
    .optional()
    .describe("Workflow mode (default: the template's defaultMode)"),
  title: z.string().max(300).optional(),
  description: z.string().max(LIMITS.maximumShortTextChars).optional(),
  variables: templateVariablesInput,
};

const renderedFileShape = z.object({
  target: z.string().describe('File name inside .kiro/specs/<specName>/'),
  stage: z.string(),
  bytes: z.number().int(),
  content: z.string().describe('Rendered content (truncated if very large)'),
  truncated: z.boolean(),
});

const outputSchema = {
  template: z.object({ ref: z.string(), version: z.string(), source: z.string() }),
  specName: z.string(),
  specKind: z.enum(['feature', 'bugfix']),
  mode: z.enum(['requirements-first', 'design-first', 'quick']),
  title: z.string(),
  candidateHash: z
    .string()
    .describe('Echo this to template_apply as expectedCandidateHash after review'),
  variableNames: z.array(z.string()),
  files: z.array(renderedFileShape),
  targetDir: z.string().describe('Repository-relative spec directory'),
  statePath: z.string().describe('Repository-relative sidecar state path'),
  proposedStatus: z.string().describe('Initial workflow status (all stages unapproved)'),
  diagnostics: z.array(z.object({ severity: z.string(), code: z.string(), message: z.string() })),
  suggestedNextSteps: z.array(z.string()),
};

export function registerTemplatePreviewTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'template_preview',
    title: 'Preview a template application',
    description:
      'Render a template into candidate spec files without writing anything. Returns the rendered ' +
      'content, diagnostics, target paths, the proposed sidecar state, and the candidate hash that ' +
      'template_apply requires. Shares the exact rendering path with apply.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema,
    outputSchema,
    handler: async (args) => {
      if (args.description !== undefined) {
        // Schema-capped, but keep the explicit guard for a stable error code.
        if (Buffer.byteLength(args.description, 'utf8') > LIMITS.maximumShortTextChars * 4) {
          args.description = args.description.slice(0, LIMITS.maximumShortTextChars);
        }
      }
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

      const files = plan.specPlan.files.map((file) => {
        const truncated = truncateText(file.content, LIMITS.maximumDocumentBytes);
        return {
          target: file.fileName,
          stage: file.stage,
          bytes: Buffer.byteLength(file.content, 'utf8'),
          content: truncated.text,
          truncated: truncated.truncated,
        };
      });

      return {
        text:
          `Preview of "${args.specName}" from ${plan.templateRef} v${plan.templateVersion} — nothing was written.\n` +
          files.map((file) => `- ${file.target} (${file.stage}, ${file.bytes} bytes)`).join('\n') +
          `\nCandidate hash: ${plan.candidateHash}`,
        structured: {
          template: { ref: plan.templateRef, version: plan.templateVersion, source: plan.templateSource },
          specName: plan.specPlan.specName,
          specKind: plan.specPlan.specType,
          mode: plan.mode,
          title: plan.specPlan.title,
          candidateHash: plan.candidateHash,
          variableNames: plan.variableNames,
          files,
          targetDir: repoRelative(workspace, plan.specPlan.dir),
          statePath: repoRelative(workspace, plan.specPlan.statePath),
          proposedStatus: plan.specPlan.state.status,
          diagnostics: plan.diagnostics.map((diagnostic) => ({
            severity: diagnostic.severity,
            code: diagnostic.code,
            message: diagnostic.message,
          })),
          suggestedNextSteps: [
            'Review the rendered files and diagnostics above.',
            'Call template_apply with the same inputs, expectedCandidateHash set to candidateHash, and ' +
              'acknowledgement "apply-reviewed-template".',
          ],
        },
      };
    },
  });
}
