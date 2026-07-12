import type { VerificationDiagnostic, VerificationReport } from '@specbridge/core';
import { sortVerificationDiagnostics } from '@specbridge/core';

/**
 * Bounded GitHub file/line annotations. Errors get the budget first; when
 * the limit is reached, one summary warning explains how many findings were
 * suppressed — the full report artifact always has everything.
 */

export interface AnnotationSink {
  error(message: string, properties: AnnotationProperties): void;
  warning(message: string, properties: AnnotationProperties): void;
  notice(message: string, properties: AnnotationProperties): void;
}

export interface AnnotationProperties {
  title?: string;
  file?: string;
  startLine?: number;
  startColumn?: number;
}

function annotatable(diagnostic: VerificationDiagnostic): boolean {
  if (diagnostic.file === null) return false;
  const filePath = diagnostic.file.path;
  // Never annotate paths outside the repository.
  if (filePath.startsWith('/') || /^[A-Za-z]:/.test(filePath)) return false;
  if (filePath.split('/').includes('..')) return false;
  return true;
}

export interface AnnotationOutcome {
  emitted: number;
  suppressed: number;
}

export function emitAnnotations(
  sink: AnnotationSink,
  report: VerificationReport,
  limit: number,
): AnnotationOutcome {
  const all = sortVerificationDiagnostics([
    ...report.globalDiagnostics,
    ...report.specResults.flatMap((spec) => spec.diagnostics),
  ]).filter(annotatable);

  let emitted = 0;
  for (const diagnostic of all) {
    if (emitted >= limit) break;
    const properties: AnnotationProperties = {
      title: `${diagnostic.ruleId} — ${diagnostic.title}`,
      ...(diagnostic.file !== null ? { file: diagnostic.file.path } : {}),
      ...(diagnostic.file?.line != null ? { startLine: diagnostic.file.line } : {}),
      ...(diagnostic.file?.column != null ? { startColumn: diagnostic.file.column } : {}),
    };
    const message = `${diagnostic.message} Fix: ${diagnostic.remediation}`;
    if (diagnostic.severity === 'error') sink.error(message, properties);
    else if (diagnostic.severity === 'warning') sink.warning(message, properties);
    else sink.notice(message, properties);
    emitted += 1;
  }

  const suppressed = all.length - emitted;
  if (suppressed > 0) {
    sink.warning(
      `${suppressed} further finding${suppressed === 1 ? '' : 's'} were not annotated (annotation limit ${limit}); the full report artifact contains everything.`,
      { title: 'SpecBridge — annotation limit reached' },
    );
  }
  return { emitted, suppressed };
}
