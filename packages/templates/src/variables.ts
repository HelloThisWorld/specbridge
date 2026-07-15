import type { Clock } from '@specbridge/workflow';
import { TemplateError } from './errors.js';
import type { TemplateManifest, TemplateVariable } from './manifest.js';
import { BUILTIN_VARIABLE_NAMES } from './manifest.js';
import { TEMPLATE_PACK_LIMITS } from './types.js';

/**
 * Variable resolution and validation.
 *
 * Deterministic by construction: the same manifest, supplied values, and
 * built-in inputs always produce the same resolved map. Environment
 * variables, usernames, machine names, and absolute paths are never exposed;
 * the only time-derived value is the opt-in `generatedDate`, produced from an
 * injectable clock.
 */

export type SuppliedVariableValue = string | number | boolean;

export interface BuiltinVariableInput {
  specName: string;
  title: string;
  description: string;
  kind: string;
  mode: string;
  /** Only consulted when the manifest opts in via `"generatedDate": true`. */
  clock: Clock;
}

export interface ResolvedVariables {
  /** Final substitution map handed to the renderer (built-ins included). */
  values: Map<string, string>;
  /** Names of manifest-declared variables that were supplied or defaulted. */
  variableNames: string[];
}

function rejectNullBytes(name: string, value: string): void {
  if (value.includes('\0')) {
    throw new TemplateError(
      'SBT015',
      `Variable "${name}" contains a null byte.`,
      'Remove the null byte from the value.',
      { variable: name },
    );
  }
}

function coerceValue(variable: TemplateVariable, raw: SuppliedVariableValue): string {
  const name = variable.name;
  switch (variable.type) {
    case 'string': {
      if (typeof raw !== 'string') {
        throw invalidValue(name, `expected a string, got ${typeof raw}`);
      }
      if (raw.length > TEMPLATE_PACK_LIMITS.maxVariableValueLength) {
        throw invalidValue(name, `value exceeds ${TEMPLATE_PACK_LIMITS.maxVariableValueLength} characters`);
      }
      if (variable.minLength !== undefined && raw.length < variable.minLength) {
        throw invalidValue(name, `value is shorter than minLength ${variable.minLength}`);
      }
      if (variable.maxLength !== undefined && raw.length > variable.maxLength) {
        throw invalidValue(name, `value is longer than maxLength ${variable.maxLength}`);
      }
      if (variable.pattern !== undefined) {
        // The pattern was vetted by checkSafePattern at manifest validation;
        // still cap tested length as defense in depth.
        if (raw.length > 2000) {
          throw invalidValue(name, 'values checked against a pattern must be at most 2000 characters');
        }
        if (!new RegExp(variable.pattern, 'u').test(raw)) {
          throw invalidValue(name, `value does not match pattern ${variable.pattern}`);
        }
      }
      return raw;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw ? 'true' : 'false';
      if (raw === 'true') return 'true';
      if (raw === 'false') return 'false';
      throw invalidValue(name, `expected true or false, got "${String(raw)}"`);
    }
    case 'integer': {
      let value: number;
      if (typeof raw === 'number') {
        value = raw;
      } else if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) {
        value = Number(raw.trim());
      } else {
        throw invalidValue(name, `expected an integer, got "${String(raw)}"`);
      }
      if (!Number.isSafeInteger(value)) {
        throw invalidValue(name, 'value is not a safe integer');
      }
      if (variable.minimum !== undefined && value < variable.minimum) {
        throw invalidValue(name, `value is below minimum ${variable.minimum}`);
      }
      if (variable.maximum !== undefined && value > variable.maximum) {
        throw invalidValue(name, `value is above maximum ${variable.maximum}`);
      }
      return String(value);
    }
    case 'enum': {
      if (typeof raw !== 'string') {
        throw invalidValue(name, `expected one of ${(variable.values ?? []).join(', ')}`);
      }
      if (!(variable.values ?? []).includes(raw)) {
        throw invalidValue(
          name,
          `"${raw}" is not an allowed value. Allowed: ${(variable.values ?? []).join(', ')}`,
        );
      }
      return raw;
    }
  }
}

function invalidValue(name: string, detail: string): TemplateError {
  return new TemplateError('SBT015', `Variable "${name}": ${detail}.`, 'Fix the value and retry.', {
    variable: name,
  });
}

/** Format YYYY-MM-DD (UTC) from the injected clock. */
export function formatGeneratedDate(clock: Clock): string {
  return clock().toISOString().slice(0, 10);
}

/**
 * Resolve every variable for a render:
 * built-ins first (never overridable), then manifest-declared variables from
 * supplied values or defaults. Unknown supplied names and missing required
 * values are errors. An explicitly supplied empty string is a value, distinct
 * from a missing variable.
 */
export function resolveVariables(
  manifest: TemplateManifest,
  supplied: Readonly<Record<string, SuppliedVariableValue>>,
  builtins: BuiltinVariableInput,
): ResolvedVariables {
  const values = new Map<string, string>();
  for (const [name, raw] of [
    ['specName', builtins.specName],
    ['title', builtins.title],
    ['description', builtins.description],
    ['kind', builtins.kind],
    ['mode', builtins.mode],
  ] as const) {
    rejectNullBytes(name, raw);
    values.set(name, raw);
  }
  if (manifest.generatedDate === true) {
    values.set('generatedDate', formatGeneratedDate(builtins.clock));
  }

  const declared = new Map(manifest.variables.map((variable) => [variable.name, variable]));

  for (const name of Object.keys(supplied)) {
    if ((BUILTIN_VARIABLE_NAMES as readonly string[]).includes(name)) {
      throw new TemplateError(
        'SBT014',
        `"${name}" is a built-in variable and cannot be supplied with --var.`,
        name === 'title' || name === 'description'
          ? `Use the --${name} option instead.`
          : 'Built-in values are derived from the spec name, kind, and mode.',
        { variable: name },
      );
    }
    if (!declared.has(name)) {
      const known = [...declared.keys()];
      throw new TemplateError(
        'SBT014',
        `Variable "${name}" is not declared by this template.`,
        known.length > 0
          ? `Declared variables: ${known.join(', ')}.`
          : 'This template declares no variables.',
        { variable: name },
      );
    }
  }

  const variableNames: string[] = [];
  for (const variable of manifest.variables) {
    const raw = supplied[variable.name];
    if (raw === undefined) {
      if (variable.required) {
        throw new TemplateError(
          'SBT013',
          `Required variable "${variable.name}" was not supplied.`,
          `Pass --var ${variable.name}=<value>. ${variable.description}`,
          { variable: variable.name },
        );
      }
      if (variable.default !== undefined) {
        const coerced = coerceValue(variable, variable.default);
        rejectNullBytes(variable.name, coerced);
        values.set(variable.name, coerced);
        variableNames.push(variable.name);
      } else {
        // Optional without a default: substitutes as empty text.
        values.set(variable.name, '');
        variableNames.push(variable.name);
      }
      continue;
    }
    if (typeof raw === 'string') rejectNullBytes(variable.name, raw);
    const coerced = coerceValue(variable, raw);
    rejectNullBytes(variable.name, coerced);
    values.set(variable.name, coerced);
    variableNames.push(variable.name);
  }

  return { values, variableNames };
}
