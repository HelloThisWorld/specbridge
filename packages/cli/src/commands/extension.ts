import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { CLI_BIN, EXIT_CODES, SpecBridgeError } from '@specbridge/core';
import type { ExtensionKind, ExtensionValidationIssue } from '@specbridge/extension-sdk';
import { EXTENSION_KINDS } from '@specbridge/extension-sdk';
import type { EnabledExtension } from '@specbridge/extensions';
import {
  buildExtensionArchive,
  describeEnablement,
  disableExtension,
  enableExtension,
  extractZipArchive,
  installExtensionFromArchiveBytes,
  installExtensionFromDirectory,
  installedVersionDir,
  installedVersions,
  listInstalledExtensions,
  loadExtensionPackage,
  probeExtensionHandshake,
  readExtensionPackageDirectory,
  readExtensionState,
  readPermissionGrants,
  requireEnabledExtension,
  runExtensionConformance,
  scaffoldExtension,
  searchInstalledExtensions,
  uninstallExtension,
  writeExtensionState,
  EXTENSION_LIMITS,
} from '@specbridge/extensions';
import type { RegistryIndex } from '@specbridge/registry';
import {
  downloadRegistryArchive,
  readRegistriesConfig,
  requireRegistrySource,
  resolveRegistryExtension,
  resolveRegistryIndex,
  searchRegistryIndexes,
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
 * `specbridge extension …` — the SpecBridge extension ecosystem CLI.
 *
 * Every command here follows the extension security model: installation
 * never executes code, extensions start disabled, enabling requires the
 * exact permission hash, executable conformance requires explicit
 * confirmation, and registry installation requires an explicit --network.
 */
function requireKind(value: string | undefined): ExtensionKind | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!EXTENSION_KINDS.includes(value as ExtensionKind)) {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      `Unknown --kind "${value}". Valid kinds: ${EXTENSION_KINDS.join(', ')}.`,
    );
  }
  return value as ExtensionKind;
}

function printIssues(runtime: CliRuntime, issues: readonly ExtensionValidationIssue[]): void {
  for (const issue of issues) {
    const location = issue.file !== undefined ? ` [${issue.file}]` : '';
    const line = `${issue.code} (${issue.category})${location}: ${issue.message}`;
    runtime.out(issue.severity === 'error' ? failLine(line) : warnLine(line));
  }
}

function jsonOut(runtime: CliRuntime, schema: string, data: Record<string, unknown>): void {
  runtime.outRaw(serializeJsonReport(createJsonReport(schema, `${CLI_BIN} ${VERSION}`, data)));
}

/** Readable registry indexes for the workspace (never touches the network). */
function readableIndexes(
  runtime: CliRuntime,
  registryFilter?: string,
): Array<{ registryName: string; index: RegistryIndex }> {
  const workspace = runtime.tryWorkspace();
  if (workspace === undefined) {
    return [];
  }
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
      // Unreadable sources are skipped for search; `registry validate` reports them.
    }
  }
  return indexes;
}

function resolveConformanceTarget(runtime: CliRuntime, target: string): EnabledExtension {
  const resolved = path.resolve(runtime.cwd, target);
  if (existsSync(resolved) && lstatSync(resolved).isDirectory()) {
    const files = readExtensionPackageDirectory(resolved);
    const validation = loadExtensionPackage(files, { checksums: 'verify-if-present' });
    const errors = validation.issues.filter((issue) => issue.severity === 'error');
    if (validation.manifest === undefined || validation.manifestSha256 === undefined || validation.permissionHash === undefined || errors.length > 0) {
      throw new SpecBridgeError(
        'INVALID_ARGUMENT',
        `"${target}" failed validation; run \`${CLI_BIN} extension validate ${target}\` first.`,
      );
    }
    return {
      record: {
        id: validation.manifest.id,
        version: validation.manifest.version,
        kind: validation.manifest.kind,
        displayName: validation.manifest.displayName,
        description: validation.manifest.description,
        source: `local-directory:${target}`,
        installedAt: 'not-installed',
        manifestSha256: validation.manifestSha256,
        permissionHash: validation.permissionHash,
        ...(validation.manifest.entrypoint === undefined
          ? {}
          : { entrypoint: validation.manifest.entrypoint }),
        installRecordId: 'not-installed',
      },
      manifest: validation.manifest,
      installedDir: resolved,
      permissionHash: validation.permissionHash,
      manifestSha256: validation.manifestSha256,
    };
  }
  const workspace = runtime.workspace();
  return requireEnabledExtension(workspace, target);
}

export function registerExtensionCommands(program: Command, runtime: CliRuntime): void {
  const extension = program
    .command('extension')
    .description('Install, inspect, and develop SpecBridge extensions (analyzers, verifiers, exporters, runners, template providers)');

  extension
    .command('list')
    .description('List installed extensions with enablement, permissions, and conformance status')
    .option('--kind <kind>', `filter by kind: ${EXTENSION_KINDS.join(' | ')}`)
    .option('--enabled', 'only enabled extensions')
    .option('--installed', 'accepted for symmetry; listing always shows installed extensions')
    .option('--json', 'output a machine-readable JSON report')
    .action((options: { kind?: string; enabled?: boolean; json?: boolean }) => {
      const kind = requireKind(options.kind);
      const workspace = runtime.workspace();
      const catalog = listInstalledExtensions(workspace);
      let entries = [...catalog.entries];
      if (kind !== undefined) {
        entries = entries.filter((entry) => entry.kind === kind);
      }
      if (options.enabled === true) {
        entries = entries.filter((entry) => entry.enabled);
      }
      if (options.json === true) {
        jsonOut(runtime, 'specbridge.extension-list/1', {
          extensions: entries,
          diagnostics: catalog.diagnostics,
        });
        return;
      }
      runtime.out(reportTitle(`Installed extensions (${entries.length})`));
      for (const diagnostic of catalog.diagnostics) {
        runtime.out(warnLine(diagnostic.message));
      }
      runtime.out();
      if (entries.length === 0) {
        runtime.out(dim('  none — install one with `specbridge extension install <source>`'));
      }
      for (const entry of entries) {
        const state = entry.enabled ? 'enabled' : 'disabled';
        runtime.out(
          okLine(
            `${entry.id}@${entry.version}`,
            `(${entry.kind}, ${state}, ${entry.compatibility}, conformance: ${entry.conformance})`,
          ),
        );
        runtime.out(dim(`     ${entry.description}`));
        runtime.out(dim(`     source: ${entry.source} | permissions accepted: ${entry.permissionsAccepted ? 'yes' : 'no'}`));
      }
    });

  extension
    .command('search <query>')
    .description('Search installed extensions and cached registry indexes (offline, lexical ranking)')
    .option('--registry <name>', 'search one registry only')
    .option('--kind <kind>', `filter by kind: ${EXTENSION_KINDS.join(' | ')}`)
    .option('--limit <n>', 'maximum results', '20')
    .option('--json', 'output a machine-readable JSON report')
    .action((query: string, options: { registry?: string; kind?: string; limit: string; json?: boolean }) => {
      const kind = requireKind(options.kind);
      const limit = Number.parseInt(options.limit, 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new SpecBridgeError('INVALID_ARGUMENT', '--limit must be an integer between 1 and 50.');
      }
      const workspace = runtime.workspace();
      const installedHits =
        options.registry === undefined
          ? searchInstalledExtensions(listInstalledExtensions(workspace), query, {
              ...(kind === undefined ? {} : { kind }),
              limit,
            })
          : [];
      const registryHits = searchRegistryIndexes(readableIndexes(runtime, options.registry), query, {
        ...(kind === undefined ? {} : { kind }),
        limit,
      });
      if (options.json === true) {
        jsonOut(runtime, 'specbridge.extension-search/1', {
          query,
          installed: installedHits,
          registry: registryHits.map((hit) => ({
            registryName: hit.registryName,
            id: hit.entry.id,
            kind: hit.entry.kind,
            displayName: hit.entry.displayName,
            description: hit.entry.description,
            latestVersion: hit.entry.latestVersion,
            score: hit.score,
          })),
        });
        return;
      }
      runtime.out(reportTitle(`Search: ${query}`));
      runtime.out();
      runtime.out(sectionTitle(`installed (${installedHits.length})`));
      for (const hit of installedHits) {
        runtime.out(okLine(`${hit.id}@${hit.version}`, `(${hit.kind}, ${hit.enabled ? 'enabled' : 'disabled'})`));
      }
      runtime.out();
      runtime.out(sectionTitle(`registries (${registryHits.length})`));
      for (const hit of registryHits) {
        runtime.out(okLine(`${hit.entry.id}@${hit.entry.latestVersion}`, `(${hit.entry.kind}, from ${hit.registryName})`));
        runtime.out(dim(`     ${hit.entry.description}`));
      }
      if (registryHits.length === 0) {
        runtime.out(dim('  no cached registry matches — update caches with `specbridge registry update <name> --network`'));
      }
    });

  extension
    .command('show <extension>')
    .description('Show manifest, permissions, permission hash, enablement, and registry metadata')
    .option('--json', 'output a machine-readable JSON report')
    .action((id: string, options: { json?: boolean }) => {
      const workspace = runtime.workspace();
      const { state } = readExtensionState(workspace);
      const versions = installedVersions(state, id);
      const { grants } = readPermissionGrants(workspace);
      const grant = grants.grants[id];
      const registryMatches = readableIndexes(runtime)
        .flatMap(({ registryName, index }) =>
          index.extensions
            .filter((entry) => entry.id === id)
            .map((entry) => ({ registryName, latestVersion: entry.latestVersion, kind: entry.kind, license: entry.license })),
        );

      if (versions.length === 0 && registryMatches.length === 0) {
        throw new SpecBridgeError(
          'INVALID_ARGUMENT',
          `SBE001: extension "${id}" is neither installed nor present in any readable registry index. ` +
            'Run `specbridge extension search <query>` to discover extensions.',
        );
      }

      const preview = versions.length > 0 ? describeEnablement(workspace, id) : undefined;
      if (options.json === true) {
        jsonOut(runtime, 'specbridge.extension-show/1', {
          id,
          installedVersions: versions,
          enabled: state.enabled[id] ?? null,
          grant: grant ?? null,
          manifest: preview?.manifest ?? null,
          permissionHash: preview?.permissionHash ?? null,
          permissionLines: preview?.permissionLines ?? [],
          grantStatus: preview?.grantStatus ?? 'none',
          registry: registryMatches,
        });
        return;
      }
      runtime.out(reportTitle(`Extension: ${id}`));
      runtime.out();
      if (preview !== undefined) {
        const manifest = preview.manifest;
        runtime.out(`  ${manifest.displayName} v${preview.record.version} — ${manifest.kind}`);
        runtime.out(dim(`  ${manifest.description}`));
        runtime.out(`  installed versions: ${versions.map((record) => record.version).join(', ')}`);
        runtime.out(`  enabled: ${preview.enabled ? `yes (${preview.record.version})` : 'no'}`);
        runtime.out(`  grant: ${preview.grantStatus}`);
        runtime.out();
        runtime.out(sectionTitle('permissions'));
        for (const line of preview.permissionLines) {
          runtime.out(`  ${line}`);
        }
        runtime.out();
        runtime.out(`  permission hash: ${preview.permissionHash}`);
        runtime.out(
          dim(`  enable with: ${CLI_BIN} extension enable ${id} --accept-permissions ${preview.permissionHash}`),
        );
      } else {
        runtime.out(dim('  not installed locally'));
      }
      if (registryMatches.length > 0) {
        runtime.out();
        runtime.out(sectionTitle('registry metadata'));
        for (const match of registryMatches) {
          runtime.out(
            okLine(`${match.registryName}: latest ${match.latestVersion} (${match.kind}, ${match.license})`),
          );
        }
        runtime.out(dim('  registry listing is not endorsement; review permissions before enabling.'));
      }
    });

  extension
    .command('validate <path-or-extension>')
    .description('Validate a package directory, archive, or installed extension (never executes code)')
    .option('--json', 'output a machine-readable JSON report')
    .action((target: string, options: { json?: boolean }) => {
      const resolved = path.resolve(runtime.cwd, target);
      let issues: readonly ExtensionValidationIssue[];
      let manifestId: string | null = null;
      let where: string;
      if (existsSync(resolved) && lstatSync(resolved).isDirectory()) {
        const validation = loadExtensionPackage(readExtensionPackageDirectory(resolved), {
          checksums: 'verify-if-present',
        });
        issues = validation.issues;
        manifestId = validation.manifest?.id ?? null;
        where = `directory ${target}`;
      } else if (existsSync(resolved) && resolved.endsWith('.zip')) {
        const bytes = readFileSync(resolved);
        const validation = loadExtensionPackage(extractZipArchive(bytes));
        issues = validation.issues;
        manifestId = validation.manifest?.id ?? null;
        where = `archive ${target}`;
      } else {
        const workspace = runtime.workspace();
        const { state } = readExtensionState(workspace);
        const record = installedVersions(state, target)[0];
        if (record === undefined) {
          throw new SpecBridgeError(
            'INVALID_ARGUMENT',
            `"${target}" is neither a directory, a .zip archive, nor an installed extension ID.`,
          );
        }
        const dir = installedVersionDir(workspace, record.id, record.version);
        const validation = loadExtensionPackage(readExtensionPackageDirectory(dir));
        issues = validation.issues;
        manifestId = record.id;
        where = `installed extension ${record.id}@${record.version}`;
      }
      const errors = issues.filter((issue) => issue.severity === 'error');
      if (options.json === true) {
        jsonOut(runtime, 'specbridge.extension-validate/1', {
          target,
          extensionId: manifestId,
          valid: errors.length === 0,
          issues,
        });
        runtime.exitCode = errors.length === 0 ? 0 : EXIT_CODES.gateFailure;
        return;
      }
      runtime.out(reportTitle(`Validate: ${where}`));
      runtime.out();
      if (issues.length === 0) {
        runtime.out(okLine('no findings'));
      } else {
        printIssues(runtime, issues);
      }
      runtime.out();
      runtime.out(errors.length === 0 ? okLine('valid') : failLine(`${errors.length} error(s)`));
      runtime.exitCode = errors.length === 0 ? 0 : EXIT_CODES.gateFailure;
    });

  extension
    .command('install <source>')
    .description('Install an extension from a directory, archive, or registry (installs disabled; runs no code)')
    .option('--registry <name>', 'install from this configured registry')
    .option('--network', 'allow the explicit network download a registry install needs')
    .option('--dry-run', 'validate and report without installing')
    .option('--json', 'output a machine-readable JSON report')
    .action(async (source: string, options: { registry?: string; network?: boolean; dryRun?: boolean; json?: boolean }) => {
      const workspace = runtime.workspace();
      let result;
      if (options.registry !== undefined) {
        const { config } = readRegistriesConfig(workspace);
        const registrySource = requireRegistrySource(config, options.registry);
        const resolvedIndex = resolveRegistryIndex(workspace, registrySource);
        if (resolvedIndex === undefined) {
          throw new SpecBridgeError(
            'INVALID_ARGUMENT',
            `SBR010: registry "${options.registry}" has no validated cache yet. ` +
              `Run \`${CLI_BIN} registry update ${options.registry} --network\` first.`,
          );
        }
        const resolved = resolveRegistryExtension(
          [{ registryName: resolvedIndex.sourceName, index: resolvedIndex.index }],
          source,
        );
        const archive = await downloadRegistryArchive(resolved.version.archiveUrl, {
          network: options.network === true,
          http: safeHttpRequest,
          maxArchiveBytes: EXTENSION_LIMITS.maxArchiveBytes,
        });
        result = installExtensionFromArchiveBytes(archive, {
          workspace,
          sourceLabel: `registry:${options.registry}`,
          expectedArchiveSha256: resolved.version.sha256,
          ...(options.dryRun === true ? { dryRun: true } : {}),
          clock: () => runtime.now(),
        });
      } else {
        const resolved = path.resolve(runtime.cwd, source);
        if (!existsSync(resolved)) {
          throw new SpecBridgeError(
            'INVALID_ARGUMENT',
            `"${source}" does not exist. Pass a package directory, a .zip archive, or use --registry.`,
          );
        }
        const installOptions = {
          workspace,
          sourceLabel: lstatSync(resolved).isDirectory()
            ? `local-directory:${source}`
            : `local-archive:${source}`,
          ...(options.dryRun === true ? { dryRun: true } : {}),
          clock: () => runtime.now(),
        };
        result = lstatSync(resolved).isDirectory()
          ? installExtensionFromDirectory(resolved, installOptions)
          : installExtensionFromArchiveBytes(readFileSync(resolved), installOptions);
      }

      if (options.json === true) {
        jsonOut(runtime, 'specbridge.extension-install/1', { ...result });
        return;
      }
      runtime.out(reportTitle(`Install: ${result.id}@${result.version} (${result.kind})`));
      runtime.out();
      for (const warning of result.warnings) {
        runtime.out(warnLine(`${warning.code}: ${warning.message}`));
      }
      if (result.dryRun) {
        runtime.out(dim('Dry run: nothing was installed.'));
        return;
      }
      runtime.out(okLine('installed (disabled; no code was executed)'));
      runtime.out(`  permission hash: ${result.permissionHash}`);
      runtime.out(
        dim(`  enable with: ${CLI_BIN} extension enable ${result.id} --accept-permissions ${result.permissionHash}`),
      );
    });

  extension
    .command('enable <extension>')
    .description('Enable an installed extension after explicit permission acceptance')
    .option('--accept-permissions <hash>', 'the exact permission hash shown by `extension show`')
    .option('--version <version>', 'enable a specific installed version')
    .option('--json', 'output a machine-readable JSON report')
    .action(async (id: string, options: { acceptPermissions?: string; version?: string; json?: boolean }) => {
      const workspace = runtime.workspace();
      if (options.acceptPermissions === undefined) {
        const preview = describeEnablement(workspace, id, options.version);
        runtime.out(reportTitle(`Enable ${id}@${preview.record.version} requires permission acceptance`));
        runtime.out();
        for (const line of preview.permissionLines) {
          runtime.out(`  ${line}`);
        }
        runtime.out();
        runtime.out(
          failLine(
            `SBE016: re-run with --accept-permissions ${preview.permissionHash} to accept exactly these permissions.`,
          ),
        );
        runtime.exitCode = EXIT_CODES.gateFailure;
        return;
      }
      const result = await enableExtension({
        workspace,
        id,
        acceptPermissions: options.acceptPermissions,
        ...(options.version === undefined ? {} : { version: options.version }),
        clock: () => runtime.now(),
        probe: async (preview, dir) => {
          if (preview.manifest.entrypoint === undefined) {
            return;
          }
          const probe = await probeExtensionHandshake({
            record: preview.record,
            manifest: preview.manifest,
            installedDir: dir,
            permissionHash: preview.permissionHash,
            manifestSha256: preview.manifestSha256,
          });
          if (!probe.ok) {
            throw new SpecBridgeError(
              'INVALID_STATE',
              `SBE019: the extension failed its initialization probe: ${probe.detail}. It was not enabled.`,
            );
          }
        },
      });
      if (options.json === true) {
        jsonOut(runtime, 'specbridge.extension-enable/1', {
          id: result.id,
          version: result.version,
          permissionHash: result.permissionHash,
        });
        return;
      }
      runtime.out(okLine(`${result.id}@${result.version} enabled`));
      runtime.out(dim(`  grant stored for permission hash ${result.permissionHash}`));
    });

  extension
    .command('disable <extension>')
    .description('Disable an enabled extension (keeps it installed; preserves all records)')
    .option('--json', 'output a machine-readable JSON report')
    .action((id: string, options: { json?: boolean }) => {
      const workspace = runtime.workspace();
      const result = disableExtension({ workspace, id, clock: () => runtime.now() });
      if (options.json === true) {
        jsonOut(runtime, 'specbridge.extension-disable/1', { ...result });
        return;
      }
      runtime.out(okLine(`${result.id}@${result.version} disabled`));
    });

  extension
    .command('uninstall <extension>')
    .description('Uninstall a disabled extension version (recoverable; records remain)')
    .option('--version <version>', 'the installed version to remove')
    .option('--dry-run', 'report what would be removed')
    .option('--json', 'output a machine-readable JSON report')
    .action((id: string, options: { version?: string; dryRun?: boolean; json?: boolean }) => {
      const workspace = runtime.workspace();
      const result = uninstallExtension({
        workspace,
        id,
        ...(options.version === undefined ? {} : { version: options.version }),
        ...(options.dryRun === true ? { dryRun: true } : {}),
        clock: () => runtime.now(),
      });
      if (options.json === true) {
        jsonOut(runtime, 'specbridge.extension-uninstall/1', { ...result });
        return;
      }
      if (result.dryRun) {
        runtime.out(dim(`Dry run: would remove ${result.id}@${result.version}.`));
        return;
      }
      runtime.out(okLine(`${result.id}@${result.version} uninstalled`));
      if (result.trashPath !== undefined) {
        runtime.out(dim(`  recoverable copy: ${result.trashPath}`));
      }
    });

  extension
    .command('doctor [extension]')
    .description('Read-only health checks: integrity, grants, compatibility, and a no-op handshake')
    .option('--json', 'output a machine-readable JSON report')
    .action(async (id: string | undefined, options: { json?: boolean }) => {
      const workspace = runtime.workspace();
      const catalog = listInstalledExtensions(workspace);
      const targets = id === undefined ? catalog.entries.map((entry) => entry.id) : [id];
      const results: Array<Record<string, unknown>> = [];
      let failed = false;
      for (const target of [...new Set(targets)]) {
        try {
          const preview = describeEnablement(workspace, target);
          let handshake: { ok: boolean; detail: string } = {
            ok: true,
            detail: preview.manifest.entrypoint === undefined ? 'data-only extension' : 'not enabled; handshake skipped',
          };
          if (preview.enabled && preview.manifest.entrypoint !== undefined) {
            const enabled = requireEnabledExtension(workspace, target);
            handshake = await probeExtensionHandshake(enabled);
          }
          const ok = handshake.ok && preview.grantStatus !== 'stale';
          failed = failed || !ok;
          results.push({
            id: target,
            version: preview.record.version,
            integrity: 'valid',
            enabled: preview.enabled,
            grantStatus: preview.grantStatus,
            handshake,
            ok,
          });
        } catch (error) {
          failed = true;
          results.push({
            id: target,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (options.json === true) {
        jsonOut(runtime, 'specbridge.extension-doctor/1', { results, ok: !failed });
        runtime.exitCode = failed ? EXIT_CODES.gateFailure : 0;
        return;
      }
      runtime.out(reportTitle('Extension doctor'));
      runtime.out();
      for (const result of results) {
        if (result['ok'] === true) {
          runtime.out(okLine(`${String(result['id'])}@${String(result['version'])}`, `(grant: ${String(result['grantStatus'])})`));
          const handshake = result['handshake'] as { detail: string } | undefined;
          if (handshake !== undefined) {
            runtime.out(dim(`     handshake: ${handshake.detail}`));
          }
        } else {
          runtime.out(failLine(`${String(result['id'])}: ${String(result['error'] ?? 'unhealthy')}`));
        }
      }
      if (results.length === 0) {
        runtime.out(dim('  no installed extensions'));
      }
      runtime.exitCode = failed ? EXIT_CODES.gateFailure : 0;
    });

  extension
    .command('conformance <path-or-extension>')
    .description('Run kind-specific conformance checks (executes the extension; requires --yes)')
    .option('--yes', 'confirm executing the extension under test')
    .option('--network', 'allow extensions that declare the network permission to run')
    .option('--verbose', 'show every check')
    .option('--json', 'output a machine-readable JSON report')
    .action(async (target: string, options: { yes?: boolean; network?: boolean; verbose?: boolean; json?: boolean }) => {
      const resolvedPath = path.resolve(runtime.cwd, target);
      const isPathTarget = existsSync(resolvedPath) && lstatSync(resolvedPath).isDirectory();
      const enabled = resolveConformanceTarget(runtime, target);
      const executable = enabled.manifest.entrypoint !== undefined;
      if (executable && options.yes !== true) {
        throw new SpecBridgeError(
          'INVALID_ARGUMENT',
          'Conformance executes the extension in a child process; re-run with --yes to confirm.',
        );
      }
      if (enabled.manifest.permissions.network && options.network !== true) {
        throw new SpecBridgeError(
          'INVALID_ARGUMENT',
          'This extension declares the network permission; re-run with --network to allow that during conformance.',
        );
      }
      const result = await runExtensionConformance(enabled, {
        // Source directories under development get their checksums at
        // packaging time; installed packages must already carry them.
        checksums: isPathTarget ? 'verify-if-present' : 'require',
      });

      // Record conformance for installed extensions.
      const workspace = runtime.tryWorkspace();
      if (workspace !== undefined) {
        const { state } = readExtensionState(workspace);
        const record = state.installed.find(
          (candidate) => candidate.id === result.extensionId && candidate.version === result.version,
        );
        if (record !== undefined) {
          record.conformanceStatus = result.passed ? 'passed' : 'failed';
          record.conformanceAt = runtime.now().toISOString();
          writeExtensionState(workspace, state);
        }
      }

      if (options.json === true) {
        jsonOut(runtime, 'specbridge.extension-conformance/1', { ...result });
        runtime.exitCode = result.passed ? 0 : EXIT_CODES.gateFailure;
        return;
      }
      runtime.out(reportTitle(`Conformance: ${result.extensionId}@${result.version} (${result.kind})`));
      runtime.out();
      for (const check of result.checks) {
        if (check.status === 'passed' && options.verbose !== true) {
          continue;
        }
        const line = `${check.id}: ${check.title}${check.detail !== undefined ? ` — ${check.detail}` : ''}`;
        runtime.out(check.status === 'failed' ? failLine(line) : check.status === 'skipped' ? warnLine(line) : okLine(line));
      }
      runtime.out();
      runtime.out(result.passed ? okLine(`conformant (${result.checks.length} checks)`) : failLine('NOT conformant'));
      runtime.exitCode = result.passed ? 0 : EXIT_CODES.gateFailure;
    });

  extension
    .command('scaffold <id>')
    .description('Generate a complete, working extension project (never installs or publishes)')
    .option('--kind <kind>', `extension kind: ${EXTENSION_KINDS.join(' | ')}`)
    .option('--output <directory>', 'directory to create (must be empty)')
    .option('--display-name <name>', 'human-readable name')
    .option('--description <text>', 'one-line description')
    .option('--dry-run', 'list the files without writing them')
    .option('--json', 'output a machine-readable JSON report')
    .action((id: string, options: { kind?: string; output?: string; displayName?: string; description?: string; dryRun?: boolean; json?: boolean }) => {
      const kind = requireKind(options.kind);
      if (kind === undefined) {
        throw new SpecBridgeError('INVALID_ARGUMENT', `Pass --kind (${EXTENSION_KINDS.join(' | ')}).`);
      }
      const outputDir = path.resolve(runtime.cwd, options.output ?? `./${id}`);
      const result = scaffoldExtension({
        id,
        kind,
        outputDir,
        ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
        ...(options.description === undefined ? {} : { description: options.description }),
        ...(options.dryRun === true ? { dryRun: true } : {}),
      });
      if (options.json === true) {
        jsonOut(runtime, 'specbridge.extension-scaffold/1', { ...result });
        return;
      }
      runtime.out(reportTitle(`Scaffolded ${result.kind} extension: ${result.id}`));
      runtime.out();
      for (const file of result.files) {
        runtime.out(okLine(file));
      }
      runtime.out();
      if (result.dryRun) {
        runtime.out(dim('Dry run: nothing was written.'));
        return;
      }
      runtime.out(dim(`Next: ${CLI_BIN} extension validate ${options.output ?? `./${id}`}`));
    });

  extension
    .command('package <path>')
    .description('Build a deterministic .specbridge-extension.zip with checksums (no lifecycle scripts)')
    .option('--output <directory>', 'directory for the archive (default: <path>/dist)')
    .option('--dry-run', 'validate and compute the hash without writing the archive')
    .option('--json', 'output a machine-readable JSON report')
    .action((source: string, options: { output?: string; dryRun?: boolean; json?: boolean }) => {
      const result = buildExtensionArchive(path.resolve(runtime.cwd, source), {
        ...(options.output === undefined ? {} : { outputDir: path.resolve(runtime.cwd, options.output) }),
        ...(options.dryRun === true ? { dryRun: true } : {}),
      });
      if (options.json === true) {
        jsonOut(runtime, 'specbridge.extension-package/1', { ...result });
        return;
      }
      runtime.out(reportTitle(`Packaged ${result.id}@${result.version} (${result.kind})`));
      runtime.out();
      for (const warning of result.warnings) {
        runtime.out(warnLine(`${warning.code}: ${warning.message}`));
      }
      runtime.out(okLine(`${result.fileCount} files, ${result.archiveBytes} bytes`));
      if (!result.dryRun) {
        runtime.out(okLine(`archive: ${result.archivePath}`));
      }
      runtime.out(`  sha256: ${result.archiveSha256}`);
      runtime.out(dim('  Checksums prove integrity, not publisher identity.'));
    });
}
