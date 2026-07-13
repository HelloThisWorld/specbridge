import { existsSync } from 'node:fs';
import path from 'node:path';
import { readAgentConfig, resolveWorkspace } from '@specbridge/core';
import { ServerContext } from './context.js';
import { createLogger } from './logging.js';
import { PROMPT_CATALOG } from './prompts/registry.js';
import { resolveProjectRoot } from './project-root.js';
import { RESOURCE_CATALOG } from './resources/registry.js';
import { buildMcpServer } from './server.js';
import { TOOL_CATALOG } from './tools/registry.js';
import {
  MCP_PROTOCOL_BASELINE,
  MCP_SDK_VERSION,
  MCP_SERVER_VERSION,
  REQUIRED_NODE_MAJOR,
} from './version.js';

/**
 * `specbridge mcp doctor` — read-only diagnosis of the MCP setup. Nothing
 * here mutates the workspace, starts a transport, or talks to a network.
 */

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export interface McpDoctorReport {
  serverVersion: string;
  sdkVersion: string;
  protocolBaseline: string;
  checks: DoctorCheck[];
  healthy: boolean;
}

export interface McpDoctorOptions {
  projectRootFlag?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export async function runMcpDoctor(options: McpDoctorOptions = {}): Promise<McpDoctorReport> {
  const checks: DoctorCheck[] = [];
  const env = options.env ?? process.env;

  // Node.js version.
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push(
    nodeMajor >= REQUIRED_NODE_MAJOR
      ? { name: 'node-version', status: 'ok', detail: `Node.js ${process.versions.node}` }
      : {
          name: 'node-version',
          status: 'fail',
          detail: `Node.js ${process.versions.node} is too old; ${REQUIRED_NODE_MAJOR}+ is required.`,
        },
  );

  // Project root resolution.
  const resolution = resolveProjectRoot({
    ...(options.projectRootFlag !== undefined ? { flagValue: options.projectRootFlag } : {}),
    env,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  });
  if (!resolution.ok) {
    checks.push({ name: 'project-root', status: 'fail', detail: resolution.message });
  } else {
    checks.push({
      name: 'project-root',
      status: 'ok',
      detail: `${resolution.projectRoot} (from ${resolution.source})`,
    });

    // Workspace availability (informational — the server may still start).
    const workspace = resolveWorkspace(resolution.projectRoot);
    if (workspace === undefined) {
      checks.push({
        name: 'kiro-workspace',
        status: 'warn',
        detail: 'No .kiro directory found; tools will report SBMCP001 until one exists.',
      });
    } else {
      checks.push({ name: 'kiro-workspace', status: 'ok', detail: `.kiro found at ${workspace.rootDir}` });
      const configRead = readAgentConfig(workspace);
      checks.push(
        !configRead.exists
          ? {
              name: 'specbridge-config',
              status: 'ok',
              detail: '.specbridge/config.json absent; safe defaults apply.',
            }
          : configRead.config !== undefined
            ? { name: 'specbridge-config', status: 'ok', detail: 'Configuration is valid.' }
            : {
                name: 'specbridge-config',
                status: 'fail',
                detail: `Configuration is invalid: ${configRead.diagnostics.map((d) => d.message).join('; ')}`,
              },
      );
    }
  }

  // Versions and protocol baseline.
  checks.push({ name: 'server-version', status: 'ok', detail: MCP_SERVER_VERSION });
  checks.push({ name: 'sdk-version', status: 'ok', detail: `@modelcontextprotocol/sdk ${MCP_SDK_VERSION} (pinned)` });
  checks.push({ name: 'protocol-baseline', status: 'ok', detail: MCP_PROTOCOL_BASELINE });

  // Registries: unique names and non-empty catalogs.
  const toolNames = new Set(TOOL_CATALOG.map((tool) => tool.name));
  checks.push(
    toolNames.size === TOOL_CATALOG.length && TOOL_CATALOG.length > 0
      ? { name: 'tool-registry', status: 'ok', detail: `${TOOL_CATALOG.length} tools, names unique` }
      : { name: 'tool-registry', status: 'fail', detail: 'Tool names are not unique.' },
  );
  const resourceNames = new Set(RESOURCE_CATALOG.map((resource) => resource.name));
  checks.push(
    resourceNames.size === RESOURCE_CATALOG.length && RESOURCE_CATALOG.length > 0
      ? {
          name: 'resource-registry',
          status: 'ok',
          detail: `${RESOURCE_CATALOG.length} resources, names unique`,
        }
      : { name: 'resource-registry', status: 'fail', detail: 'Resource names are not unique.' },
  );
  const promptNames = new Set(PROMPT_CATALOG.map((prompt) => prompt.name));
  checks.push(
    promptNames.size === PROMPT_CATALOG.length && PROMPT_CATALOG.length > 0
      ? { name: 'prompt-registry', status: 'ok', detail: `${PROMPT_CATALOG.length} prompts, names unique` }
      : { name: 'prompt-registry', status: 'fail', detail: 'Prompt names are not unique.' },
  );

  // Stdio cleanliness: constructing and registering the full server must
  // write nothing to stdout (protocol frames are the transport's job).
  if (resolution.ok) {
    const originalWrite = process.stdout.write.bind(process.stdout);
    let stdoutBytes = 0;
    (process.stdout as { write: unknown }).write = ((chunk: string | Uint8Array): boolean => {
      stdoutBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
      return true;
    }) as typeof process.stdout.write;
    try {
      const silentLogger = createLogger({ level: 'silent', json: true, sink: () => undefined });
      buildMcpServer(
        new ServerContext({ projectRoot: resolution.projectRoot, logger: silentLogger }),
      );
    } finally {
      (process.stdout as { write: unknown }).write = originalWrite;
    }
    checks.push(
      stdoutBytes === 0
        ? { name: 'stdio-cleanliness', status: 'ok', detail: 'Server construction writes nothing to stdout.' }
        : {
            name: 'stdio-cleanliness',
            status: 'fail',
            detail: `Server construction wrote ${stdoutBytes} byte(s) to stdout.`,
          },
    );
  }

  // Plugin bundle paths, when running from an installed Claude Code plugin.
  const pluginRoot = env['CLAUDE_PLUGIN_ROOT'];
  if (pluginRoot !== undefined && pluginRoot.length > 0) {
    const missing = ['dist/mcp-server.cjs', 'dist/cli.cjs'].filter(
      (relative) => !existsSync(path.join(pluginRoot, relative)),
    );
    checks.push(
      missing.length === 0
        ? { name: 'plugin-bundle', status: 'ok', detail: `Bundled executables present under ${pluginRoot}` }
        : {
            name: 'plugin-bundle',
            status: 'fail',
            detail: `Missing bundled file(s) under ${pluginRoot}: ${missing.join(', ')}. Reinstall the plugin.`,
          },
    );
  }

  return {
    serverVersion: MCP_SERVER_VERSION,
    sdkVersion: MCP_SDK_VERSION,
    protocolBaseline: MCP_PROTOCOL_BASELINE,
    checks,
    healthy: checks.every((check) => check.status !== 'fail'),
  };
}
