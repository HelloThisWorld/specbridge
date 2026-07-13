import type { LogLevel } from './logging.js';
import { createLogger, parseLogLevel } from './logging.js';
import { serveStdio } from './transport.js';
import { MCP_SERVER_VERSION } from './version.js';

/**
 * Minimal argument handling for the standalone `mcp-server.cjs` bundle (the
 * entry the Claude Code plugin launches). The full `specbridge mcp …`
 * command group lives in the CLI package and reuses the same functions; the
 * standalone entry supports serving only, because that is all a plugin host
 * ever invokes.
 *
 * stdout discipline: this entry NEVER writes to stdout except for
 * `--version` (which never starts a server). Everything else goes to stderr.
 */

export interface StandaloneArgs {
  stdio: boolean;
  projectRoot?: string;
  logLevel: LogLevel;
  jsonLogs: boolean;
  version: boolean;
  problems: string[];
}

export function parseServeArgs(argv: string[]): StandaloneArgs {
  const args: StandaloneArgs = {
    stdio: true,
    logLevel: 'warn',
    jsonLogs: false,
    version: false,
    problems: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--stdio':
        args.stdio = true;
        break;
      case '--project-root': {
        const value = argv[i + 1];
        if (value === undefined) {
          args.problems.push('--project-root requires a path argument.');
        } else {
          args.projectRoot = value;
          i += 1;
        }
        break;
      }
      case '--log-level': {
        const value = argv[i + 1];
        const parsed = value !== undefined ? parseLogLevel(value) : undefined;
        if (parsed === undefined) {
          args.problems.push('--log-level must be one of: silent, error, warn, info, debug.');
        } else {
          args.logLevel = parsed;
          i += 1;
        }
        break;
      }
      case '--json-logs':
        args.jsonLogs = true;
        break;
      case '--version':
      case '-V':
        args.version = true;
        break;
      case 'serve':
        // Tolerated so `mcp-server.cjs serve --stdio` also works.
        break;
      default:
        args.problems.push(`Unknown argument "${arg}".`);
    }
  }
  return args;
}

/** Entry point used by the standalone bundle and by `specbridge mcp serve`. */
export async function runMcpServe(
  argv: string[],
  io: { stdout: (line: string) => void; stderr: (line: string) => void } = {
    stdout: (line) => void process.stdout.write(`${line}\n`),
    stderr: (line) => void process.stderr.write(`${line}\n`),
  },
): Promise<number> {
  const args = parseServeArgs(argv);
  if (args.version) {
    io.stdout(MCP_SERVER_VERSION);
    return 0;
  }
  if (args.problems.length > 0) {
    for (const problem of args.problems) io.stderr(problem);
    io.stderr(
      'Usage: mcp-server [--stdio] [--project-root <path>] [--log-level <silent|error|warn|info|debug>] [--json-logs] [--version]',
    );
    return 2;
  }

  const logger = createLogger({
    level: args.logLevel,
    json: args.jsonLogs,
    sink: (line) => io.stderr(line),
  });
  const result = await serveStdio({
    ...(args.projectRoot !== undefined ? { projectRootFlag: args.projectRoot } : {}),
    logger,
  });
  return result.exitCode;
}
