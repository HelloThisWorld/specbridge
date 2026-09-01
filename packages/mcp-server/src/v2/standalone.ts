import { serveStdio } from './transport.js';

process.on('uncaughtException', (cause) => {
  process.stderr.write(
    (cause instanceof Error ? cause.stack ?? cause.message : String(cause)) + '\n',
  );
  process.exitCode = 1;
});

process.on('unhandledRejection', (cause) => {
  process.stderr.write(
    (cause instanceof Error ? cause.stack ?? cause.message : String(cause)) + '\n',
  );
  process.exitCode = 1;
});

void serveStdio(process.cwd()).catch((cause: unknown) => {
  process.stderr.write(
    (cause instanceof Error ? cause.stack ?? cause.message : String(cause)) + '\n',
  );
  process.exitCode = 1;
});
