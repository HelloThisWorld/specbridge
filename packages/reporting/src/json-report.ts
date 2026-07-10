/**
 * JSON report envelope shared by all `--json` command outputs and stored
 * reports. Reports are deterministic: no timestamps or random ids are added
 * here. (Run records with timestamps arrive with the task-execution phase.)
 */

export interface JsonReport<T> {
  /** e.g. `specbridge.doctor/1` */
  schema: string;
  generator: string;
  data: T;
}

export function createJsonReport<T>(schema: string, generator: string, data: T): JsonReport<T> {
  return { schema, generator, data };
}

/** Pretty-printed JSON with a trailing newline, ready for stdout or a file. */
export function serializeJsonReport(report: unknown): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
