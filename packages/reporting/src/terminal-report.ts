import pc from 'picocolors';
import type { DiagnosticSeverity } from '@specbridge/core';

/**
 * Small terminal-formatting vocabulary shared by all CLI commands.
 * picocolors handles NO_COLOR / non-TTY detection automatically.
 */

export const sym = {
  ok: '✓',
  warn: '!',
  fail: '✗',
  info: '·',
  add: '+',
} as const;

export function okLine(message: string, detail?: string): string {
  return `  ${pc.green(sym.ok)} ${message}${detail !== undefined ? ` ${pc.dim(detail)}` : ''}`;
}

export function warnLine(message: string, detail?: string): string {
  return `  ${pc.yellow(sym.warn)} ${message}${detail !== undefined ? ` ${pc.dim(detail)}` : ''}`;
}

export function failLine(message: string, detail?: string): string {
  return `  ${pc.red(sym.fail)} ${message}${detail !== undefined ? ` ${pc.dim(detail)}` : ''}`;
}

export function infoLine(message: string, detail?: string): string {
  return `  ${pc.dim(sym.info)} ${message}${detail !== undefined ? ` ${pc.dim(detail)}` : ''}`;
}

export function addLine(message: string): string {
  return `  ${pc.cyan(sym.add)} ${message}`;
}

export function severityLine(severity: DiagnosticSeverity, message: string): string {
  if (severity === 'error') return failLine(message);
  if (severity === 'warning') return warnLine(message);
  return infoLine(message);
}

export function sectionTitle(title: string): string {
  return pc.bold(`${title}:`);
}

export function reportTitle(title: string): string {
  return pc.bold(title);
}

export function dim(text: string): string {
  return pc.dim(text);
}

export function bold(text: string): string {
  return pc.bold(text);
}

/** Render rows as aligned plain-text columns (two-space gutter). */
export function renderColumns(rows: string[][], indent = '  '): string[] {
  if (rows.length === 0) return [];
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) => {
    const cells = row.map((cell, i) =>
      i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? cell.length),
    );
    return `${indent}${cells.join('  ')}`.replace(/\s+$/, '');
  });
}
