import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  buildAgentContextMarkdown,
  discoverSpecs,
  listSteeringFiles,
  loadSteeringDocument,
} from '@specbridge/compat-kiro';
import type { SteeringDocument } from '@specbridge/compat-kiro';
import { trySha256File } from '@specbridge/core';
import type { ServerContext } from '../context.js';
import { evaluateSpecBundle, toSpecSummary } from '../schemas/spec-views.js';
import { MCP_SERVER_VERSION } from '../version.js';
import { assertPlainName, jsonContents, markdownContents, resourceNotFound } from './helpers.js';

/**
 * specbridge://specs/{specName}/{document}
 *
 * `document` is a closed vocabulary: the four canonical Markdown documents
 * plus `status` (JSON) and `context` (Markdown). Arbitrary file names are
 * rejected — resources never address filesystem paths.
 */

const MARKDOWN_DOCUMENTS = ['requirements', 'bugfix', 'design', 'tasks'] as const;
type MarkdownDocumentKind = (typeof MARKDOWN_DOCUMENTS)[number];

function isMarkdownDocument(value: string): value is MarkdownDocumentKind {
  return (MARKDOWN_DOCUMENTS as readonly string[]).includes(value);
}

export function registerSpecResources(server: McpServer, context: ServerContext): void {
  server.registerResource(
    'spec',
    new ResourceTemplate('specbridge://specs/{specName}/{document}', {
      list: () => {
        const workspace = context.tryWorkspace();
        if (workspace === undefined) return { resources: [] };
        const resources = [];
        for (const folder of discoverSpecs(workspace).slice(0, 100)) {
          const encoded = encodeURIComponent(folder.name);
          for (const file of folder.files) {
            if (!isMarkdownDocument(file.kind)) continue;
            resources.push({
              uri: `specbridge://specs/${encoded}/${file.kind}`,
              name: `${folder.name}/${file.kind}`,
              description: `${file.kind}.md of spec "${folder.name}"`,
              mimeType: 'text/markdown',
            });
          }
          resources.push({
            uri: `specbridge://specs/${encoded}/status`,
            name: `${folder.name}/status`,
            description: `Workflow status of spec "${folder.name}"`,
            mimeType: 'application/json',
          });
          resources.push({
            uri: `specbridge://specs/${encoded}/context`,
            name: `${folder.name}/context`,
            description: `Agent-ready context for spec "${folder.name}"`,
            mimeType: 'text/markdown',
          });
        }
        return { resources };
      },
    }),
    {
      title: 'Spec documents and state',
      description:
        'Canonical spec documents (requirements | bugfix | design | tasks), workflow status, and agent context.',
    },
    async (uri, variables) => {
      const specName = assertPlainName('spec name', String(variables['specName'] ?? ''));
      const document = assertPlainName('document', String(variables['document'] ?? ''));
      const { workspace, analysis } = context.requireSpecAnalysis(specName);

      if (isMarkdownDocument(document)) {
        const markdownDocument = analysis.documents[document];
        if (markdownDocument === undefined) {
          throw resourceNotFound(
            `${document}.md of spec "${analysis.folder.name}"`,
            'The stage document does not exist yet.',
          );
        }
        return markdownContents(context, uri.href, markdownDocument.bodyText());
      }

      if (document === 'status') {
        const bundle = evaluateSpecBundle(workspace, analysis);
        return jsonContents(context, uri.href, {
          summary: toSpecSummary(bundle),
          stages:
            bundle.evaluation?.stages.map((stage) => ({
              stage: stage.stage,
              stored: stage.stored.status,
              effective: stage.effective,
              file: stage.stored.file,
              approvedAt: stage.stored.approvedAt,
              approvedHash: stage.stored.approvedHash,
              currentHash: stage.currentHash ?? trySha256File(stage.filePath) ?? null,
            })) ?? [],
          staleStages: bundle.evaluation?.staleStages ?? [],
        });
      }

      if (document === 'context') {
        const steering: SteeringDocument[] = [];
        for (const info of listSteeringFiles(workspace)) {
          if (info.inclusion !== 'always' && info.inclusion !== 'unknown') continue;
          try {
            steering.push(loadSteeringDocument(workspace, info.name));
          } catch {
            // Unreadable steering is reported elsewhere; skip in context.
          }
        }
        const conditionalSteering = listSteeringFiles(workspace)
          .filter((info) => info.inclusion === 'fileMatch' || info.inclusion === 'manual')
          .map((info) => ({
            name: info.name,
            inclusion: info.inclusion,
            ...(info.fileMatchPattern !== undefined ? { fileMatchPattern: info.fileMatchPattern } : {}),
          }));
        const markdown = buildAgentContextMarkdown(
          { workspace, analysis, steering, conditionalSteering, generatorVersion: MCP_SERVER_VERSION },
          { target: 'generic' },
        );
        return markdownContents(context, uri.href, markdown);
      }

      throw resourceNotFound(
        `Spec resource "${document}"`,
        'Valid documents: requirements, bugfix, design, tasks, status, context.',
      );
    },
  );
}
