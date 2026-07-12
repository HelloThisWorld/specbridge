/**
 * Action input parsing and validation. Inputs arrive as `INPUT_<NAME>`
 * environment variables; every enum is validated with a clear error that
 * names the input, the received value, and the accepted values.
 */

export interface ActionInputs {
  mode: 'single' | 'changed' | 'all';
  spec: string | undefined;
  baseRef: string | undefined;
  headRef: string | undefined;
  failOn: 'error' | 'warning' | 'never';
  strict: boolean;
  runVerification: boolean;
  reportDirectory: string;
  annotations: boolean;
  writeStepSummary: boolean;
  annotationLimit: number;
}

export type GetInput = (name: string) => string;

function requireEnum<T extends string>(
  name: string,
  raw: string,
  accepted: readonly T[],
  fallback: T,
): T {
  const value = raw.trim() === '' ? fallback : raw.trim();
  if (!(accepted as readonly string[]).includes(value)) {
    throw new Error(
      `Input "${name}" must be one of ${accepted.join(', ')}; got "${raw}".`,
    );
  }
  return value as T;
}

function requireBoolean(name: string, raw: string, fallback: boolean): boolean {
  const value = raw.trim().toLowerCase();
  if (value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Input "${name}" must be "true" or "false"; got "${raw}".`);
}

export function parseActionInputs(getInput: GetInput): ActionInputs {
  const mode = requireEnum('mode', getInput('mode'), ['single', 'changed', 'all'], 'changed');
  const spec = getInput('spec').trim();
  if (mode === 'single' && spec === '') {
    throw new Error('Input "spec" is required when mode is "single".');
  }
  if (mode !== 'single' && spec !== '') {
    throw new Error(`Input "spec" only applies when mode is "single" (mode is "${mode}").`);
  }

  const failOn = requireEnum('fail-on', getInput('fail-on'), ['error', 'warning', 'never'], 'error');
  const strict = requireBoolean('strict', getInput('strict'), false);
  const runVerification = requireBoolean('run-verification', getInput('run-verification'), true);
  const annotations = requireBoolean('annotations', getInput('annotations'), true);
  const writeStepSummary = requireBoolean(
    'write-step-summary',
    getInput('write-step-summary'),
    true,
  );

  const reportDirectoryRaw = getInput('report-directory').trim();
  const reportDirectory = reportDirectoryRaw === '' ? '.specbridge/action-reports' : reportDirectoryRaw;
  if (reportDirectory.split(/[\\/]/).includes('..')) {
    throw new Error('Input "report-directory" must not contain ".." path segments.');
  }

  const annotationLimitRaw = getInput('annotation-limit').trim();
  const annotationLimit = annotationLimitRaw === '' ? 50 : Number(annotationLimitRaw);
  if (!Number.isInteger(annotationLimit) || annotationLimit < 0 || annotationLimit > 1000) {
    throw new Error(
      `Input "annotation-limit" must be an integer between 0 and 1000; got "${annotationLimitRaw}".`,
    );
  }

  return {
    mode,
    spec: spec === '' ? undefined : spec,
    baseRef: emptyToUndefined(getInput('base-ref')),
    headRef: emptyToUndefined(getInput('head-ref')),
    failOn,
    strict,
    runVerification,
    reportDirectory,
    annotations,
    writeStepSummary,
    annotationLimit,
  };
}

function emptyToUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
