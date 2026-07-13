import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { trySha256File } from '@specbridge/core';
import type { ServerContext } from '../context.js';
import { LIMITS, truncateText } from '../limits.js';
import { repoRelative, specNameArg } from '../schemas/common.js';
import { registerDefinedTool } from './helpers.js';

/**
 * spec_read — read spec stage documents by well-known kind.
 *
 * Only the four canonical documents are addressable; arbitrary filenames
 * are rejected by the input schema itself.
 */

const DOCUMENT_KINDS = ['requirements', 'bugfix', 'design', 'tasks'] as const;

const inputSchema = {
  specName: specNameArg,
  document: z
    .enum([...DOCUMENT_KINDS, 'all'])
    .describe('Which canonical document to read (requirements | bugfix | design | tasks | all)'),
};

const documentShape = z.object({
  document: z.enum(DOCUMENT_KINDS),
  path: z.string().describe('Repository-relative path'),
  exists: z.boolean(),
  content: z.string().optional(),
  truncated: z.boolean().optional(),
  contentHash: z.string().optional().describe('SHA-256 of the exact file bytes'),
  lineCount: z.number().int().optional(),
  eol: z.enum(['lf', 'crlf', 'cr', 'mixed', 'none']).optional(),
  hasBom: z.boolean().optional(),
  encodingSafe: z.boolean().optional(),
});

const outputSchema = {
  specName: z.string(),
  documents: z.array(documentShape),
};

export function registerSpecReadTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'spec_read',
    title: 'Read spec documents',
    description:
      'Read the source content and line metadata of one canonical spec document ' +
      '(requirements, bugfix, design, tasks) or all of them. Read-only; never accepts arbitrary paths.',
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
      const kinds =
        args.document === 'all' ? [...DOCUMENT_KINDS] : [args.document as (typeof DOCUMENT_KINDS)[number]];

      const documents = kinds.map((kind): z.infer<typeof documentShape> => {
        const document = analysis.documents[kind];
        const relativePath = `.kiro/specs/${analysis.folder.name}/${kind}.md`;
        if (document === undefined) {
          return { document: kind, path: relativePath, exists: false };
        }
        const bounded = truncateText(document.bodyText(), LIMITS.maximumDocumentBytes);
        const hash =
          document.filePath !== undefined ? trySha256File(document.filePath) : undefined;
        return {
          document: kind,
          path:
            document.filePath !== undefined ? repoRelative(workspace, document.filePath) : relativePath,
          exists: true,
          content: bounded.text,
          truncated: bounded.truncated,
          ...(hash !== undefined ? { contentHash: hash } : {}),
          lineCount: document.lineCount,
          eol: document.dominantEol(),
          hasBom: document.hasBom,
          encodingSafe: document.encodingSafe,
        };
      });

      const present = documents.filter((doc) => doc.exists);
      const text =
        present.length === 0
          ? `Spec "${analysis.folder.name}" has none of the requested document(s) yet.`
          : present
              .map((doc) => `## ${doc.path}\n\n${doc.content ?? ''}${doc.truncated === true ? '\n\n[truncated]' : ''}`)
              .join('\n\n');

      return { text, structured: { specName: analysis.folder.name, documents } };
    },
  });
}
