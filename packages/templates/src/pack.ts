import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { MarkdownDocument, parseBugfix, parseDesign, parseRequirements, parseTasks } from '@specbridge/compat-kiro';
import type { Diagnostic } from '@specbridge/core';
import type { Clock } from '@specbridge/workflow';
import { TemplateError } from './errors.js';
import type { TemplateManifest } from './manifest.js';
import {
  BUILTIN_VARIABLE_NAMES,
  TARGET_STAGES,
  TEMPLATE_MANIFEST_FILE_NAME,
  parseTemplateManifest,
} from './manifest.js';
import { collectPlaceholders, renderTemplateText } from './renderer.js';
import { SPECBRIDGE_VERSION } from './version.js';
import { semverSatisfies } from './semver-range.js';
import type { TemplateValidationIssue } from './types.js';
import { TEMPLATE_PACK_LIMITS } from './types.js';
import { resolveVariables } from './variables.js';

/**
 * Template pack model: a manifest plus plain-text template files.
 *
 * Packs are pure data. Loading a pack never executes anything, never follows
 * symlinks, never reads outside the pack directory, and enforces strict size
 * and count limits before any content is interpreted.
 */

/** Files a pack may contain besides the manifest and declared sources. */
const EXTRA_ALLOWED_FILES = ['README.md', 'LICENSE'] as const;

const MAX_PACK_DEPTH = 3;

export interface TemplatePackData {
  /** Human-readable origin for error messages (e.g. "builtin" or a path). */
  origin: string;
  /** Pack-relative POSIX path → UTF-8 content. */
  files: ReadonlyMap<string, string>;
}

export interface LoadedTemplatePack {
  origin: string;
  manifest: TemplateManifest | undefined;
  manifestText: string | undefined;
  readme: string | undefined;
  files: ReadonlyMap<string, string>;
  issues: TemplateValidationIssue[];
  valid: boolean;
}

function issue(
  code: TemplateValidationIssue['code'],
  category: TemplateValidationIssue['category'],
  message: string,
  file?: string,
): TemplateValidationIssue {
  return file === undefined ? { code, category, severity: 'error', message } : { code, category, severity: 'error', message, file };
}

function warning(
  code: TemplateValidationIssue['code'],
  category: TemplateValidationIssue['category'],
  message: string,
  file?: string,
): TemplateValidationIssue {
  return file === undefined
    ? { code, category, severity: 'warning', message }
    : { code, category, severity: 'warning', message, file };
}

/**
 * Read a template pack directory into memory with every filesystem-level
 * security check applied: the directory and every entry must be a regular
 * file or directory (symlinks are rejected outright), nesting is bounded,
 * every file must be valid UTF-8 text without null bytes, and per-file /
 * total-size / file-count limits are enforced before content is parsed.
 *
 * Throws `TemplateError` on any violation — a pack that fails here is never
 * partially processed.
 */
export function readTemplatePackDirectory(dir: string): TemplatePackData {
  const rootStat = statNoFollow(dir);
  if (rootStat.isSymbolicLink()) {
    throw new TemplateError('SBT009', `Template pack path is a symlink: ${dir}.`, 'Point at the real directory.', {
      path: dir,
    });
  }
  if (!rootStat.isDirectory()) {
    throw new TemplateError(
      'SBT007',
      `Template pack path is not a directory: ${dir}.`,
      'Point at a directory containing specbridge-template.json.',
      { path: dir },
    );
  }

  const files = new Map<string, string>();
  let totalBytes = 0;

  const walk = (currentDir: string, relative: string, depth: number): void => {
    if (depth > MAX_PACK_DEPTH) {
      throw new TemplateError(
        'SBT019',
        `Template pack nests deeper than ${MAX_PACK_DEPTH} directories at ${relative}.`,
        'Template packs are flat: a manifest, README.md, and a files/ directory.',
        { path: currentDir },
      );
    }
    const entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    );
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      const entryRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const stat = statNoFollow(entryPath);
      if (stat.isSymbolicLink()) {
        throw new TemplateError(
          'SBT009',
          `Template pack contains a symlink: ${entryRelative}.`,
          'Remove the symlink; packs must contain regular files only.',
          { path: entryPath },
        );
      }
      if (stat.isDirectory()) {
        walk(entryPath, entryRelative, depth + 1);
        continue;
      }
      if (!stat.isFile()) {
        throw new TemplateError(
          'SBT007',
          `Template pack contains a non-regular file: ${entryRelative}.`,
          'Packs may contain regular text files only.',
          { path: entryPath },
        );
      }
      if (files.size >= TEMPLATE_PACK_LIMITS.maxPackFiles) {
        throw new TemplateError(
          'SBT019',
          `Template pack has more than ${TEMPLATE_PACK_LIMITS.maxPackFiles} files.`,
          'Remove files that are not the manifest, README.md, LICENSE, or declared template files.',
          { path: dir },
        );
      }
      const perFileLimit = Math.max(
        TEMPLATE_PACK_LIMITS.maxTemplateFileBytes,
        TEMPLATE_PACK_LIMITS.maxManifestBytes,
      );
      if (stat.size > perFileLimit) {
        throw new TemplateError(
          'SBT019',
          `${entryRelative} is ${stat.size} bytes (per-file limit ${perFileLimit}).`,
          'Template files are Markdown documents, not data payloads.',
          { path: entryPath },
        );
      }
      totalBytes += stat.size;
      if (totalBytes > TEMPLATE_PACK_LIMITS.maxTotalPackBytes) {
        throw new TemplateError(
          'SBT019',
          `Template pack exceeds ${TEMPLATE_PACK_LIMITS.maxTotalPackBytes} bytes in total.`,
          'Reduce the pack size.',
          { path: dir },
        );
      }
      const buffer = readFileSync(entryPath);
      const text = buffer.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(buffer)) {
        throw new TemplateError(
          'SBT025',
          `${entryRelative} is not valid UTF-8 text.`,
          'Template packs contain UTF-8 text files only; binary content is rejected.',
          { path: entryPath },
        );
      }
      if (text.includes('\0')) {
        throw new TemplateError(
          'SBT025',
          `${entryRelative} contains binary (null-byte) content.`,
          'Template packs contain plain text files only.',
          { path: entryPath },
        );
      }
      files.set(entryRelative, text);
    }
  };

  walk(dir, '', 0);
  return { origin: dir, files };
}

function statNoFollow(target: string) {
  try {
    return lstatSync(target);
  } catch (cause) {
    throw new TemplateError(
      'SBT007',
      `Cannot read template pack path ${target}: ${cause instanceof Error ? cause.message : String(cause)}.`,
      'Check that the path exists and is readable.',
      { path: target },
    );
  }
}

export interface LoadPackOptions {
  /** Built-in and scaffolded community packs must ship a README. */
  requireReadme?: boolean;
  /** Check compatibility.specbridge against this version (default: current). */
  specbridgeVersion?: string;
}

/**
 * Validate pack structure and manifest without touching the filesystem.
 * Every check is reported as a categorized issue; nothing throws, so
 * `template validate` can present the full picture at once.
 */
export function loadTemplatePack(data: TemplatePackData, options: LoadPackOptions = {}): LoadedTemplatePack {
  const issues: TemplateValidationIssue[] = [];
  const manifestText = data.files.get(TEMPLATE_MANIFEST_FILE_NAME);
  const readme = data.files.get('README.md');

  let manifest: TemplateManifest | undefined;
  if (manifestText === undefined) {
    issues.push(
      issue(
        'SBT004',
        'manifest',
        `Pack has no ${TEMPLATE_MANIFEST_FILE_NAME} at its root. Every template pack starts with a manifest.`,
      ),
    );
  } else {
    const parsed = parseTemplateManifest(manifestText);
    manifest = parsed.manifest;
    issues.push(...parsed.issues);
  }

  if (readme === undefined) {
    const message =
      'Pack has no README.md. A README with usage instructions is required for built-in and community-ready templates.';
    issues.push(
      options.requireReadme === true
        ? issue('SBT004', 'documentation', message)
        : warning('SBT004', 'documentation', message),
    );
  }

  if (manifest !== undefined) {
    const declaredSources = new Set(manifest.files.map((file) => file.source));
    for (const file of manifest.files) {
      if (!data.files.has(file.source)) {
        issues.push(
          issue('SBT007', 'paths', `Declared source "${file.source}" does not exist in the pack.`, file.source),
        );
      }
    }
    for (const packFile of data.files.keys()) {
      if (packFile === TEMPLATE_MANIFEST_FILE_NAME) continue;
      if ((EXTRA_ALLOWED_FILES as readonly string[]).includes(packFile)) continue;
      if (declaredSources.has(packFile)) continue;
      issues.push(
        issue(
          'SBT010',
          'files',
          `"${packFile}" is not the manifest, README.md, LICENSE, or a declared template file. ` +
            'Undeclared files are rejected — nothing outside the manifest can ever be rendered.',
          packFile,
        ),
      );
    }

    // Every template file must be renderable in size before substitution.
    for (const file of manifest.files) {
      const content = data.files.get(file.source);
      if (content === undefined) continue;
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > TEMPLATE_PACK_LIMITS.maxTemplateFileBytes) {
        issues.push(
          issue(
            'SBT019',
            'limits',
            `"${file.source}" is ${bytes} bytes (limit ${TEMPLATE_PACK_LIMITS.maxTemplateFileBytes}).`,
            file.source,
          ),
        );
      }
    }

    // Static placeholder resolution: every placeholder must map to a declared
    // variable or an available built-in. This catches unresolved placeholders
    // without needing any variable values.
    const declaredVariables = new Set(manifest.variables.map((variable) => variable.name));
    const availableBuiltins = new Set<string>(
      (BUILTIN_VARIABLE_NAMES as readonly string[]).filter(
        (name) => name !== 'generatedDate' || manifest?.generatedDate === true,
      ),
    );
    for (const file of manifest.files) {
      const content = data.files.get(file.source);
      if (content === undefined) continue;
      const { names, malformed } = collectPlaceholders(content);
      for (const bad of malformed) {
        issues.push(
          issue(
            'SBT016',
            'rendering',
            `"${file.source}" contains a malformed placeholder "${bad}". ` +
              'Placeholders must be exactly {{variableName}}.',
            file.source,
          ),
        );
      }
      for (const name of names) {
        if (!declaredVariables.has(name) && !availableBuiltins.has(name)) {
          const hint =
            name === 'generatedDate'
              ? 'Set "generatedDate": true in the manifest to opt in to the generated date.'
              : 'Declare it in the manifest "variables" array or remove the placeholder.';
          issues.push(
            issue(
              'SBT016',
              'rendering',
              `"${file.source}" references undeclared variable "{{${name}}}". ${hint}`,
              file.source,
            ),
          );
        }
      }
    }

    const version = options.specbridgeVersion ?? SPECBRIDGE_VERSION;
    if (!semverSatisfies(version, manifest.compatibility.specbridge)) {
      issues.push(
        issue(
          'SBT006',
          'compatibility',
          `Template requires SpecBridge ${manifest.compatibility.specbridge}, but this is ${version}.`,
        ),
      );
    }
  }

  return {
    origin: data.origin,
    manifest,
    manifestText,
    readme,
    files: data.files,
    issues,
    valid: !issues.some((entry) => entry.severity === 'error'),
  };
}

/**
 * Deterministic sample value for a variable, used by the validation-time
 * render check. Returns undefined when no safe sample can be synthesized
 * (e.g. a required string with a pattern constraint and no default).
 */
function sampleValue(variable: TemplateManifest['variables'][number]): string | number | boolean | undefined {
  if (variable.default !== undefined) return variable.default;
  switch (variable.type) {
    case 'string': {
      if (variable.pattern !== undefined) return undefined;
      let sample = `Example ${variable.name} value`;
      if (variable.maxLength !== undefined && sample.length > variable.maxLength) {
        sample = sample.slice(0, variable.maxLength);
      }
      if (variable.minLength !== undefined && sample.length < variable.minLength) {
        sample = sample.padEnd(variable.minLength, 'x');
      }
      return sample;
    }
    case 'boolean':
      return true;
    case 'integer':
      return variable.minimum ?? variable.maximum ?? 1;
    case 'enum':
      return variable.values?.[0];
  }
}

/**
 * Validation-time render check: renders every declared file with
 * deterministic sample values and reports renderer failures and structural
 * problems (empty documents, missing top-level heading) as issues. Uses the
 * injected clock so results are reproducible.
 */
export function checkPackRendering(pack: LoadedTemplatePack, clock: Clock): TemplateValidationIssue[] {
  const manifest = pack.manifest;
  if (manifest === undefined) return [];
  const issues: TemplateValidationIssue[] = [];

  const supplied: Record<string, string | number | boolean> = {};
  let renderable = true;
  for (const variable of manifest.variables) {
    if (!variable.required && variable.default === undefined && variable.type === 'string') continue;
    const sample = sampleValue(variable);
    if (sample === undefined) {
      issues.push(
        warning(
          'SBT015',
          'rendering',
          `Render check could not synthesize a sample for variable "${variable.name}" ` +
            '(pattern-constrained without a default); rendering was checked with the remaining variables.',
        ),
      );
      if (variable.required) renderable = false;
      continue;
    }
    supplied[variable.name] = sample;
  }
  if (!renderable) return issues;

  let resolved;
  try {
    resolved = resolveVariables(manifest, supplied, {
      specName: 'example-spec',
      title: 'Example Spec',
      description: 'Example description used by template validation.',
      kind: manifest.kind,
      mode: manifest.defaultMode,
      clock,
    });
  } catch (cause) {
    issues.push(
      issue(
        'SBT015',
        'rendering',
        `Render check failed while resolving variables: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
    );
    return issues;
  }

  for (const file of manifest.files) {
    const content = pack.files.get(file.source);
    if (content === undefined) continue;
    let rendered: string;
    try {
      rendered = renderTemplateText(file.source, content, resolved.values);
    } catch (cause) {
      issues.push(
        issue(
          'SBT017',
          'rendering',
          `Rendering "${file.source}" failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          file.source,
        ),
      );
      continue;
    }
    issues.push(...checkRenderedDocument(file.source, file.target, rendered));
  }
  return issues;
}

/**
 * Structural checks on one rendered document. Errors block apply; stylistic
 * findings are warnings. These reuse the deterministic Kiro-compatible
 * parsers — no model, no network.
 */
export function checkRenderedDocument(
  sourceLabel: string,
  target: string,
  rendered: string,
): TemplateValidationIssue[] {
  const issues: TemplateValidationIssue[] = [];
  if (rendered.trim().length === 0) {
    issues.push(issue('SBT017', 'rendering', `"${sourceLabel}" renders to an empty document.`, sourceLabel));
    return issues;
  }
  if (!/^#\s+\S/m.test(rendered)) {
    issues.push(
      issue(
        'SBT017',
        'rendering',
        `"${sourceLabel}" renders without a top-level "# " heading; Kiro spec files start with one.`,
        sourceLabel,
      ),
    );
  }
  if (!rendered.endsWith('\n')) {
    issues.push(
      warning('SBT017', 'rendering', `"${sourceLabel}" does not end with a newline.`, sourceLabel),
    );
  }
  if (rendered.includes('\r\n')) {
    issues.push(
      warning('SBT017', 'rendering', `"${sourceLabel}" renders with CRLF line endings; generated files use LF.`, sourceLabel),
    );
  }
  issues.push(
    ...parserDiagnostics(target, rendered).map((diagnostic) =>
      warning('SBT017', 'rendering', `${target}: ${diagnostic.message}`, sourceLabel),
    ),
  );
  return issues;
}

/** Run the matching tolerant Kiro parser and return its diagnostics. */
export function parserDiagnostics(target: string, rendered: string): Diagnostic[] {
  const document = MarkdownDocument.fromText(rendered, target);
  const stage = TARGET_STAGES[target];
  switch (stage) {
    case 'requirements':
      return parseRequirements(document).diagnostics;
    case 'design':
      return parseDesign(document).diagnostics;
    case 'tasks':
      return parseTasks(document).diagnostics;
    case 'bugfix':
      return parseBugfix(document).diagnostics;
    default:
      return [];
  }
}
