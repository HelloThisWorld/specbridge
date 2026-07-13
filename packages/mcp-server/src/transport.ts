import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ServerContext } from './context.js';
import type { McpLogger } from './logging.js';
import { resolveProjectRoot } from './project-root.js';
import { buildMcpServer } from './server.js';
import { MCP_PROTOCOL_BASELINE, MCP_SERVER_VERSION } from './version.js';

/**
 * Stdio transport lifecycle.
 *
 * Contract: stdout carries MCP protocol frames only. Every diagnostic —
 * including uncaught exceptions — goes to stderr through the structured
 * logger. SIGINT/SIGTERM close the transport and resolve the serve promise
 * deterministically so the process can exit cleanly.
 */

export interface ServeStdioOptions {
  projectRootFlag?: string;
  logger: McpLogger;
  env?: Record<string, string | undefined>;
  cwd?: string;
  clock?: () => Date;
  idFactory?: () => string;
  /** Injected for tests; defaults to the real process signals. */
  processLike?: Pick<NodeJS.Process, 'on' | 'off'>;
}

export interface ServeResult {
  /** 0 on clean shutdown, 1 on startup failure. */
  exitCode: number;
}

export async function serveStdio(options: ServeStdioOptions): Promise<ServeResult> {
  const logger = options.logger;

  const resolution = resolveProjectRoot({
    ...(options.projectRootFlag !== undefined ? { flagValue: options.projectRootFlag } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  });
  if (!resolution.ok) {
    logger.error('server_start_failed', {
      message: resolution.message,
      remediation: resolution.remediation.join(' '),
    });
    return { exitCode: 1 };
  }

  const context = new ServerContext({
    projectRoot: resolution.projectRoot,
    logger,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.idFactory !== undefined ? { idFactory: options.idFactory } : {}),
  });
  const server = buildMcpServer(context);
  const transport = new StdioServerTransport();

  const processLike = options.processLike ?? process;

  let resolveClosed: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('server_stopped', { reason: signal });
    try {
      await server.close();
    } catch {
      // The transport may already be gone; shutdown stays deterministic.
    }
    resolveClosed();
  };
  const onSigint = (): void => void shutdown('SIGINT');
  const onSigterm = (): void => void shutdown('SIGTERM');
  processLike.on('SIGINT', onSigint);
  processLike.on('SIGTERM', onSigterm);

  server.server.onclose = (): void => {
    logger.info('server_stopped', { reason: 'transport-closed' });
    resolveClosed();
  };

  try {
    await server.connect(transport);
  } catch (cause) {
    logger.error('server_start_failed', {
      message: cause instanceof Error ? cause.message : String(cause),
    });
    processLike.off('SIGINT', onSigint);
    processLike.off('SIGTERM', onSigterm);
    return { exitCode: 1 };
  }

  logger.info('server_started', {
    version: MCP_SERVER_VERSION,
    protocolBaseline: MCP_PROTOCOL_BASELINE,
    projectRoot: resolution.projectRoot,
    projectRootSource: resolution.source,
  });

  await closed;
  processLike.off('SIGINT', onSigint);
  processLike.off('SIGTERM', onSigterm);
  return { exitCode: 0 };
}
