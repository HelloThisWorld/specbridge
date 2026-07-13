import { randomUUID } from 'node:crypto';
import type { SpecAnalysis } from '@specbridge/compat-kiro';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import type { WorkspaceInfo } from '@specbridge/core';
import { KIRO_DIR_NAME, isSpecBridgeError, resolveWorkspace } from '@specbridge/core';
import { McpToolError } from './errors.js';
import type { McpLogger } from './logging.js';

/**
 * Per-process server context.
 *
 * One context serves one project root for the whole server lifetime. The
 * `.kiro` workspace is discovered lazily (so the server can start before a
 * workspace exists and report that honestly through `workspace_detect`), but
 * once discovered its root is pinned: a workspace that later resolves to a
 * different directory is treated as an error, never silently adopted.
 *
 * Reads run concurrently; every state-changing operation serializes through
 * `withWriteLock` so two writers can never interleave inside one server
 * process. Cross-process interactive execution is additionally guarded by
 * the repository-local lock file (see @specbridge/execution).
 */

export interface ServerContextOptions {
  projectRoot: string;
  logger: McpLogger;
  clock?: () => Date;
  idFactory?: () => string;
}

export class ServerContext {
  readonly projectRoot: string;
  readonly logger: McpLogger;
  readonly clock: () => Date;
  readonly idFactory: () => string;

  private pinnedWorkspaceRoot: string | undefined;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(options: ServerContextOptions) {
    this.projectRoot = options.projectRoot;
    this.logger = options.logger;
    this.clock = options.clock ?? ((): Date => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  /**
   * Resolve the `.kiro` workspace from the pinned project root, or
   * `undefined` when none exists yet. The first successful resolution pins
   * the workspace root for the rest of the process lifetime.
   */
  tryWorkspace(): WorkspaceInfo | undefined {
    const workspace = resolveWorkspace(this.pinnedWorkspaceRoot ?? this.projectRoot);
    if (workspace === undefined) return undefined;
    if (this.pinnedWorkspaceRoot === undefined) {
      this.pinnedWorkspaceRoot = workspace.rootDir;
    } else if (workspace.rootDir !== this.pinnedWorkspaceRoot) {
      // The pinned directory no longer holds `.kiro` and a DIFFERENT
      // ancestor does. Serving it would silently switch projects — refuse.
      throw new McpToolError(
        'SBMCP001',
        `The workspace moved: this server was started for ${this.pinnedWorkspaceRoot} but ` +
          `${KIRO_DIR_NAME} now resolves to ${workspace.rootDir}. Restart the MCP server in the intended project.`,
      );
    }
    return workspace;
  }

  /** Resolve the workspace or fail with SBMCP001 and actionable remediation. */
  requireWorkspace(): WorkspaceInfo {
    const workspace = this.tryWorkspace();
    if (workspace === undefined) {
      throw new McpToolError(
        'SBMCP001',
        `No ${KIRO_DIR_NAME} directory found in ${this.projectRoot} or any parent directory.`,
        {
          remediation: [
            'Open a project that contains a .kiro directory,',
            'or create a first spec with the spec_create tool (it initializes .kiro/specs/).',
          ],
        },
      );
    }
    return workspace;
  }

  /** Locate and analyze one spec, mapping not-found onto SBMCP003. */
  requireSpecAnalysis(specName: string): { workspace: WorkspaceInfo; analysis: SpecAnalysis } {
    const workspace = this.requireWorkspace();
    try {
      const folder = requireSpec(workspace, specName);
      return { workspace, analysis: analyzeSpec(workspace, folder) };
    } catch (cause) {
      if (isSpecBridgeError(cause) && cause.code === 'SPEC_NOT_FOUND') {
        throw new McpToolError('SBMCP003', cause.message, {
          remediation: ['List available specs with the spec_list tool.'],
        });
      }
      throw cause;
    }
  }

  /**
   * Serialize a state-changing operation. Later writers queue behind earlier
   * ones even when an earlier writer fails.
   */
  withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(operation, operation);
    // Keep the chain alive regardless of this operation's outcome.
    this.writeChain = next.catch(() => undefined);
    return next;
  }
}
