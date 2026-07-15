import { z } from 'zod';
import type { ConcreteSpecType, ConcreteWorkflowMode, StageName } from '@specbridge/core';
import { validateTemplateId } from './ids.js';
import { validateSemverRange } from './semver-range.js';
import type { TemplateValidationIssue } from './types.js';
import { TEMPLATE_PACK_LIMITS } from './types.js';

/**
 * The versioned contract for `specbridge-template.json`.
 *
 * Strictness policy: unknown fields are REJECTED. A manifest is an authored
 * artifact validated at install/apply time, not machine state that must
 * round-trip — failing loudly on a typo (`"varaibles"`) beats silently
 * ignoring it. Readers accept any 1.x schemaVersion; other majors fail with
 * SBT005.
 *
 * Nothing in a manifest is executable: every field is inert data. There are
 * no script hooks, no helper registration, and no expression syntax.
 */

export const TEMPLATE_MANIFEST_SCHEMA_VERSION = '1.0.0';
export const TEMPLATE_MANIFEST_FILE_NAME = 'specbridge-template.json';
export const SUPPORTED_KIRO_LAYOUT = '1';

/** Built-in variables provided by SpecBridge itself; manifests may not shadow them. */
export const BUILTIN_VARIABLE_NAMES = [
  'specName',
  'title',
  'description',
  'kind',
  'mode',
  'generatedDate',
] as const;

export type BuiltinVariableName = (typeof BUILTIN_VARIABLE_NAMES)[number];

/** Allowed rendered file names per spec kind — the full Kiro layout, exactly. */
export const ALLOWED_TARGETS: Record<ConcreteSpecType, readonly string[]> = {
  feature: ['requirements.md', 'design.md', 'tasks.md'],
  bugfix: ['bugfix.md', 'design.md', 'tasks.md'],
};

/** Stage each target file belongs to (mirrors compat-kiro's file-kind map). */
export const TARGET_STAGES: Record<string, StageName> = {
  'requirements.md': 'requirements',
  'bugfix.md': 'bugfix',
  'design.md': 'design',
  'tasks.md': 'tasks',
};

const VARIABLE_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/;
const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
/** Source paths are restricted to a flat `files/` directory with tame names. */
const SOURCE_PATH_PATTERN = /^files\/[a-z0-9][a-z0-9.-]*\.template$/;

const MAX_VARIABLE_NAME_LENGTH = 64;
const MAX_PATTERN_LENGTH = 200;

/**
 * Restricted safe regular expressions for the optional `pattern` variable
 * constraint: no backreferences and no quantified groups, which removes the
 * common catastrophic-backtracking shapes. This is a conservative subset by
 * design — a template that needs more than this should validate in prose.
 */
export function checkSafePattern(pattern: string): string | undefined {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return `pattern exceeds ${MAX_PATTERN_LENGTH} characters`;
  }
  if (/\\[1-9]/.test(pattern)) {
    return 'backreferences (\\1–\\9) are not allowed';
  }
  if (/\)[*+?{]/.test(pattern)) {
    return 'quantified groups like (…)+ are not allowed';
  }
  try {
    new RegExp(pattern, 'u');
  } catch (cause) {
    return `not a valid regular expression: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  return undefined;
}

export const templateVariableSchema = z
  .object({
    name: z.string().min(1).max(MAX_VARIABLE_NAME_LENGTH),
    description: z.string().min(1).max(500),
    type: z.enum(['string', 'boolean', 'integer', 'enum']),
    required: z.boolean().default(false),
    default: z.union([z.string(), z.boolean(), z.number()]).optional(),
    /** Allowed values; required for and exclusive to `enum` variables. */
    values: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
    minLength: z.number().int().min(0).optional(),
    maxLength: z.number().int().min(0).optional(),
    minimum: z.number().int().optional(),
    maximum: z.number().int().optional(),
    /** Restricted safe regular expression the (string) value must match. */
    pattern: z.string().optional(),
  })
  .strict();

export const templateFileSchema = z
  .object({
    source: z.string().min(1),
    target: z.string().min(1),
    stage: z.enum(['requirements', 'bugfix', 'design', 'tasks']),
    required: z.boolean().default(true),
  })
  .strict();

export const templateCompatibilitySchema = z
  .object({
    specbridge: z.string().min(1),
    kiroLayout: z.string().min(1),
  })
  .strict();

export const templateManifestSchema = z
  .object({
    schemaVersion: z.string().regex(SEMVER_PATTERN),
    id: z.string().min(1),
    version: z.string().regex(SEMVER_PATTERN),
    displayName: z.string().min(1).max(100),
    description: z.string().min(1).max(500),
    kind: z.enum(['feature', 'bugfix']),
    supportedModes: z
      .array(z.enum(['requirements-first', 'design-first', 'quick']))
      .min(1)
      .max(3),
    defaultMode: z.enum(['requirements-first', 'design-first', 'quick']),
    tags: z.array(z.string().min(1).max(32)).max(12),
    files: z.array(templateFileSchema).min(1).max(TEMPLATE_PACK_LIMITS.maxPackFiles),
    variables: z.array(templateVariableSchema).max(30),
    compatibility: templateCompatibilitySchema,
    license: z.string().min(1).max(50),
    /** Optional safe metadata — inert strings, never executed or fetched. */
    author: z.string().min(1).max(200).optional(),
    homepage: z.string().min(1).max(500).optional(),
    repository: z.string().min(1).max(500).optional(),
    examples: z.array(z.string().min(1).max(500)).max(5).optional(),
    deprecated: z.boolean().optional(),
    replacement: z.string().min(1).optional(),
    /**
     * Opt-in for the deterministic `generatedDate` built-in variable
     * (YYYY-MM-DD from an injectable clock). Off by default so rendering is
     * fully input-determined unless a template explicitly asks for the date.
     */
    generatedDate: z.boolean().optional(),
  })
  .strict();

export type TemplateVariable = z.infer<typeof templateVariableSchema>;
export type TemplateFileEntry = z.infer<typeof templateFileSchema>;
export type TemplateManifest = z.infer<typeof templateManifestSchema>;
export type TemplateKind = ConcreteSpecType;
export type TemplateMode = ConcreteWorkflowMode;

function issue(
  code: TemplateValidationIssue['code'],
  category: TemplateValidationIssue['category'],
  message: string,
): TemplateValidationIssue {
  return { code, category, severity: 'error', message };
}

/** Is a declared source path shaped safely (no traversal, absolute, or odd chars)? */
export function checkSourcePath(source: string): string | undefined {
  if (source.includes('\0')) return 'contains a null byte';
  if (source.includes('\\')) return 'must use forward slashes';
  if (source.startsWith('/') || /^[A-Za-z]:/.test(source)) return 'must not be an absolute path';
  if (source.split('/').includes('..') || source.split('/').includes('.')) {
    return 'must not contain "." or ".." segments';
  }
  if (!SOURCE_PATH_PATTERN.test(source)) {
    return 'must match files/<lowercase-name>.template (e.g. files/requirements.md.template)';
  }
  return undefined;
}

/**
 * Structural validation beyond the Zod shape: ID rules, mode consistency,
 * file-set completeness for the declared kind, variable-constraint sanity,
 * and compatibility-range syntax. Returns issues instead of throwing so
 * `template validate` can report everything at once.
 */
export function checkManifestSemantics(manifest: TemplateManifest): TemplateValidationIssue[] {
  const issues: TemplateValidationIssue[] = [];

  const idCheck = validateTemplateId(manifest.id);
  if (!idCheck.valid) {
    for (const problem of idCheck.problems) {
      issues.push(issue('SBT003', 'manifest', `Template ID "${manifest.id}": ${problem}`));
    }
  }

  const majorVersion = manifest.schemaVersion.split('.')[0];
  if (majorVersion !== '1') {
    issues.push(
      issue(
        'SBT005',
        'manifest',
        `schemaVersion ${manifest.schemaVersion} is not supported; this SpecBridge understands schema 1.x.`,
      ),
    );
  }

  if (!manifest.supportedModes.includes(manifest.defaultMode)) {
    issues.push(
      issue(
        'SBT004',
        'manifest',
        `defaultMode "${manifest.defaultMode}" is not in supportedModes [${manifest.supportedModes.join(', ')}].`,
      ),
    );
  }
  if (new Set(manifest.supportedModes).size !== manifest.supportedModes.length) {
    issues.push(issue('SBT004', 'manifest', 'supportedModes contains duplicates.'));
  }

  for (const tag of manifest.tags) {
    if (!TAG_PATTERN.test(tag)) {
      issues.push(
        issue('SBT004', 'manifest', `Tag "${tag}" must be lowercase letters/digits with single hyphens.`),
      );
    }
  }
  if (new Set(manifest.tags).size !== manifest.tags.length) {
    issues.push(issue('SBT004', 'manifest', 'tags contains duplicates.'));
  }

  // File set: every allowed target for the kind exactly once, nothing else.
  const allowed = ALLOWED_TARGETS[manifest.kind];
  const seenTargets = new Set<string>();
  const seenSources = new Set<string>();
  for (const file of manifest.files) {
    const sourceProblem = checkSourcePath(file.source);
    if (sourceProblem !== undefined) {
      const code = /absolute/.test(sourceProblem) || /"\.\."/.test(sourceProblem) ? 'SBT008' : 'SBT007';
      issues.push(issue(code, 'paths', `File source "${file.source}" ${sourceProblem}.`));
    }
    if (seenSources.has(file.source)) {
      issues.push(issue('SBT004', 'files', `File source "${file.source}" is declared twice.`));
    }
    seenSources.add(file.source);

    if (!allowed.includes(file.target)) {
      issues.push(
        issue(
          'SBT011',
          'kiro-layout',
          `Target "${file.target}" is not an allowed ${manifest.kind} spec file. ` +
            `Allowed targets: ${allowed.join(', ')}. Variables are never allowed in target paths.`,
        ),
      );
      continue;
    }
    if (seenTargets.has(file.target)) {
      issues.push(issue('SBT012', 'files', `Target "${file.target}" is declared more than once.`));
    }
    seenTargets.add(file.target);

    const expectedStage = TARGET_STAGES[file.target];
    if (expectedStage !== undefined && file.stage !== expectedStage) {
      issues.push(
        issue(
          'SBT004',
          'files',
          `Target "${file.target}" must declare stage "${expectedStage}" (got "${file.stage}").`,
        ),
      );
    }
    if (!file.required) {
      issues.push(
        issue(
          'SBT004',
          'kiro-layout',
          `Target "${file.target}" is marked optional, but Kiro layout ${SUPPORTED_KIRO_LAYOUT} requires all ` +
            `${manifest.kind} files. Set "required": true.`,
        ),
      );
    }
  }
  for (const target of allowed) {
    if (!seenTargets.has(target)) {
      issues.push(
        issue(
          'SBT004',
          'kiro-layout',
          `A ${manifest.kind} template must render "${target}", but no file declares it as a target.`,
        ),
      );
    }
  }

  // Variables.
  const seenVariables = new Set<string>();
  for (const variable of manifest.variables) {
    if (!VARIABLE_NAME_PATTERN.test(variable.name)) {
      issues.push(
        issue(
          'SBT004',
          'variables',
          `Variable name "${variable.name}" must match [a-z][a-zA-Z0-9]* (lower camelCase).`,
        ),
      );
    }
    if ((BUILTIN_VARIABLE_NAMES as readonly string[]).includes(variable.name)) {
      issues.push(
        issue(
          'SBT004',
          'variables',
          `Variable "${variable.name}" shadows a built-in variable. ` +
            `Built-ins (${BUILTIN_VARIABLE_NAMES.join(', ')}) are provided by SpecBridge and cannot be redeclared.`,
        ),
      );
    }
    if (seenVariables.has(variable.name)) {
      issues.push(issue('SBT004', 'variables', `Variable "${variable.name}" is declared twice.`));
    }
    seenVariables.add(variable.name);

    if (variable.type === 'enum') {
      if (variable.values === undefined) {
        issues.push(
          issue('SBT004', 'variables', `Enum variable "${variable.name}" must declare "values".`),
        );
      } else if (new Set(variable.values).size !== variable.values.length) {
        issues.push(
          issue('SBT004', 'variables', `Enum variable "${variable.name}" has duplicate values.`),
        );
      }
    } else if (variable.values !== undefined) {
      issues.push(
        issue('SBT004', 'variables', `"values" is only allowed on enum variables ("${variable.name}").`),
      );
    }

    if (variable.type !== 'string' && (variable.minLength !== undefined || variable.maxLength !== undefined || variable.pattern !== undefined)) {
      issues.push(
        issue(
          'SBT004',
          'variables',
          `minLength/maxLength/pattern are only allowed on string variables ("${variable.name}").`,
        ),
      );
    }
    if (variable.type !== 'integer' && (variable.minimum !== undefined || variable.maximum !== undefined)) {
      issues.push(
        issue('SBT004', 'variables', `minimum/maximum are only allowed on integer variables ("${variable.name}").`),
      );
    }
    if (
      variable.minLength !== undefined &&
      variable.maxLength !== undefined &&
      variable.minLength > variable.maxLength
    ) {
      issues.push(
        issue('SBT004', 'variables', `Variable "${variable.name}": minLength exceeds maxLength.`),
      );
    }
    if (variable.minimum !== undefined && variable.maximum !== undefined && variable.minimum > variable.maximum) {
      issues.push(issue('SBT004', 'variables', `Variable "${variable.name}": minimum exceeds maximum.`));
    }
    if (variable.pattern !== undefined) {
      const patternProblem = checkSafePattern(variable.pattern);
      if (patternProblem !== undefined) {
        issues.push(
          issue('SBT004', 'variables', `Variable "${variable.name}" pattern rejected: ${patternProblem}.`),
        );
      }
    }
    if (variable.default !== undefined) {
      const defaultType = typeof variable.default;
      const expected: Record<TemplateVariable['type'], string> = {
        string: 'string',
        boolean: 'boolean',
        integer: 'number',
        enum: 'string',
      };
      if (defaultType !== expected[variable.type]) {
        issues.push(
          issue(
            'SBT004',
            'variables',
            `Variable "${variable.name}" default must be a ${expected[variable.type]} (got ${defaultType}).`,
          ),
        );
      }
      if (variable.required) {
        issues.push(
          issue(
            'SBT004',
            'variables',
            `Variable "${variable.name}" is required and also has a default — pick one.`,
          ),
        );
      }
    }
  }

  // Compatibility.
  const rangeCheck = validateSemverRange(manifest.compatibility.specbridge);
  if (!rangeCheck.valid) {
    issues.push(
      issue(
        'SBT004',
        'compatibility',
        `compatibility.specbridge is invalid: ${rangeCheck.problem ?? 'unparseable range'}.`,
      ),
    );
  }
  if (manifest.compatibility.kiroLayout !== SUPPORTED_KIRO_LAYOUT) {
    issues.push(
      issue(
        'SBT006',
        'compatibility',
        `compatibility.kiroLayout "${manifest.compatibility.kiroLayout}" is not supported ` +
          `(this SpecBridge supports layout "${SUPPORTED_KIRO_LAYOUT}").`,
      ),
    );
  }

  if (manifest.replacement !== undefined && !validateTemplateId(manifest.replacement).valid) {
    issues.push(
      issue('SBT004', 'manifest', `replacement "${manifest.replacement}" is not a valid template ID.`),
    );
  }

  return issues;
}

export interface ManifestParseResult {
  manifest?: TemplateManifest;
  issues: TemplateValidationIssue[];
}

/**
 * Parse and fully validate manifest text. Never throws — all problems are
 * returned as categorized issues so callers can report them together.
 */
export function parseTemplateManifest(text: string): ManifestParseResult {
  if (Buffer.byteLength(text, 'utf8') > TEMPLATE_PACK_LIMITS.maxManifestBytes) {
    return {
      issues: [
        issue(
          'SBT019',
          'limits',
          `Manifest exceeds ${TEMPLATE_PACK_LIMITS.maxManifestBytes} bytes. Manifests are metadata, not content.`,
        ),
      ],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return {
      issues: [
        issue(
          'SBT004',
          'manifest',
          `Manifest is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}.`,
        ),
      ],
    };
  }

  // Surface an unsupported major schemaVersion before strict shape errors, so
  // a future-major manifest fails with SBT005 rather than a confusing list of
  // unknown-field complaints.
  if (typeof parsed === 'object' && parsed !== null) {
    const declared = (parsed as Record<string, unknown>)['schemaVersion'];
    if (typeof declared === 'string' && SEMVER_PATTERN.test(declared) && declared.split('.')[0] !== '1') {
      return {
        issues: [
          issue(
            'SBT005',
            'manifest',
            `schemaVersion ${declared} is not supported; this SpecBridge understands schema 1.x. ` +
              'Upgrade SpecBridge or use a 1.x template.',
          ),
        ],
      };
    }
  }

  const result = templateManifestSchema.safeParse(parsed);
  if (!result.success) {
    return {
      issues: result.error.issues.slice(0, 25).map((zodIssue) =>
        issue(
          'SBT004',
          'manifest',
          `${zodIssue.path.length > 0 ? zodIssue.path.join('.') : 'manifest'}: ${zodIssue.message}`,
        ),
      ),
    };
  }
  const semanticIssues = checkManifestSemantics(result.data);
  if (semanticIssues.some((entry) => entry.severity === 'error')) {
    return { manifest: result.data, issues: semanticIssues };
  }
  return { manifest: result.data, issues: semanticIssues };
}
