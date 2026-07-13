import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerContext } from '../context.js';
import { promptResult } from './helpers.js';

export function registerAuthorPrompt(server: McpServer, context: ServerContext): void {
  server.registerPrompt(
    'specbridge-author-stage',
    {
      title: 'Author a spec stage',
      description:
        'Draft a candidate stage document, validate it deterministically, present the diff for review, ' +
        'and apply it only after explicit user confirmation. The stage remains unapproved.',
      argsSchema: {
        specName: z.string().max(120).describe('Spec to author'),
        stage: z.string().max(20).describe('Stage: requirements | bugfix | design | tasks'),
        instruction: z.string().max(4000).optional().describe('Optional authoring instruction'),
      },
    },
    ({ specName, stage, instruction }) =>
      promptResult(
        context,
        'specbridge-author-stage',
        `Author the ${stage} stage of "${specName}"`,
        [
          `Author the ${stage} stage of the spec "${specName}" through the SpecBridge MCP tools.`,
          instruction !== undefined && instruction.length > 0 ? `User instruction: ${instruction}` : '',
          '',
          '1. Call spec_status to confirm the stage is authorable (draft, prerequisites approved).',
          '2. Read steering (steering_list / steering_read) and the prerequisite documents (spec_read).',
          '3. Draft the complete candidate Markdown yourself in this session.',
          '4. Call spec_stage_validate with the candidate. If it reports errors, revise and validate again.',
          '5. Present to the user: a summary, your assumptions, open questions, the returned diff, and which approvals applying would invalidate.',
          '6. Only after the user explicitly confirms, call spec_stage_apply with the exact validated candidate, the returned candidateHash as expectedCandidateHash, the reported currentHash as expectedCurrentHash, and acknowledgement "apply-reviewed-candidate".',
          '7. Tell the user the stage is applied but NOT approved: approval is a human action via the SpecBridge CLI (specbridge spec approve).',
          '',
          'Never edit .kiro files directly; the tool performs the validated atomic write. Never claim the stage is approved.',
        ]
          .filter((line) => line !== '')
          .join('\n'),
      ),
  );
}
