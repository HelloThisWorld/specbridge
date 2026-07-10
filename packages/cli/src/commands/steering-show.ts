import type { Command } from 'commander';
import { CLI_BIN } from '@specbridge/core';
import { loadSteeringDocument } from '@specbridge/compat-kiro';
import { createJsonReport, serializeJsonReport } from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { VERSION } from '../version.js';

export function registerSteeringShowCommand(steering: Command, runtime: CliRuntime): void {
  steering
    .command('show <name>')
    .description('Print a steering file (raw content by default)')
    .option('--json', 'output JSON with metadata and content')
    .addHelpText(
      'after',
      `
Examples:
  ${CLI_BIN} steering show product
  ${CLI_BIN} steering show api-conventions
  ${CLI_BIN} steering show tech --json`,
    )
    .action((name: string, options: { json?: boolean }) => {
      const workspace = runtime.workspace();
      const { info, document, body } = loadSteeringDocument(workspace, name);

      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.steering-show/1', `${CLI_BIN} ${VERSION}`, {
              name: info.name,
              fileName: info.fileName,
              path: info.path,
              isDefault: info.isDefault,
              inclusion: info.inclusion,
              fileMatchPattern: info.fileMatchPattern ?? null,
              hasFrontMatter: info.hasFrontMatter,
              content: document.bodyText(),
              body,
            }),
          ),
        );
        return;
      }

      // Raw content, byte-faithful (minus BOM), so output can be piped or diffed.
      runtime.outRaw(document.bodyText());
    });
}
