import { runCli } from './cli.js';

/**
 * CLI entry point. The shebang is prepended by the build (tsup banner).
 * We set process.exitCode instead of calling process.exit so stdout flushes
 * completely even for large context documents.
 */
const argv = process.argv.slice(2);

runCli(argv)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 2;
  });
