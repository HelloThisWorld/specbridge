import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import type { ConcreteSpecType, ConcreteWorkflowMode } from '@specbridge/core';
import { CLI_BIN, EXIT_CODES, SpecBridgeError } from '@specbridge/core';
import type {
  TemplateApplicationPlan,
  TemplateCatalog,
  TemplateCatalogEntry,
  TemplateValidationIssue,
} from '@specbridge/templates';
import {
  MAX_SEARCH_LIMIT,
  checkPackRendering,
  executeTemplateApplication,
  executeTemplateInstall,
  executeTemplateScaffold,
  executeTemplateUninstall,
  loadTemplateCatalog,
  loadTemplatePack,
  parseTemplateReference,
  planTemplateApplication,
  planTemplateInstall,
  planTemplateScaffold,
  planTemplateUninstall,
  readTemplatePackDirectory,
  resolveTemplate,
  searchTemplates,
} from '@specbridge/templates';
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
import { relPath } from '../context.js';
import { VERSION } from '../version.js';

/**
 * `specbridge template …` — secure, deterministic, offline-first spec
 * templates. Every subcommand is local: no registry, no network, no model.
 */

const WORKFLOW_MODES: ConcreteWorkflowMode[] = ['requirements-first', 'design-first', 'quick'];
const SPEC_TYPES: ConcreteSpecType[] = ['feature', 'bugfix'];

interface VarOptions {
  var?: string[];
}

export function collectVar(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function parseVars(options: VarOptions): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const raw of options.var ?? []) {
    const eq = raw.indexOf('=');
    if (eq <= 0) {
      throw new SpecBridgeError(
        'INVALID_ARGUMENT',
        `Invalid --var "${raw}". Use --var key=value (e.g. --var tableName=payments).`,
      );
    }
    const key = raw.slice(0, eq);
    if (key in variables) {
      throw new SpecBridgeError('INVALID_ARGUMENT', `--var "${key}" was supplied more than once.`);
    }
    variables[key] = raw.slice(eq + 1);
  }
  return variables;
}

export interface SplitTemplateInputs {
  title: string | undefined;
  description: string | undefined;
  variables: Record<string, string>;
}

/**
 * `--var title=…` and `--var description=…` are accepted as friendly
 * aliases for the dedicated options (title and description ARE template
 * variables — just built-in ones). Supplying both spellings is an error.
 */
export function splitTemplateInputs(
  options: { title?: string; description?: string } & VarOptions,
): SplitTemplateInputs {
  const { title: varTitle, description: varDescription, ...variables } = parseVars(options);
  for (const [name, optionValue, varValue] of [
    ['title', options.title, varTitle],
    ['description', options.description, varDescription],
  ] as const) {
    if (optionValue !== undefined && varValue !== undefined) {
      throw new SpecBridgeError(
        'INVALID_ARGUMENT',
        `Both --${name} and --var ${name}=… were supplied. Use one of them.`,
      );
    }
  }
  return {
    title: options.title ?? varTitle,
    description: options.description ?? varDescription,
    variables,
  };
}

function requireMode(value: string | undefined): ConcreteWorkflowMode | undefined {
  if (value === undefined) return undefined;
  if (!WORKFLOW_MODES.includes(value as ConcreteWorkflowMode)) {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      `Unknown --mode "${value}". Valid modes: ${WORKFLOW_MODES.join(', ')}.`,
    );
  }
  return value as ConcreteWorkflowMode;
}

function catalogFor(runtime: CliRuntime, source?: string): TemplateCatalog {
  if (source !== undefined && !['builtin', 'project', 'all'].includes(source)) {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      `Unknown --source "${source}". Valid sources: builtin, project, all.`,
    );
  }
  return loadTemplateCatalog(runtime.tryWorkspace(), {
    source: (source ?? 'all') as 'builtin' | 'project' | 'all',
  });
}

function entryToJson(entry: TemplateCatalogEntry): Record<string, unknown> {
  const manifest = entry.pack.manifest;
  return {
    ref: entry.ref,
    id: entry.id,
    source: entry.source,
    valid: entry.valid,
    displayName: manifest?.displayName ?? null,
    version: manifest?.version ?? null,
    description: manifest?.description ?? null,
    kind: manifest?.kind ?? null,
    supportedModes: manifest?.supportedModes ?? [],
    defaultMode: manifest?.defaultMode ?? null,
    tags: manifest?.tags ?? [],
    compatibility: manifest?.compatibility ?? null,
    deprecated: manifest?.deprecated ?? false,
    errors: entry.pack.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => `${issue.code}: ${issue.message}`),
  };
}

interface ListFilters {
  kind?: string;
  mode?: string;
  tag?: string;
}

function applyFilters(entries: TemplateCatalogEntry[], filters: ListFilters): TemplateCatalogEntry[] {
  let result = entries;
  if (filters.kind !== undefined) {
    if (!SPEC_TYPES.includes(filters.kind as ConcreteSpecType)) {
      throw new SpecBridgeError(
        'INVALID_ARGUMENT',
        `Unknown --kind "${filters.kind}". Valid kinds: ${SPEC_TYPES.join(', ')}.`,
      );
    }
    result = result.filter((entry) => entry.pack.manifest?.kind === filters.kind);
  }
  if (filters.mode !== undefined) {
    const mode = requireMode(filters.mode);
    result = result.filter((entry) => entry.pack.manifest?.supportedModes.includes(mode as ConcreteWorkflowMode) === true);
  }
  if (filters.tag !== undefined) {
    result = result.filter((entry) => entry.pack.manifest?.tags.includes(filters.tag as string) === true);
  }
  return result;
}

function printEntryLine(runtime: CliRuntime, entry: TemplateCatalogEntry): void {
  const manifest = entry.pack.manifest;
  if (!entry.valid || manifest === undefined) {
    runtime.out(failLine(`${entry.ref}`, '(invalid — run "template validate" for details)'));
    return;
  }
  const deprecated = manifest.deprecated === true ? ' [deprecated]' : '';
  runtime.out(okLine(`${entry.ref} — ${manifest.displayName} v${manifest.version}${deprecated}`));
  runtime.out(
    dim(
      `     ${manifest.kind} | modes: ${manifest.supportedModes.join(', ')} | tags: ${manifest.tags.join(', ')}`,
    ),
  );
  runtime.out(dim(`     ${manifest.description}`));
}

function printIssues(runtime: CliRuntime, issues: TemplateValidationIssue[]): void {
  for (const issue of issues) {
    const location = issue.file !== undefined ? ` [${issue.file}]` : '';
    const line = `${issue.code} (${issue.category})${location}: ${issue.message}`;
    runtime.out(issue.severity === 'error' ? failLine(line) : warnLine(line));
  }
}

function printApplicationPlan(
  runtime: CliRuntime,
  plan: TemplateApplicationPlan,
  heading: string,
  showContent: boolean,
): void {
  const workspace = runtime.workspace();
  runtime.out(reportTitle(heading));
  runtime.out();
  runtime.out(`  Template:  ${plan.templateRef} v${plan.templateVersion}`);
  runtime.out(`  Spec name: ${plan.specPlan.specName}`);
  runtime.out(`  Kind:      ${plan.specPlan.specType}`);
  runtime.out(`  Mode:      ${plan.mode}`);
  runtime.out(`  Title:     ${plan.specPlan.title}`);
  runtime.out(`  Dir:       ${relPath(workspace, plan.specPlan.dir)}`);
  runtime.out(`  Candidate: ${plan.candidateHash}`);
  runtime.out();
  for (const diagnostic of plan.diagnostics) {
    runtime.out(warnLine(diagnostic.message));
  }
  runtime.out(sectionTitle('Target files'));
  for (const file of plan.specPlan.files) {
    runtime.out(
      okLine(
        `${relPath(workspace, plan.specPlan.dir)}/${file.fileName}`,
        `(${file.stage}, ${Buffer.byteLength(file.content, 'utf8')} B, unapproved)`,
      ),
    );
  }
  runtime.out(okLine(relPath(workspace, plan.specPlan.statePath), '(sidecar workflow state)'));
  if (showContent) {
    runtime.out();
    runtime.out(sectionTitle('Rendered content'));
    for (const file of plan.specPlan.files) {
      runtime.out(dim(`--- ${file.fileName} ---`));
      runtime.outRaw(file.content);
    }
    runtime.out(dim('--- sidecar state proposal ---'));
    runtime.outRaw(`${JSON.stringify(plan.specPlan.state, null, 2)}\n`);
  }
}

function applicationPlanJson(
  plan: TemplateApplicationPlan,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    template: {
      ref: plan.templateRef,
      id: plan.templateId,
      version: plan.templateVersion,
      source: plan.templateSource,
      manifestHash: plan.manifestHash,
    },
    specName: plan.specPlan.specName,
    specKind: plan.specPlan.specType,
    workflowMode: plan.mode,
    title: plan.specPlan.title,
    dir: plan.specPlan.dir,
    candidateHash: plan.candidateHash,
    variableNames: plan.variableNames,
    diagnostics: plan.diagnostics,
    files: plan.specPlan.files.map((file) => ({
      fileName: file.fileName,
      stage: file.stage,
      bytes: Buffer.byteLength(file.content, 'utf8'),
      content: file.content,
    })),
    state: plan.specPlan.state,
    statePath: plan.specPlan.statePath,
    ...extra,
  };
}

export function registerTemplateCommands(program: Command, runtime: CliRuntime): void {
  const template = program
    .command('template')
    .description('Discover, preview, and apply reusable spec templates (offline, deterministic)');

  template
    .command('list')
    .description('List available templates from the built-in catalog and project-local packs')
    .option('--source <source>', 'template source: builtin | project | all', 'all')
    .option('--kind <kind>', `filter by spec kind: ${SPEC_TYPES.join(' | ')}`)
    .option('--mode <mode>', `filter by supported workflow mode: ${WORKFLOW_MODES.join(' | ')}`)
    .option('--tag <tag>', 'filter by tag')
    .option('--json', 'output a machine-readable JSON report')
    .action((options: { source?: string; json?: boolean } & ListFilters) => {
      const catalog = catalogFor(runtime, options.source);
      const entries = applyFilters(catalog.entries, options);
      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.template-list/1', `${CLI_BIN} ${VERSION}`, {
              source: options.source ?? 'all',
              count: entries.length,
              templates: entries.map(entryToJson),
              diagnostics: catalog.diagnostics,
            }),
          ),
        );
        return;
      }
      runtime.out(reportTitle(`Templates (${entries.length})`));
      runtime.out();
      if (entries.length === 0) {
        runtime.out(dim('  No templates match the given filters.'));
        return;
      }
      for (const entry of entries) {
        printEntryLine(runtime, entry);
      }
      runtime.out();
      runtime.out(dim(`Apply one with: ${CLI_BIN} template apply <template> --name <spec-name>`));
    });

  template
    .command('search <query>')
    .description('Search templates by ID, display name, description, and tags (deterministic, local)')
    .option('--source <source>', 'template source: builtin | project | all', 'all')
    .option('--kind <kind>', `filter by spec kind: ${SPEC_TYPES.join(' | ')}`)
    .option('--mode <mode>', `filter by supported workflow mode: ${WORKFLOW_MODES.join(' | ')}`)
    .option('--limit <number>', `maximum results (bounded at ${MAX_SEARCH_LIMIT})`)
    .option('--json', 'output a machine-readable JSON report (includes scores)')
    .action((query: string, options: { source?: string; limit?: string; json?: boolean } & ListFilters) => {
      const catalog = catalogFor(runtime, options.source);
      const filtered: TemplateCatalog = {
        entries: applyFilters(catalog.entries, options),
        diagnostics: catalog.diagnostics,
      };
      const limit = options.limit !== undefined ? Number(options.limit) : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        throw new SpecBridgeError('INVALID_ARGUMENT', `--limit must be a positive integer (got "${options.limit}").`);
      }
      const results = searchTemplates(filtered, query, limit !== undefined ? { limit } : {});
      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.template-search/1', `${CLI_BIN} ${VERSION}`, {
              query,
              count: results.length,
              results: results.map((result) => ({ score: result.score, ...entryToJson(result.entry) })),
            }),
          ),
        );
        return;
      }
      runtime.out(reportTitle(`Search results for "${query}" (${results.length})`));
      runtime.out();
      if (results.length === 0) {
        runtime.out(dim(`  No templates match. Try ${CLI_BIN} template list.`));
        return;
      }
      for (const result of results) {
        printEntryLine(runtime, result.entry);
      }
    });

  template
    .command('show <template>')
    .description('Show template metadata, variables, files, and usage')
    .option('--manifest', 'print the raw manifest JSON')
    .option('--files', 'print the template file contents')
    .option('--readme', 'print the template README')
    .option('--json', 'output a machine-readable JSON report')
    .action(
      (
        reference: string,
        options: { manifest?: boolean; files?: boolean; readme?: boolean; json?: boolean },
      ) => {
        const catalog = catalogFor(runtime);
        const entry = resolveTemplate(catalog, reference);
        const manifest = entry.pack.manifest;
        if (options.json === true) {
          runtime.outRaw(
            serializeJsonReport(
              createJsonReport('specbridge.template-show/1', `${CLI_BIN} ${VERSION}`, {
                ...entryToJson(entry),
                variables: manifest?.variables ?? [],
                files: manifest?.files ?? [],
                readme: entry.pack.readme ?? null,
                manifest: options.manifest === true ? manifest : undefined,
                issues: entry.pack.issues,
              }),
            ),
          );
          return;
        }
        if (options.manifest === true) {
          runtime.outRaw(entry.pack.manifestText ?? '');
          return;
        }
        if (options.readme === true) {
          runtime.outRaw(entry.pack.readme ?? `No README.md in ${entry.ref}.\n`);
          return;
        }
        if (options.files === true) {
          for (const file of manifest?.files ?? []) {
            runtime.out(dim(`--- ${file.source} -> ${file.target} ---`));
            runtime.outRaw(entry.pack.files.get(file.source) ?? '');
          }
          return;
        }
        runtime.out(reportTitle(`${entry.ref} — ${manifest?.displayName ?? '(invalid template)'}`));
        runtime.out();
        if (manifest === undefined) {
          printIssues(runtime, entry.pack.issues);
          runtime.exitCode = EXIT_CODES.gateFailure;
          return;
        }
        runtime.out(`  ${manifest.description}`);
        runtime.out();
        runtime.out(`  Source:   ${entry.source}`);
        runtime.out(`  Version:  ${manifest.version}`);
        runtime.out(`  Kind:     ${manifest.kind}`);
        runtime.out(`  Modes:    ${manifest.supportedModes.join(', ')} (default: ${manifest.defaultMode})`);
        runtime.out(`  Tags:     ${manifest.tags.join(', ')}`);
        runtime.out(`  License:  ${manifest.license}`);
        runtime.out(`  Requires: SpecBridge ${manifest.compatibility.specbridge}`);
        runtime.out(`  Valid:    ${entry.valid ? 'yes' : 'NO — run "template validate"'}`);
        runtime.out();
        runtime.out(sectionTitle('Files'));
        for (const file of manifest.files) {
          runtime.out(okLine(`${file.target}`, `(${file.stage}, from ${file.source})`));
        }
        runtime.out();
        runtime.out(sectionTitle('Variables'));
        if (manifest.variables.length === 0) {
          runtime.out(dim('  none — only the built-in variables are used'));
        }
        for (const variable of manifest.variables) {
          const requirement = variable.required
            ? 'required'
            : `default: ${JSON.stringify(variable.default ?? '')}`;
          const enumValues = variable.type === 'enum' ? ` [${(variable.values ?? []).join(', ')}]` : '';
          runtime.out(`  --var ${variable.name}=<${variable.type}>${enumValues} (${requirement})`);
          runtime.out(dim(`      ${variable.description}`));
        }
        runtime.out();
        runtime.out(sectionTitle('Usage'));
        const example =
          manifest.examples?.[0] ??
          `${CLI_BIN} template apply ${entry.id} --name <spec-name>` +
            manifest.variables
              .filter((variable) => variable.required)
              .map((variable) => ` --var ${variable.name}=<value>`)
              .join('');
        runtime.out(`  ${example}`);
        if (!entry.valid) {
          runtime.out();
          printIssues(runtime, entry.pack.issues);
          runtime.exitCode = EXIT_CODES.gateFailure;
        }
      },
    );

  template
    .command('validate <template-or-path>')
    .description('Validate an installed template or a local template pack directory')
    .option('--strict', 'treat warnings as failures')
    .option('--json', 'output a machine-readable JSON report')
    .action((target: string, options: { strict?: boolean; json?: boolean }) => {
      const clock = (): Date => runtime.now();
      let issues: TemplateValidationIssue[];
      let subject: string;

      const reference = parseTemplateReference(target);
      const catalog = catalogFor(runtime);
      const catalogMatch =
        reference !== undefined &&
        catalog.entries.some(
          (entry) => entry.id === reference.id && (reference.source === undefined || entry.source === reference.source),
        );

      if (catalogMatch) {
        const entry = resolveTemplate(catalog, target);
        subject = entry.ref;
        issues = [...entry.pack.issues, ...(entry.valid ? checkPackRendering(entry.pack, clock) : [])];
      } else {
        const workspace = runtime.tryWorkspace();
        const resolved = path.resolve(runtime.cwd, target);
        if (!existsSync(resolved)) {
          throw new SpecBridgeError(
            'SPEC_NOT_FOUND',
            `"${target}" is neither a known template nor an existing directory. ` +
              `Run "${CLI_BIN} template list" to see templates, or pass a path to a local template pack.`,
          );
        }
        if (workspace !== undefined) {
          const relativeToRoot = path.relative(workspace.rootDir, resolved);
          // On Windows a cross-drive path comes back absolute, not "..".
          const inside = !relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot);
          if (!inside) {
            throw new SpecBridgeError(
              'PATH_OUTSIDE_WORKSPACE',
              `Template pack path ${resolved} is outside the repository. ` +
                'Copy the pack into the repository before validating it.',
            );
          }
        }
        subject = resolved;
        const pack = loadTemplatePack(readTemplatePackDirectory(resolved));
        issues = [...pack.issues, ...(pack.valid ? checkPackRendering(pack, clock) : [])];
      }

      const errors = issues.filter((issue) => issue.severity === 'error');
      const warnings = issues.filter((issue) => issue.severity === 'warning');
      const failed = errors.length > 0 || (options.strict === true && warnings.length > 0);

      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.template-validate/1', `${CLI_BIN} ${VERSION}`, {
              subject,
              strict: options.strict === true,
              valid: !failed,
              errorCount: errors.length,
              warningCount: warnings.length,
              issues,
            }),
          ),
        );
      } else {
        runtime.out(reportTitle(`Validate ${subject}`));
        runtime.out();
        if (issues.length === 0) {
          runtime.out(okLine('Template pack is valid.'));
        } else {
          printIssues(runtime, issues);
          runtime.out();
          runtime.out(
            failed
              ? failLine(`${errors.length} error(s), ${warnings.length} warning(s).`)
              : warnLine(`0 errors, ${warnings.length} warning(s).`),
          );
        }
      }
      if (failed) {
        runtime.exitCode = EXIT_CODES.gateFailure;
      }
    });

  const previewLike = (dryRunHeading: string) =>
    (
      reference: string,
      options: {
        name: string;
        mode?: string;
        title?: string;
        description?: string;
        json?: boolean;
      } & VarOptions,
    ): TemplateApplicationPlan => {
      const workspace = runtime.workspace();
      const catalog = catalogFor(runtime);
      const clock = (): Date => runtime.now();
      const mode = requireMode(options.mode);
      const inputs = splitTemplateInputs(options);
      const plan = planTemplateApplication(
        workspace,
        catalog,
        {
          reference,
          specName: options.name,
          ...(mode !== undefined ? { mode } : {}),
          ...(inputs.title !== undefined ? { title: inputs.title } : {}),
          ...(inputs.description !== undefined ? { description: inputs.description } : {}),
          variables: inputs.variables,
        },
        clock,
      );
      void dryRunHeading;
      return plan;
    };

  template
    .command('preview <template>')
    .description('Render a template without writing anything (no model, no network, no files)')
    .requiredOption('--name <spec-name>', 'name of the spec that would be created')
    .option('--mode <mode>', `workflow mode: ${WORKFLOW_MODES.join(' | ')} (default: template's defaultMode)`)
    .option('--title <text>', 'human-readable title (default: derived from the spec name)')
    .option('--description <text>', 'description inserted into the first document')
    .option('--var <key=value>', 'template variable (repeatable)', collectVar)
    .option('--json', 'output a machine-readable JSON report')
    .action((reference: string, options: Parameters<ReturnType<typeof previewLike>>[1] & { name: string }) => {
      const plan = previewLike('preview')(reference, options);
      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport(
              'specbridge.template-preview/1',
              `${CLI_BIN} ${VERSION}`,
              applicationPlanJson(plan, { preview: true }),
            ),
          ),
        );
        return;
      }
      printApplicationPlan(runtime, plan, 'Template preview — nothing was written', true);
      runtime.out();
      runtime.out(sectionTitle('Next steps'));
      runtime.out(`  Apply with: ${CLI_BIN} template apply ${reference} --name ${options.name}`);
    });

  template
    .command('apply <template>')
    .description('Create a new spec from a template (atomic; never overwrites an existing spec)')
    .requiredOption('--name <spec-name>', 'name of the spec to create')
    .option('--mode <mode>', `workflow mode: ${WORKFLOW_MODES.join(' | ')} (default: template's defaultMode)`)
    .option('--title <text>', 'human-readable title (default: derived from the spec name)')
    .option('--description <text>', 'description inserted into the first document')
    .option('--var <key=value>', 'template variable (repeatable)', collectVar)
    .option('--dry-run', 'print everything that would be created without writing any file')
    .option('--json', 'output a machine-readable JSON report')
    .action(
      (
        reference: string,
        options: Parameters<ReturnType<typeof previewLike>>[1] & { name: string; dryRun?: boolean },
      ) => {
        const plan = previewLike('apply')(reference, options);
        if (options.dryRun === true) {
          if (options.json === true) {
            runtime.outRaw(
              serializeJsonReport(
                createJsonReport(
                  'specbridge.template-apply/1',
                  `${CLI_BIN} ${VERSION}`,
                  applicationPlanJson(plan, { dryRun: true, created: false }),
                ),
              ),
            );
            return;
          }
          printApplicationPlan(runtime, plan, 'Dry run — nothing was written', true);
          return;
        }

        const workspace = runtime.workspace();
        const clock = (): Date => runtime.now();
        const result = executeTemplateApplication(workspace, plan, clock);
        if (options.json === true) {
          runtime.outRaw(
            serializeJsonReport(
              createJsonReport(
                'specbridge.template-apply/1',
                `${CLI_BIN} ${VERSION}`,
                applicationPlanJson(plan, {
                  dryRun: false,
                  created: true,
                  recordId: result.recordId,
                  writtenFiles: result.creation.writtenFiles,
                }),
              ),
            ),
          );
          return;
        }
        printApplicationPlan(runtime, plan, `Created spec: ${plan.specPlan.specName}`, false);
        runtime.out();
        runtime.out(sectionTitle('Next steps'));
        const firstStage =
          plan.specPlan.specType === 'bugfix'
            ? 'bugfix'
            : plan.mode === 'design-first'
              ? 'design'
              : 'requirements';
        runtime.out(`  1. Replace the remaining placeholders in ${firstStage}.md with real content.`);
        runtime.out(`  2. ${CLI_BIN} spec analyze ${plan.specPlan.specName} --stage ${firstStage}`);
        runtime.out(`  3. ${CLI_BIN} spec approve ${plan.specPlan.specName} --stage ${firstStage}`);
        runtime.out(dim('  Generated stages start unapproved; templates never bypass approval.'));
      },
    );

  template
    .command('install <local-path>')
    .description('Install a local template pack into .specbridge/templates/ (offline, no scripts)')
    .option('--dry-run', 'validate and show what would be installed without writing')
    .option('--json', 'output a machine-readable JSON report')
    .action((localPath: string, options: { dryRun?: boolean; json?: boolean }) => {
      const workspace = runtime.workspace();
      const catalog = catalogFor(runtime);
      const clock = (): Date => runtime.now();
      const plan = planTemplateInstall(workspace, catalog, { sourcePath: localPath, cwd: runtime.cwd });
      const installed = options.dryRun === true ? undefined : executeTemplateInstall(workspace, plan, clock);
      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.template-install/1', `${CLI_BIN} ${VERSION}`, {
              dryRun: options.dryRun === true,
              installed: installed !== undefined,
              ref: plan.ref,
              templateId: plan.templateId,
              version: plan.templateVersion,
              manifestHash: plan.manifestHash,
              sourceDir: plan.sourceDir,
              targetDir: plan.targetDir,
              warnings: plan.warnings,
              recordId: installed?.recordId ?? null,
            }),
          ),
        );
        return;
      }
      runtime.out(
        reportTitle(
          options.dryRun === true ? 'Dry run — nothing was installed' : `Installed template: ${plan.ref}`,
        ),
      );
      runtime.out();
      runtime.out(`  Source: ${relPath(workspace, plan.sourceDir)}`);
      runtime.out(`  Target: ${relPath(workspace, plan.targetDir)}`);
      runtime.out(`  Version: ${plan.templateVersion}`);
      for (const warningText of plan.warnings) {
        runtime.out(warnLine(warningText));
      }
      if (installed !== undefined) {
        runtime.out();
        runtime.out(okLine(`Use it with: ${CLI_BIN} template apply ${plan.ref} --name <spec-name>`));
      }
    });

  template
    .command('uninstall <template>')
    .description('Uninstall a project template (built-in templates are immutable)')
    .option('--dry-run', 'show what would be removed without removing it')
    .option('--json', 'output a machine-readable JSON report')
    .action((reference: string, options: { dryRun?: boolean; json?: boolean }) => {
      const workspace = runtime.workspace();
      const clock = (): Date => runtime.now();
      const plan = planTemplateUninstall(workspace, reference);
      const removed = options.dryRun === true ? undefined : executeTemplateUninstall(workspace, plan, clock);
      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.template-uninstall/1', `${CLI_BIN} ${VERSION}`, {
              dryRun: options.dryRun === true,
              uninstalled: removed !== undefined,
              ref: plan.ref,
              templateId: plan.templateId,
              dir: plan.dir,
              recordId: removed?.recordId ?? null,
            }),
          ),
        );
        return;
      }
      runtime.out(
        reportTitle(
          options.dryRun === true ? 'Dry run — nothing was removed' : `Uninstalled template: ${plan.ref}`,
        ),
      );
      runtime.out();
      runtime.out(`  Directory: ${relPath(workspace, plan.dir)}`);
      runtime.out(
        dim('  Specs generated from this template and template run records are not affected.'),
      );
    });

  template
    .command('scaffold <template-id>')
    .description('Scaffold a new community-ready template pack (manifest, README, template files)')
    .option('--kind <kind>', `spec kind: ${SPEC_TYPES.join(' | ')}`, 'feature')
    .option('--modes <modes>', 'comma-separated supported workflow modes')
    .option('--display-name <text>', 'human-readable template name')
    .option('--description <text>', 'template description for the manifest and README')
    .option('--license <identifier>', 'license identifier for the manifest', 'MIT')
    .option('--output <path>', 'output directory (default: ./<template-id>)')
    .option('--dry-run', 'list the files that would be generated without writing')
    .option('--json', 'output a machine-readable JSON report')
    .action(
      (
        templateId: string,
        options: {
          kind: string;
          modes?: string;
          displayName?: string;
          description?: string;
          license?: string;
          output?: string;
          dryRun?: boolean;
          json?: boolean;
        },
      ) => {
        if (!SPEC_TYPES.includes(options.kind as ConcreteSpecType)) {
          throw new SpecBridgeError(
            'INVALID_ARGUMENT',
            `Unknown --kind "${options.kind}". Valid kinds: ${SPEC_TYPES.join(', ')}.`,
          );
        }
        let modes: ConcreteWorkflowMode[] | undefined;
        if (options.modes !== undefined) {
          modes = options.modes.split(',').map((raw) => {
            const mode = requireMode(raw.trim());
            return mode as ConcreteWorkflowMode;
          });
        }
        const clock = (): Date => runtime.now();
        const plan = planTemplateScaffold({
          templateId,
          kind: options.kind as ConcreteSpecType,
          ...(modes !== undefined ? { modes } : {}),
          ...(options.displayName !== undefined ? { displayName: options.displayName } : {}),
          ...(options.description !== undefined ? { description: options.description } : {}),
          ...(options.license !== undefined ? { license: options.license } : {}),
          outputPath: options.output ?? `./${templateId}`,
          cwd: runtime.cwd,
        });
        const result =
          options.dryRun === true ? undefined : executeTemplateScaffold(plan, runtime.tryWorkspace(), clock);
        if (options.json === true) {
          runtime.outRaw(
            serializeJsonReport(
              createJsonReport('specbridge.template-scaffold/1', `${CLI_BIN} ${VERSION}`, {
                dryRun: options.dryRun === true,
                created: result !== undefined,
                templateId: plan.templateId,
                kind: plan.kind,
                outputDir: plan.outputDir,
                files: [...plan.files.keys()],
                recordId: result?.recordId ?? null,
              }),
            ),
          );
          return;
        }
        runtime.out(
          reportTitle(
            options.dryRun === true
              ? 'Dry run — nothing was written'
              : `Scaffolded template pack: ${plan.templateId}`,
          ),
        );
        runtime.out();
        runtime.out(`  Output: ${plan.outputDir}`);
        runtime.out();
        runtime.out(sectionTitle(options.dryRun === true ? 'Files that would be generated' : 'Files generated'));
        for (const relative of plan.files.keys()) {
          runtime.out(okLine(relative));
        }
        runtime.out();
        runtime.out(sectionTitle('Next steps'));
        runtime.out('  1. Edit the template files (plain Markdown with {{variable}} placeholders).');
        runtime.out(`  2. ${CLI_BIN} template validate ${options.output ?? `./${templateId}`}`);
        runtime.out(`  3. ${CLI_BIN} template install ${options.output ?? `./${templateId}`}`);
        runtime.out(`  4. ${CLI_BIN} template preview project:${plan.templateId} --name example-spec`);
      },
    );
}
