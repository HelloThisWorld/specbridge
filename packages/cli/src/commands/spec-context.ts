import path from 'node:path';
import type { Command } from 'commander';
import { CLI_BIN, SpecBridgeError, assertInsideWorkspace, writeFileAtomic } from '@specbridge/core';
import type { AgentContextTarget, SteeringDocument } from '@specbridge/compat-kiro';
import {
  analyzeSpec,
  buildAgentContextJson,
  buildAgentContextMarkdown,
  listSteeringFiles,
  loadSteeringDocument,
  requireSpec,
} from '@specbridge/compat-kiro';
import { serializeJsonReport } from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { VERSION } from '../version.js';

const FORMATS = ['markdown', 'json'] as const;
const TARGETS = ['generic', 'claude-code'] as const;

export function registerSpecContextCommand(spec: Command, runtime: CliRuntime): void {
  spec
    .command('context <name>')
    .description('Assemble steering + spec + progress into one agent-ready context document')
    .option('--format <format>', `output format (${FORMATS.join(', ')})`, 'markdown')
    .option('--target <target>', `agent target (${TARGETS.join(', ')})`, 'generic')
    .option('--all-steering', 'inline fileMatch/manual steering files too, not just always-included ones')
    .option('--out <file>', 'also write the context to a file (must be outside .kiro)')
    .addHelpText(
      'after',
      `
This command never invokes a model; it only assembles what is on disk.

Examples:
  ${CLI_BIN} spec context user-authentication
  ${CLI_BIN} spec context user-authentication --target claude-code
  ${CLI_BIN} spec context user-authentication --format json
  ${CLI_BIN} spec context user-authentication --out .specbridge/reports/context.md`,
    )
    .action(
      (
        name: string,
        options: { format: string; target: string; allSteering?: boolean; out?: string },
      ) => {
        if (!(FORMATS as readonly string[]).includes(options.format)) {
          throw new SpecBridgeError(
            'INVALID_ARGUMENT',
            `Unknown --format "${options.format}". Valid formats: ${FORMATS.join(', ')}.`,
          );
        }
        if (!(TARGETS as readonly string[]).includes(options.target)) {
          throw new SpecBridgeError(
            'INVALID_ARGUMENT',
            `Unknown --target "${options.target}". Valid targets: ${TARGETS.join(', ')}.`,
          );
        }

        const workspace = runtime.workspace();
        const folder = requireSpec(workspace, name);
        const analysis = analyzeSpec(workspace, folder);

        const steeringInfos = listSteeringFiles(workspace);
        const inlined: SteeringDocument[] = [];
        const conditional: { name: string; inclusion: string; fileMatchPattern?: string }[] = [];
        for (const info of steeringInfos) {
          if (info.diagnostics.some((d) => d.severity === 'error')) continue;
          const includeAlways = info.inclusion === 'always' || info.inclusion === 'unknown';
          if (includeAlways || options.allSteering === true) {
            inlined.push(loadSteeringDocument(workspace, info.name));
          } else {
            conditional.push({
              name: info.name,
              inclusion: info.inclusion,
              ...(info.fileMatchPattern !== undefined
                ? { fileMatchPattern: info.fileMatchPattern }
                : {}),
            });
          }
        }

        const input = {
          workspace,
          analysis,
          steering: inlined,
          conditionalSteering: conditional,
          generatorVersion: VERSION,
        };
        const contextOptions = { target: options.target as AgentContextTarget };

        const output =
          options.format === 'json'
            ? serializeJsonReport(buildAgentContextJson(input, contextOptions))
            : buildAgentContextMarkdown(input, contextOptions);

        if (options.out !== undefined) {
          const target = assertInsideWorkspace(
            workspace.rootDir,
            path.resolve(runtime.cwd, options.out),
          );
          const relative = path.relative(workspace.kiroDir, target);
          if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
            throw new SpecBridgeError(
              'INVALID_ARGUMENT',
              `Refusing to write generated context into .kiro (${target}). ` +
                'Generated artifacts belong outside the Kiro source of truth, e.g. under .specbridge/reports/.',
            );
          }
          writeFileAtomic(target, output);
          runtime.err(`Context written to ${target}`);
        }

        runtime.outRaw(output);
      },
    );
}
