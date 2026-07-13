import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isStageApplicable, analyzeSpecWorkflow, evaluateWorkflow } from '@specbridge/workflow';
import type { StageName } from '@specbridge/core';
import type { ServerContext } from '../context.js';
import { McpToolError } from '../errors.js';
import { capDiagnostics } from '../limits.js';
import { diagnosticShape, specNameArg, toDiagnosticViews } from '../schemas/common.js';
import { registerDefinedTool } from './helpers.js';

/**
 * spec_analyze — deterministic v0.2 spec analysis (same bytes, same
 * findings). Never mutates approval state or files.
 */

const inputSchema = {
  specName: specNameArg,
  stage: z
    .enum(['requirements', 'bugfix', 'design', 'tasks', 'all'])
    .optional()
    .describe('Stage to analyze (default all applicable stages)'),
  strict: z.boolean().optional().describe('Treat warnings as failing the analysis result'),
};

const outputSchema = {
  specName: z.string(),
  stagesAnalyzed: z.array(z.string()),
  strict: z.boolean(),
  passed: z.boolean().describe('No errors (and, with strict, no warnings)'),
  errorCount: z.number().int(),
  warningCount: z.number().int(),
  infoCount: z.number().int(),
  diagnostics: z.array(diagnosticShape),
  diagnosticsDropped: z.number().int(),
  remediation: z.array(z.string()),
};

export function registerSpecAnalyzeTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'spec_analyze',
    title: 'Analyze a spec',
    description:
      'Run the deterministic offline spec analysis (structure, placeholders, EARS, task-plan checks). ' +
      'Same bytes always produce the same findings. Read-only; never changes approval state.',
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
      const strict = args.strict === true;

      const evaluation =
        analysis.state !== undefined ? evaluateWorkflow(workspace, analysis.state) : undefined;

      let stages: StageName[] | undefined;
      if (args.stage !== undefined && args.stage !== 'all') {
        const stage = args.stage as StageName;
        const specType = analysis.state?.specType ?? (analysis.classification.type === 'bugfix' ? 'bugfix' : 'feature');
        if (!isStageApplicable(specType, stage)) {
          throw new McpToolError(
            'SBMCP004',
            `Stage "${stage}" does not apply to a ${specType} spec.`,
          );
        }
        stages = [stage];
      }

      const result = analyzeSpecWorkflow(analysis, evaluation, stages);
      const stagesAnalyzed = result.stages.map((stage) => stage.stage);
      const infoCount = result.diagnostics.length - result.errorCount - result.warningCount;
      const passed = result.errorCount === 0 && (!strict || result.warningCount === 0);
      const capped = capDiagnostics(toDiagnosticViews(workspace, result.diagnostics));

      const remediation: string[] = [];
      if (result.errorCount > 0) {
        remediation.push(
          'Fix the error-level findings, then re-run spec_analyze; errors block stage approval.',
        );
      } else if (strict && result.warningCount > 0) {
        remediation.push('Fix the warnings or re-run without strict.');
      }

      const text = [
        `Analysis of "${analysis.folder.name}" (${stagesAnalyzed.join(', ') || 'no stages'}): ` +
          `${result.errorCount} error(s), ${result.warningCount} warning(s), ${infoCount} info — ${passed ? 'PASSED' : 'FAILED'}${strict ? ' (strict)' : ''}.`,
        ...capped.items
          .slice(0, 20)
          .map((d) => `- ${d.severity.toUpperCase()} ${d.code}: ${d.message}${d.line !== undefined ? ` (line ${d.line})` : ''}`),
        capped.items.length > 20 ? `… ${capped.items.length - 20} more finding(s) in structured content.` : '',
      ]
        .filter((line) => line.length > 0)
        .join('\n');

      return {
        text,
        structured: {
          specName: analysis.folder.name,
          stagesAnalyzed,
          strict,
          passed,
          errorCount: result.errorCount,
          warningCount: result.warningCount,
          infoCount,
          diagnostics: capped.items,
          diagnosticsDropped: capped.dropped,
          remediation,
        },
      };
    },
  });
}
