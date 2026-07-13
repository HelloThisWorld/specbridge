import { runMcpServe } from './cli.js';

/**
 * Standalone stdio server entry — bundled as `dist/mcp-server.cjs` inside
 * the Claude Code plugin and launched via its `.mcp.json`.
 *
 * Uncaught failures go to stderr (never stdout) and exit non-zero
 * deterministically.
 */

process.on('uncaughtException', (cause) => {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'uncaught_exception',
      message: cause instanceof Error ? cause.message : String(cause),
    })}\n`,
  );
  process.exitCode = 1;
});
process.on('unhandledRejection', (cause) => {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'unhandled_rejection',
      message: cause instanceof Error ? cause.message : String(cause),
    })}\n`,
  );
  process.exitCode = 1;
});

runMcpServe(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        event: 'server_crashed',
        message: cause instanceof Error ? cause.message : String(cause),
      })}\n`,
    );
    process.exitCode = 1;
  });
