import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WorkspaceInfo } from '@specbridge/core';
import type { CurrentSystemSnapshot, IntakeDeps, SystemFinding } from '@specbridge/intake';
import {
  allFindings,
  bootstrapWorkspace,
  inspectWorkspace,
  readWorkspaceSnapshot,
} from '@specbridge/intake';
import type { ServerContext } from '../context.js';
import { registerDefinedTool } from './helpers.js';
import { requireAgentConfig } from './interactive-shared.js';

/**
 * Workspace Bootstrap tools: the repository-aware starting point of a
 * product conversation.
 *
 *   workspace_bootstrap   build or revalidate the CurrentSystemSnapshot
 *   workspace_snapshot    read it, with an explicit freshness verdict
 *   repository_inspect    bounded deeper inspection via the EXISTING
 *                         repository index and retrieval ranking
 *
 * None of these creates product authority. The snapshot is durable,
 * evidence-backed understanding of what exists NOW; every finding carries
 * its evidence class, so an observed implementation detail is visibly not
 * a sealed promise. Formal Spec Intake remains the authority boundary and
 * still performs its own repository grounding.
 */

function intakeDeps(context: ServerContext, workspace: WorkspaceInfo): IntakeDeps {
  return {
    workspace,
    config: requireAgentConfig(workspace),
    clock: context.clock,
    idFactory: context.idFactory,
    host: 'mcp',
  };
}

const findingShape = z.object({
  class: z.string(),
  statement: z.string(),
  evidence: z.array(
    z.object({
      repositoryId: z.string(),
      path: z.string().optional(),
      symbol: z.string().optional(),
      contractId: z.string().optional(),
      adrId: z.string().optional(),
    }),
  ),
});

const snapshotSummaryShape = {
  snapshotId: z.string(),
  mode: z.string(),
  createdAt: z.string(),
  repositories: z.array(
    z.object({
      repositoryId: z.string(),
      relPath: z.string(),
      role: z.string().optional(),
      gitHead: z.string().nullable(),
      indexedFiles: z.number().int(),
    }),
  ),
  capabilities: z.array(findingShape),
  architecture: z.array(findingShape),
  publicSurfaces: z.array(findingShape),
  domainObjects: z.array(findingShape),
  implementationPatterns: z.array(findingShape),
  constraints: z.array(findingShape),
  uncertainties: z.array(z.object({ area: z.string(), detail: z.string() })),
  existingProductTruth: z.array(
    z.object({
      kind: z.string(),
      missionId: z.string(),
      ref: z.string(),
      revision: z.number().int().optional(),
      title: z.string(),
    }),
  ),
};

type SnapshotView = z.infer<ReturnType<typeof z.object<typeof snapshotSummaryShape>>>;

function renderFinding(finding: SystemFinding): z.infer<typeof findingShape> {
  return {
    class: finding.class,
    statement: finding.statement,
    evidence: finding.evidence.map((ref) => ({
      repositoryId: ref.repositoryId,
      ...(ref.path !== undefined ? { path: ref.path } : {}),
      ...(ref.symbol !== undefined ? { symbol: ref.symbol } : {}),
      ...(ref.contractId !== undefined ? { contractId: ref.contractId } : {}),
      ...(ref.adrId !== undefined ? { adrId: ref.adrId } : {}),
    })),
  };
}

function renderSnapshot(snapshot: CurrentSystemSnapshot): SnapshotView {
  return {
    snapshotId: snapshot.snapshotId,
    mode: snapshot.mode,
    createdAt: snapshot.createdAt,
    repositories: snapshot.repositories.map((repo) => ({
      repositoryId: repo.repositoryId,
      relPath: repo.relPath,
      ...(repo.role !== undefined ? { role: repo.role } : {}),
      gitHead: repo.gitHead,
      indexedFiles: repo.indexedFiles,
    })),
    capabilities: snapshot.capabilities.map(renderFinding),
    architecture: snapshot.architecture.map(renderFinding),
    publicSurfaces: snapshot.publicSurfaces.map(renderFinding),
    domainObjects: snapshot.domainObjects.map(renderFinding),
    implementationPatterns: snapshot.implementationPatterns.map(renderFinding),
    constraints: snapshot.constraints.map(renderFinding),
    uncertainties: snapshot.uncertainties.map((entry) => ({
      area: entry.area,
      detail: entry.detail,
    })),
    existingProductTruth: snapshot.existingProductTruth.map((ref) => ({
      kind: ref.kind,
      missionId: ref.missionId,
      ref: ref.ref,
      ...(ref.revision !== undefined ? { revision: ref.revision } : {}),
      title: ref.title,
    })),
  };
}

// ---------------------------------------------------------------------------
// workspace_bootstrap
// ---------------------------------------------------------------------------

export function registerWorkspaceBootstrapTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'workspace_bootstrap',
    title: 'Bootstrap the workspace',
    description:
      'Build (or cheaply revalidate) the CurrentSystemSnapshot: an evidence-backed, bounded ' +
      'understanding of what the system currently is, BEFORE product discovery starts. ' +
      'Brownfield repositories yield capabilities, architecture, surfaces, and constraints with ' +
      'evidence refs; an empty repository yields a clean GREENFIELD baseline. Deterministic and ' +
      'offline; reuses the existing repository index; creates no product authority.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      rebuild: z
        .boolean()
        .optional()
        .describe('Force a full index rebuild and snapshot regeneration'),
    },
    outputSchema: {
      reused: z.boolean(),
      indexRebuilt: z.boolean(),
      refreshedPaths: z.number().int(),
      snapshot: z.object(snapshotSummaryShape),
    },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      const result = bootstrapWorkspace(intakeDeps(context, workspace), {
        ...(args.rebuild === true ? { rebuild: true } : {}),
      });
      const snapshot = result.snapshot;
      return {
        text:
          `Workspace is ${snapshot.mode}: ${snapshot.repositories.length} repository/repositories, ` +
          `${snapshot.capabilities.length} capability, ${snapshot.architecture.length} architecture, ` +
          `${snapshot.existingProductTruth.length} product-truth reference(s)` +
          (result.reused ? ' (snapshot current; reused)' : ` (snapshot ${snapshot.snapshotId} generated)`) +
          '. Build the product conversation ON this system; use repository_inspect for deeper questions.',
        structured: {
          reused: result.reused,
          indexRebuilt: result.indexRebuilt,
          refreshedPaths: result.refreshedPaths,
          snapshot: renderSnapshot(snapshot),
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// workspace_snapshot
// ---------------------------------------------------------------------------

export function registerWorkspaceSnapshotTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'workspace_snapshot',
    title: 'Read the current-system snapshot',
    description:
      'Read the persisted CurrentSystemSnapshot with an explicit freshness verdict. A stale ' +
      'snapshot is still returned as background, but it is NEVER silently presented as current: ' +
      'check `freshness.status` and re-run workspace_bootstrap when it says STALE. Read-only.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {},
    outputSchema: {
      present: z.boolean(),
      freshness: z.object({ status: z.string(), reasons: z.array(z.string()) }),
      snapshot: z.object(snapshotSummaryShape).optional(),
      findingCount: z.number().int(),
    },
    handler: async () => {
      const workspace = context.requireWorkspace();
      const { snapshot, freshness } = readWorkspaceSnapshot(workspace);
      return {
        text:
          snapshot === undefined
            ? 'No snapshot exists yet. Run workspace_bootstrap first.'
            : freshness.status === 'FRESH'
              ? `Current system (${snapshot.mode}, fresh): ${allFindings(snapshot).length} finding(s).`
              : `STALE snapshot (${freshness.reasons[0] ?? 'repositories moved'}). Re-run workspace_bootstrap before relying on it.`,
        structured: {
          present: snapshot !== undefined,
          freshness: { status: freshness.status, reasons: [...freshness.reasons] },
          ...(snapshot !== undefined ? { snapshot: renderSnapshot(snapshot) } : {}),
          findingCount: snapshot !== undefined ? allFindings(snapshot).length : 0,
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// repository_inspect
// ---------------------------------------------------------------------------

export function registerRepositoryInspectTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'repository_inspect',
    title: 'Bounded repository inspection',
    description:
      'Answer a deeper question about the current implementation with a BOUNDED set of relevant ' +
      'file sections, selected by the existing deterministic repository index and retrieval ' +
      'ranking. Never dumps the repository; protected and credential-shaped paths are never ' +
      'readable through it. What it returns is OBSERVED IMPLEMENTATION — evidence about what the ' +
      'code does today, never product authority.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      question: z
        .string()
        .min(1)
        .max(2000)
        .describe('What you need to know about the current implementation'),
      repositoryId: z
        .string()
        .max(64)
        .optional()
        .describe('Restrict the inspection to one repository of the snapshot'),
      maxSections: z
        .number()
        .int()
        .min(1)
        .max(12)
        .optional()
        .describe('File sections to materialize (default 5, bounded by policy)'),
    },
    outputSchema: {
      sections: z.array(
        z.object({
          repositoryId: z.string(),
          path: z.string(),
          content: z.string(),
          startLine: z.number().int().optional(),
          endLine: z.number().int().optional(),
          symbol: z.string().optional(),
          contentHash: z.string(),
          sectioned: z.boolean(),
        }),
      ),
      pointers: z.array(z.object({ repositoryId: z.string(), path: z.string() })),
    },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      const result = inspectWorkspace(intakeDeps(context, workspace), {
        question: args.question,
        ...(args.repositoryId !== undefined ? { repositoryId: args.repositoryId } : {}),
        ...(args.maxSections !== undefined ? { maxSections: args.maxSections } : {}),
      });
      return {
        text:
          result.sections.length === 0
            ? 'Nothing in the index ranked as relevant to that question.'
            : `${result.sections.length} relevant section(s): ` +
              result.sections.map((section) => `${section.repositoryId}:${section.path}`).join(', ') +
              '. This is observed implementation, not product authority.',
        structured: {
          sections: result.sections.map((section) => ({
            repositoryId: section.repositoryId,
            path: section.path,
            content: section.content,
            ...(section.startLine !== undefined ? { startLine: section.startLine } : {}),
            ...(section.endLine !== undefined ? { endLine: section.endLine } : {}),
            ...(section.symbol !== undefined ? { symbol: section.symbol } : {}),
            contentHash: section.contentHash,
            sectioned: section.sectioned,
          })),
          pointers: result.pointers.map((pointer) => ({
            repositoryId: pointer.repositoryId,
            path: pointer.path,
          })),
        },
      };
    },
  });
}
