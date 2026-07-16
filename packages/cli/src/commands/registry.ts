import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { CLI_BIN, EXIT_CODES, SpecBridgeError } from '@specbridge/core';
import { EXTENSION_KINDS } from '@specbridge/extension-sdk';
import {
  addRegistrySource,
  parseRegistryIndex,
  readRegistriesConfig,
  readRegistryCache,
  registryCachePath,
  removeRegistrySource,
  requireRegistrySource,
  resolveRegistryIndex,
  searchRegistryIndexes,
  updateRegistryIndex,
  type RegistryIndex,
} from '@specbridge/registry';
import { safeHttpRequest } from '@specbridge/runners';
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
 * `specbridge registry …` — extension registry indexes.
 *
 * A registry is a metadata index: it never contains executable content and
 * these commands never execute extension code. Everything is offline except
 * `registry update <name> --network`, which fetches, validates, and caches
 * one HTTPS index — and installs nothing.
 */
function jsonOut(runtime: CliRuntime, schema: string, data: Record<string, unknown>): void {
  runtime.outRaw(serializeJsonReport(createJsonReport(schema, `${CLI_BIN} ${VERSION}`, data)));
}

function readableIndexes(
  runtime: CliRuntime,
  registryFilter?: string,
): Array<{ registryName: string; index: RegistryIndex }> {
  const workspace = runtime.workspace();
  const { config } = readRegistriesConfig(workspace);
  const indexes: Array<{ registryName: string; index: RegistryIndex }> = [];
  for (const source of config.registries) {
    if (source.enabled !== true) {
      continue;
    }
    if (registryFilter !== undefined && source.name !== registryFilter) {
      continue;
    }
    try {
      const resolved = resolveRegistryIndex(workspace, source);
      if (resolved !== undefined) {
        indexes.push({ registryName: resolved.sourceName, index: resolved.index });
      }
    } catch {
      // Skipped for search; `registry validate <name>` reports the problem.
    }
  }
  return indexes;
}

export function registerRegistryCommands(program: Command, runtime: CliRuntime): void {
  const registry = program
    .command('registry')
    .description('Manage extension registry indexes (metadata only; explicit --network for updates)');

  registry
    .command('list')
    .description('List configured registries with cache status')
    .option('--json', 'output a machine-readable JSON report')
    .action((options: { json?: boolean }) => {
      const workspace = runtime.workspace();
      const { config, diagnostics } = readRegistriesConfig(workspace);
      const rows = config.registries.map((source) => {
        let cacheStatus = 'not-applicable';
        let lastUpdate: string | null = null;
        let extensionCount: number | null = null;
        if (source.type === 'https') {
          const cache = readRegistryCache(workspace, source.name);
          cacheStatus = cache.cache !== undefined ? 'cached' : 'no-cache';
          lastUpdate = cache.cache?.retrievedAt ?? null;
          extensionCount = cache.cache?.index.extensions.length ?? null;
        } else {
          try {
            const resolved = resolveRegistryIndex(workspace, source);
            cacheStatus = 'readable';
            extensionCount = resolved?.index.extensions.length ?? null;
          } catch {
            cacheStatus = 'invalid';
          }
        }
        return {
          name: source.name,
          type: source.type,
          enabled: source.enabled,
          source: source.type === 'https' ? source.url : source.type === 'local-file' ? source.file : 'embedded',
          cacheStatus,
          lastUpdate,
          extensionCount,
        };
      });
      if (options.json === true) {
        jsonOut(runtime, 'specbridge.registry-list/1', { registries: rows, diagnostics });
        return;
      }
      runtime.out(reportTitle(`Registries (${rows.length})`));
      for (const diagnostic of diagnostics) {
        runtime.out(warnLine(diagnostic.message));
      }
      runtime.out();
      for (const row of rows) {
        runtime.out(
          okLine(
            `${row.name}`,
            `(${row.type}, ${row.enabled ? 'enabled' : 'disabled'}, ${row.cacheStatus}` +
              `${row.extensionCount !== null ? `, ${row.extensionCount} extensions` : ''})`,
          ),
        );
        runtime.out(dim(`     ${row.source}${row.lastUpdate !== null ? ` | updated ${row.lastUpdate}` : ''}`));
      }
    });

  registry
    .command('add <name>')
    .description('Add a local-file or https registry (no fetch happens here)')
    .option('--file <path>', 'workspace-relative path to a registry index JSON file')
    .option('--url <https-url>', 'HTTPS URL of a registry index')
    .option('--dry-run', 'validate the configuration without saving')
    .option('--json', 'output a machine-readable JSON report')
    .action((name: string, options: { file?: string; url?: string; dryRun?: boolean; json?: boolean }) => {
      if ((options.file === undefined) === (options.url === undefined)) {
        throw new SpecBridgeError('INVALID_ARGUMENT', 'Pass exactly one of --file <path> or --url <https-url>.');
      }
      const workspace = runtime.workspace();
      const source =
        options.file !== undefined
          ? ({ name, type: 'local-file', file: options.file, enabled: true } as const)
          : ({ name, type: 'https', url: options.url ?? '', enabled: true } as const);
      if (options.dryRun === true) {
        if (options.json === true) {
          jsonOut(runtime, 'specbridge.registry-add/1', { dryRun: true, source });
          return;
        }
        runtime.out(dim(`Dry run: would add registry "${name}".`));
        return;
      }
      addRegistrySource(workspace, source);
      if (options.json === true) {
        jsonOut(runtime, 'specbridge.registry-add/1', { dryRun: false, source });
        return;
      }
      runtime.out(okLine(`registry "${name}" added`));
      if (source.type === 'https') {
        runtime.out(dim(`  fetch its index explicitly with: ${CLI_BIN} registry update ${name} --network`));
      }
    });

  registry
    .command('remove <name>')
    .description('Remove a registry configuration (and its cache) after explicit confirmation')
    .option('--yes', 'confirm the removal')
    .option('--json', 'output a machine-readable JSON report')
    .action((name: string, options: { yes?: boolean; json?: boolean }) => {
      if (options.yes !== true) {
        throw new SpecBridgeError('INVALID_ARGUMENT', `Re-run with --yes to remove registry "${name}".`);
      }
      const workspace = runtime.workspace();
      removeRegistrySource(workspace, name);
      const cachePath = registryCachePath(workspace, name);
      if (existsSync(cachePath)) {
        rmSync(cachePath, { force: true });
      }
      if (options.json === true) {
        jsonOut(runtime, 'specbridge.registry-remove/1', { name, removed: true });
        return;
      }
      runtime.out(okLine(`registry "${name}" removed (installed extensions are untouched)`));
    });

  registry
    .command('update [name]')
    .description('Fetch, validate, and cache an https registry index (requires --network; installs nothing)')
    .option('--network', 'allow this one explicit fetch')
    .option('--json', 'output a machine-readable JSON report')
    .action(async (name: string | undefined, options: { network?: boolean; json?: boolean }) => {
      const workspace = runtime.workspace();
      const { config } = readRegistriesConfig(workspace);
      const targets =
        name !== undefined
          ? [requireRegistrySource(config, name)]
          : config.registries.filter((source) => source.type === 'https' && source.enabled);
      if (targets.length === 0) {
        runtime.out(dim('No https registries to update.'));
        return;
      }
      const results: Array<Record<string, unknown>> = [];
      let failed = false;
      for (const source of targets) {
        try {
          const result = await updateRegistryIndex(workspace, source, {
            network: options.network === true,
            http: safeHttpRequest,
            clock: () => runtime.now(),
          });
          results.push({
            name: source.name,
            ok: true,
            extensionCount: result.extensionCount,
            retrievedAt: result.cache.retrievedAt,
          });
        } catch (error) {
          failed = true;
          results.push({
            name: source.name,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (options.json === true) {
        jsonOut(runtime, 'specbridge.registry-update/1', { results, ok: !failed });
        runtime.exitCode = failed ? EXIT_CODES.gateFailure : 0;
        return;
      }
      for (const result of results) {
        if (result['ok'] === true) {
          runtime.out(okLine(`${String(result['name'])}: cached ${String(result['extensionCount'])} extensions`));
        } else {
          runtime.out(failLine(`${String(result['name'])}: ${String(result['error'])}`));
        }
      }
      runtime.out(dim('Registry updates never install or execute anything.'));
      runtime.exitCode = failed ? EXIT_CODES.gateFailure : 0;
    });

  registry
    .command('search <query>')
    .description('Search validated registry indexes offline (deterministic lexical ranking)')
    .option('--registry <name>', 'search one registry only')
    .option('--kind <kind>', `filter by kind: ${EXTENSION_KINDS.join(' | ')}`)
    .option('--limit <n>', 'maximum results', '20')
    .option('--json', 'output a machine-readable JSON report')
    .action((query: string, options: { registry?: string; kind?: string; limit: string; json?: boolean }) => {
      if (options.kind !== undefined && !EXTENSION_KINDS.includes(options.kind as (typeof EXTENSION_KINDS)[number])) {
        throw new SpecBridgeError('INVALID_ARGUMENT', `Unknown --kind "${options.kind}".`);
      }
      const limit = Number.parseInt(options.limit, 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new SpecBridgeError('INVALID_ARGUMENT', '--limit must be an integer between 1 and 50.');
      }
      const hits = searchRegistryIndexes(readableIndexes(runtime, options.registry), query, {
        ...(options.kind === undefined ? {} : { kind: options.kind }),
        limit,
      });
      if (options.json === true) {
        jsonOut(runtime, 'specbridge.registry-search/1', {
          query,
          results: hits.map((hit) => ({
            registryName: hit.registryName,
            id: hit.entry.id,
            kind: hit.entry.kind,
            displayName: hit.entry.displayName,
            description: hit.entry.description,
            latestVersion: hit.entry.latestVersion,
            license: hit.entry.license,
            score: hit.score,
          })),
        });
        return;
      }
      runtime.out(reportTitle(`Registry search: ${query} (${hits.length})`));
      runtime.out();
      for (const hit of hits) {
        runtime.out(okLine(`${hit.entry.id}@${hit.entry.latestVersion}`, `(${hit.entry.kind}, from ${hit.registryName})`));
        runtime.out(dim(`     ${hit.entry.description}`));
      }
      if (hits.length === 0) {
        runtime.out(dim('  no matches in readable indexes (search never touches the network)'));
      }
    });

  registry
    .command('show <extension>')
    .description('Show registry metadata for an extension (no download happens)')
    .option('--json', 'output a machine-readable JSON report')
    .action((id: string, options: { json?: boolean }) => {
      const indexes = readableIndexes(runtime);
      const matches = indexes.flatMap(({ registryName, index }) =>
        index.extensions.filter((entry) => entry.id === id).map((entry) => ({ registryName, entry })),
      );
      if (matches.length === 0) {
        throw new SpecBridgeError(
          'INVALID_ARGUMENT',
          `SBR011: extension "${id}" was not found in any readable registry index.`,
        );
      }
      if (options.json === true) {
        jsonOut(runtime, 'specbridge.registry-show/1', { id, matches });
        return;
      }
      for (const match of matches) {
        const entry = match.entry;
        runtime.out(reportTitle(`${entry.displayName} (${entry.id}) — from ${match.registryName}`));
        runtime.out(dim(`  ${entry.description}`));
        runtime.out(`  kind: ${entry.kind} | latest: ${entry.latestVersion} | license: ${entry.license}`);
        runtime.out();
        runtime.out(sectionTitle('versions'));
        for (const version of entry.versions) {
          runtime.out(okLine(`${version.version}`, `(sha256 ${version.sha256.slice(0, 16)}…)`));
          runtime.out(dim(`     ${version.archiveUrl}`));
          runtime.out(dim(`     specbridge ${version.manifest.compatibility.specbridge}`));
        }
        runtime.out();
        runtime.out(dim('  Registry listing is not endorsement; review permissions before enabling.'));
      }
    });

  registry
    .command('validate <path-or-name>')
    .description('Validate a registry index file or a configured registry')
    .option('--json', 'output a machine-readable JSON report')
    .action((target: string, options: { json?: boolean }) => {
      const workspace = runtime.workspace();
      let problems: readonly string[] = [];
      let extensionCount = 0;
      let label = target;
      const resolved = path.resolve(runtime.cwd, target);
      if (existsSync(resolved) && lstatSync(resolved).isFile()) {
        const parsed = parseRegistryIndex(readFileSync(resolved, 'utf8'));
        problems = parsed.problems;
        extensionCount = parsed.index?.extensions.length ?? 0;
        label = `file ${target}`;
      } else {
        const { config } = readRegistriesConfig(workspace);
        const source = requireRegistrySource(config, target);
        try {
          const index = resolveRegistryIndex(workspace, source);
          if (index === undefined) {
            problems = ['registry has no validated cache yet; run `registry update --network`'];
          } else {
            extensionCount = index.index.extensions.length;
            problems = index.diagnostics.map((diagnostic) => diagnostic.message);
          }
        } catch (error) {
          problems = [error instanceof Error ? error.message : String(error)];
        }
        label = `registry ${target}`;
      }
      const valid = problems.length === 0;
      if (options.json === true) {
        jsonOut(runtime, 'specbridge.registry-validate/1', { target, valid, extensionCount, problems });
        runtime.exitCode = valid ? 0 : EXIT_CODES.gateFailure;
        return;
      }
      runtime.out(reportTitle(`Validate ${label}`));
      runtime.out();
      for (const problem of problems) {
        runtime.out(failLine(problem));
      }
      runtime.out(valid ? okLine(`valid (${extensionCount} extensions)`) : failLine('invalid'));
      runtime.exitCode = valid ? 0 : EXIT_CODES.gateFailure;
    });
}
