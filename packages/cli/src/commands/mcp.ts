import type { Command } from 'commander';
import { CLI_BIN } from '@specbridge/core';
import {
  MCP_PROTOCOL_BASELINE,
  MCP_SDK_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  PROMPT_CATALOG,
  RESOURCE_CATALOG,
  TOOL_CATALOG,
  runMcpDoctor,
  runMcpServe,
} from '@specbridge/mcp-server';
import {
  createJsonReport,
  dim,
  failLine,
  okLine,
  reportTitle,
  sectionTitle,
  serializeJsonReport,
  warnLine,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { VERSION } from '../version.js';

/**
 * `specbridge mcp serve|doctor|manifest|tools` — the MCP server surface of
 * the CLI. `serve` speaks MCP over stdio (stdout carries protocol frames
 * only; every log goes to stderr). The other three are read-only
 * diagnostics that never start a transport.
 */

interface McpViewOptions {
  json?: boolean;
  verbose?: boolean;
}

export function registerMcpCommands(program: Command, runtime: CliRuntime): void {
  const mcp = program
    .command('mcp')
    .description('Run and inspect the SpecBridge MCP server (stdio, local-only)');

  mcp
    .command('serve')
    .description('Start the MCP server over stdio (stdout is reserved for protocol frames)')
    .option('--stdio', 'use the stdio transport (default and only transport in v0.5)')
    .option('--project-root <path>', 'project root to serve (default: resolution order, then cwd)')
    .option('--log-level <level>', 'stderr log level: silent|error|warn|info|debug', 'warn')
    .option('--json-logs', 'emit structured JSON log lines on stderr')
    .addHelpText(
      'after',
      `
The server serves exactly one project root for its whole lifetime; no tool
argument can switch projects after startup. Resolution order:
--project-root, SPECBRIDGE_PROJECT_ROOT, CLAUDE_PROJECT_DIR, then the
current working directory.

Examples:
  ${CLI_BIN} mcp serve --stdio --project-root .
  ${CLI_BIN} mcp serve --log-level info --json-logs`,
    )
    .action(
      async (options: { projectRoot?: string; logLevel?: string; jsonLogs?: boolean }) => {
        const argv = ['--stdio'];
        if (options.projectRoot !== undefined) argv.push('--project-root', options.projectRoot);
        if (options.logLevel !== undefined) argv.push('--log-level', options.logLevel);
        if (options.jsonLogs === true) argv.push('--json-logs');
        // Serve resolves the project root itself; -C is honored through cwd.
        runtime.exitCode = await runMcpServe(argv, {
          stdout: (line) => runtime.out(line),
          stderr: (line) => runtime.err(line),
        });
      },
    );

  mcp
    .command('doctor')
    .description('Diagnose the MCP setup (read-only; starts no transport)')
    .option('--json', 'output a machine-readable JSON report')
    .option('--verbose', 'show every check, not only problems')
    .action(async (options: McpViewOptions) => {
      const report = await runMcpDoctor({ cwd: runtime.cwd });
      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(createJsonReport('specbridge.mcp-doctor/1', `${CLI_BIN} ${VERSION}`, report)),
        );
        runtime.exitCode = report.healthy ? 0 : 1;
        return;
      }
      runtime.out(reportTitle('MCP doctor'));
      runtime.out();
      for (const check of report.checks) {
        if (check.status === 'ok') {
          if (options.verbose === true) runtime.out(okLine(check.name, check.detail));
        } else if (check.status === 'warn') {
          runtime.out(warnLine(`${check.name}: ${check.detail}`));
        } else {
          runtime.out(failLine(check.name, check.detail));
        }
      }
      const failed = report.checks.filter((check) => check.status === 'fail').length;
      const warned = report.checks.filter((check) => check.status === 'warn').length;
      runtime.out();
      runtime.out(
        failed === 0
          ? okLine(`MCP setup is healthy (${report.checks.length} checks, ${warned} warning(s)).`)
          : failLine(`${failed} check(s) failed.`),
      );
      runtime.out(dim(`  Server ${report.serverVersion} · SDK ${report.sdkVersion} · protocol baseline ${report.protocolBaseline}`));
      runtime.exitCode = report.healthy ? 0 : 1;
    });

  mcp
    .command('manifest')
    .description('Print the MCP server identity, protocol baseline, and capability counts')
    .option('--json', 'output a machine-readable JSON report')
    .action((options: McpViewOptions) => {
      const manifest = {
        name: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION,
        sdkVersion: MCP_SDK_VERSION,
        protocolBaseline: MCP_PROTOCOL_BASELINE,
        transport: 'stdio',
        tools: TOOL_CATALOG.length,
        resources: RESOURCE_CATALOG.length,
        prompts: PROMPT_CATALOG.length,
      };
      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(createJsonReport('specbridge.mcp-manifest/1', `${CLI_BIN} ${VERSION}`, manifest)),
        );
        return;
      }
      runtime.out(reportTitle('MCP manifest'));
      runtime.out();
      runtime.out(`  Name:              ${manifest.name}`);
      runtime.out(`  Version:           ${manifest.version}`);
      runtime.out(`  SDK:               @modelcontextprotocol/sdk ${manifest.sdkVersion} (pinned)`);
      runtime.out(`  Protocol baseline: ${manifest.protocolBaseline}`);
      runtime.out(`  Transport:         ${manifest.transport}`);
      runtime.out(`  Capabilities:      ${manifest.tools} tools · ${manifest.resources} resources · ${manifest.prompts} prompts`);
    });

  mcp
    .command('tools')
    .description('List the MCP tools (and, with --verbose, resources and prompts)')
    .option('--json', 'output a machine-readable JSON report')
    .option('--verbose', 'include resources and prompts')
    .action((options: McpViewOptions) => {
      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.mcp-tools/1', `${CLI_BIN} ${VERSION}`, {
              tools: TOOL_CATALOG,
              ...(options.verbose === true
                ? { resources: RESOURCE_CATALOG, prompts: PROMPT_CATALOG }
                : {}),
            }),
          ),
        );
        return;
      }
      runtime.out(reportTitle('MCP tools'));
      runtime.out();
      for (const tool of TOOL_CATALOG) {
        runtime.out(`  ${tool.name.padEnd(24)} ${tool.readOnly ? '[read-only]' : '[state]    '} ${tool.summary}`);
      }
      if (options.verbose === true) {
        runtime.out();
        runtime.out(sectionTitle('Resources'));
        for (const resource of RESOURCE_CATALOG) {
          runtime.out(`  ${resource.uri.padEnd(44)} ${resource.mimeType.padEnd(18)} ${resource.summary}`);
        }
        runtime.out();
        runtime.out(sectionTitle('Prompts'));
        for (const prompt of PROMPT_CATALOG) {
          runtime.out(`  ${prompt.name.padEnd(28)} ${prompt.summary}`);
        }
      }
      runtime.out();
      runtime.out(dim(`  Stage approval is deliberately NOT an MCP tool; humans approve via "${CLI_BIN} spec approve".`));
    });
}
