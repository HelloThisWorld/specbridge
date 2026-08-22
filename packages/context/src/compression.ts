import { createHash } from 'node:crypto';
import type { ContextCompressionMethod } from './vocabulary.js';

/**
 * Deterministic structured compression of large mechanical output.
 *
 * Test logs, compiler output, lint reports, and diffs are the largest single
 * source of avoidable tokens in an engineering runtime, and they are also
 * the most STRUCTURED thing an agent ever sees. So they are compressed by
 * parsing, not by a model: a regular expression that extracts failing test
 * names is cheaper, faster, reproducible, and — unlike a summary — cannot
 * quietly drop the one line the next attempt needed.
 *
 * Two invariants govern every extractor here:
 *
 *   IDENTITY IS PRESERVED   the fields a failure fingerprint is computed
 *                           from (what failed, where, with what code, in
 *                           what order) survive compression verbatim. A
 *                           compression that made two different failures
 *                           look alike would silently defeat vNext.6
 *                           no-progress detection, and a compression that
 *                           made one failure look like two would defeat
 *                           repetition counting just as thoroughly.
 *   DETERMINISTIC           same bytes in, same bytes out. That is what
 *                           lets a fingerprint computed over compressed
 *                           output be compared across attempts at all.
 *
 * Compression is DERIVED data. The canonical raw artifact stays where it
 * already lives (the run directory, the evidence store) under its existing
 * retention policy; what a prompt receives is this representation plus the
 * references needed to go and get the original.
 */

export const COMPRESSION_LIMITS = {
  /** Below this many characters, compressing is not worth the fidelity loss. */
  minCompressibleChars: 2_000,
  /** Never scan more than this much raw input (pathological-output guard). */
  maxScanChars: 4_000_000,
  /** Ceiling on the produced representation. */
  maxOutputChars: 8_000,
  /** How many distinct findings of one class are listed before counting. */
  maxFindingsListed: 25,
  /** Leading identity lines preserved verbatim for fingerprint stability. */
  identityHeadLines: 12,
  maxIdentityLineChars: 300,
} as const;

export interface CompressionFinding {
  /** Stable identity of the finding: a test name, an error code, a rule id. */
  key: string;
  /** How many times it occurred in the raw output. */
  count: number;
  /** Workspace-relative location when the output named one. */
  path?: string | undefined;
  line?: number | undefined;
  /** Bounded message, verbatim from the source (never paraphrased). */
  message?: string | undefined;
}

export interface CompressionResult {
  /** The prompt-ready representation. */
  text: string;
  method: ContextCompressionMethod;
  sourceBytes: number;
  compressedBytes: number;
  /** Structured findings, for metrics and for downstream ranking signals. */
  findings: CompressionFinding[];
  /** Paths the output named, in first-seen order (retrieval evidence). */
  referencedPaths: string[];
  /** SHA-256 of the exact raw input this was derived from. */
  sourceHash: string;
  /**
   * True when the extractor found real structure. False means the text is a
   * bounded structural fallback rather than a parse, which is exactly when
   * the optional local compressor is worth its bounded cost.
   */
  structured: boolean;
}

function hashOf(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function bound(value: string, max = COMPRESSION_LIMITS.maxIdentityLineChars): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/** Should this artifact be compressed at all? */
export function isWorthCompressing(content: string, minChars?: number): boolean {
  const threshold: number = minChars ?? COMPRESSION_LIMITS.minCompressibleChars;
  return content.length > threshold;
}

// ---------------------------------------------------------------------------
// Shared extraction
// ---------------------------------------------------------------------------

const PATH_LOCATION_PATTERN =
  /((?:[\w.@-]+[/\\])+[\w.@-]+\.[A-Za-z0-9]{1,10})(?::(\d+))?(?::(\d+))?/;

/** Every distinct path the output mentions, in first-seen order. */
export function referencedPathsIn(raw: string): string[] {
  const found: string[] = [];
  for (const line of raw.split('\n')) {
    const match = PATH_LOCATION_PATTERN.exec(line);
    const candidate = match?.[1]?.replace(/\\/g, '/');
    if (candidate !== undefined && !found.includes(candidate)) found.push(candidate);
    if (found.length >= 100) break;
  }
  return found;
}

function tally(entries: readonly CompressionFinding[]): CompressionFinding[] {
  const byKey = new Map<string, CompressionFinding>();
  for (const entry of entries) {
    const existing = byKey.get(entry.key);
    if (existing === undefined) byKey.set(entry.key, { ...entry });
    else existing.count += entry.count;
  }
  // Most frequent first; ties break on key so ordering is deterministic.
  return [...byKey.values()].sort((left, right) =>
    right.count !== left.count ? right.count - left.count : left.key < right.key ? -1 : 1,
  );
}

function renderFindings(title: string, findings: readonly CompressionFinding[]): string[] {
  if (findings.length === 0) return [];
  const lines = [`${title} (${findings.length} distinct):`];
  for (const finding of findings.slice(0, COMPRESSION_LIMITS.maxFindingsListed)) {
    const where =
      finding.path !== undefined
        ? ` [${finding.path}${finding.line !== undefined ? `:${finding.line}` : ''}]`
        : '';
    const repeat = finding.count > 1 ? ` ×${finding.count}` : '';
    const message = finding.message !== undefined ? ` — ${finding.message}` : '';
    lines.push(`- ${finding.key}${where}${repeat}${message}`);
  }
  if (findings.length > COMPRESSION_LIMITS.maxFindingsListed) {
    lines.push(`- … ${findings.length - COMPRESSION_LIMITS.maxFindingsListed} further distinct entries omitted`);
  }
  return lines;
}

/**
 * The identity block: the first distinct meaningful lines, verbatim.
 *
 * This is what keeps a failure IDENTIFIABLE after compression. It is taken
 * from the head because that is where every test runner, compiler, and
 * linter puts the first real error — and because taking a deterministic
 * prefix is the only selection rule that cannot reorder under repetition.
 */
function identityBlock(raw: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    lines.push(bound(trimmed));
    if (lines.length >= COMPRESSION_LIMITS.identityHeadLines) break;
  }
  return lines;
}

function finish(
  parts: readonly string[],
  method: ContextCompressionMethod,
  raw: string,
  findings: readonly CompressionFinding[],
  structured: boolean,
): CompressionResult {
  const body = parts.filter((part) => part !== '').join('\n');
  const text =
    body.length <= COMPRESSION_LIMITS.maxOutputChars
      ? body
      : `${body.slice(0, COMPRESSION_LIMITS.maxOutputChars - 40)}\n… [compressed representation truncated] …`;
  return {
    text,
    method,
    sourceBytes: Buffer.byteLength(raw, 'utf8'),
    compressedBytes: Buffer.byteLength(text, 'utf8'),
    findings: [...findings],
    referencedPaths: referencedPathsIn(raw),
    sourceHash: hashOf(raw),
    structured,
  };
}

// ---------------------------------------------------------------------------
// Test output
// ---------------------------------------------------------------------------

const TEST_FAIL_PATTERNS: readonly RegExp[] = [
  /^\s*(?:FAIL|✕|×|✗|✖)\s+(.+)$/,
  /^\s*(?:not ok)\s+\d+\s+-?\s*(.+)$/,
  /^\s*(?:FAILED|ERROR)\s+(.+?)(?:\s+-\s+.*)?$/,
  /^\s*\d+\)\s+(.+)$/,
  /^\s*(.+?)\s+›\s+(.+?)\s+(?:failed|FAILED)$/,
];
const TEST_SUMMARY_PATTERN =
  /(?:Tests?|Test Files|Suites?|Specs?)\b[^\n]*?(\d+)\s*(?:failed|failing)[^\n]*/i;
const ASSERTION_PATTERNS: readonly RegExp[] = [
  /^\s*(?:AssertionError|Error|TypeError|ReferenceError|RangeError|SyntaxError)(?::|\s)\s*(.+)$/,
  /^\s*(?:Expected|expected)[:\s]+(.+)$/,
  /^\s*(?:Received|received|Actual|actual)[:\s]+(.+)$/,
];
const STACK_FRAME_PATTERN = /^\s*(?:at\s+|File\s+")(.+)$/;

/**
 * Compress test output to what a repair attempt actually acts on: which
 * tests failed, what the assertion said, where it happened, and how often.
 *
 * A thousand repetitions of the same failure collapse to one entry with a
 * count — the count itself is signal (a loop, a parameterized suite), and
 * it survives where the thousand copies would not have fitted at all.
 */
export function compressTestOutput(raw: string): CompressionResult {
  const scanned = raw.slice(0, COMPRESSION_LIMITS.maxScanChars);
  const lines = scanned.split('\n');

  const failures: CompressionFinding[] = [];
  const assertions: CompressionFinding[] = [];
  const frames: CompressionFinding[] = [];
  let summary: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    if (summary === undefined) {
      const summaryMatch = TEST_SUMMARY_PATTERN.exec(trimmed);
      if (summaryMatch !== null) summary = bound(summaryMatch[0]);
    }

    for (const pattern of TEST_FAIL_PATTERNS) {
      const match = pattern.exec(line);
      if (match === null) continue;
      const name = bound([match[1], match[2]].filter((part) => part !== undefined).join(' › '));
      if (name === '') break;
      const location = PATH_LOCATION_PATTERN.exec(name);
      failures.push({
        key: name,
        count: 1,
        ...(location?.[1] !== undefined ? { path: location[1].replace(/\\/g, '/') } : {}),
        ...(location?.[2] !== undefined ? { line: Number(location[2]) } : {}),
      });
      break;
    }

    for (const pattern of ASSERTION_PATTERNS) {
      const match = pattern.exec(line);
      if (match?.[1] !== undefined) {
        assertions.push({ key: bound(trimmed), count: 1 });
        break;
      }
    }

    if (frames.length < COMPRESSION_LIMITS.maxFindingsListed) {
      const frame = STACK_FRAME_PATTERN.exec(line);
      if (frame?.[1] !== undefined && /[/\\]/.test(frame[1])) {
        frames.push({ key: bound(frame[1]), count: 1 });
      }
    }
  }

  const failureFindings = tally(failures);
  const assertionFindings = tally(assertions);
  const frameFindings = tally(frames).slice(0, COMPRESSION_LIMITS.maxFindingsListed);
  const structured = failureFindings.length > 0 || assertionFindings.length > 0;

  const parts = [
    '## Test output (deterministically compressed)',
    summary !== undefined ? `Summary: ${summary}` : '',
    `Raw output: ${lines.length} line(s), ${raw.length} characters.`,
    ...renderFindings('Failing tests', failureFindings),
    ...renderFindings('Assertions', assertionFindings.slice(0, COMPRESSION_LIMITS.maxFindingsListed)),
    ...renderFindings('First stack frames', frameFindings),
    '',
    'Leading output, verbatim (failure identity):',
    ...identityBlock(scanned).map((line) => `> ${line}`),
  ];
  return finish(parts, 'test-log-v1', raw, [...failureFindings, ...assertionFindings], structured);
}

// ---------------------------------------------------------------------------
// Compiler / typecheck output
// ---------------------------------------------------------------------------

const COMPILER_PATTERNS: readonly RegExp[] = [
  // tsc: path(line,col): error TS1234: message
  /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+([A-Za-z]+\d+):\s*(.+)$/,
  // gcc/clang/rustc/go: path:line:col: error[E0308]: message
  /^(.+?):(\d+):(?:(\d+):)?\s*(error|warning)(?:\[([A-Za-z0-9]+)\])?:\s*(.+)$/,
  // javac: path:line: error: message
  /^(.+?):(\d+):\s*(error|warning):\s*(.+)$/,
];

/** Compress compiler/typecheck output to code, file, line, and message. */
export function compressCompilerOutput(raw: string): CompressionResult {
  const scanned = raw.slice(0, COMPRESSION_LIMITS.maxScanChars);
  const diagnostics: CompressionFinding[] = [];

  for (const line of scanned.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    for (const pattern of COMPILER_PATTERNS) {
      const match = pattern.exec(trimmed);
      if (match === null) continue;
      const groups = match.slice(1).filter((group) => group !== undefined) as string[];
      const filePath = (groups[0] ?? '').replace(/\\/g, '/');
      const lineNumber = Number(groups[1] ?? 0);
      const code = groups.find((group) => /^[A-Za-z]+\d+$/.test(group));
      const message = bound(groups[groups.length - 1] ?? '');
      diagnostics.push({
        key: code ?? message,
        count: 1,
        path: filePath,
        line: Number.isFinite(lineNumber) ? lineNumber : undefined,
        message,
      });
      break;
    }
  }

  const byCode = tally(diagnostics.map((entry) => ({ ...entry, count: 1 })));
  const structured = diagnostics.length > 0;
  const parts = [
    '## Compiler output (deterministically compressed)',
    `Raw output: ${scanned.split('\n').length} line(s), ${raw.length} characters. ${diagnostics.length} diagnostic(s).`,
    ...renderFindings('Diagnostics by code', byCode),
    '',
    'Leading output, verbatim (failure identity):',
    ...identityBlock(scanned).map((line) => `> ${line}`),
  ];
  return finish(parts, 'compiler-log-v1', raw, byCode, structured);
}

// ---------------------------------------------------------------------------
// Lint output
// ---------------------------------------------------------------------------

const LINT_PATTERNS: readonly RegExp[] = [
  // eslint stylish: "  12:5  error  message  rule/name"
  /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}([\w@/-]+)\s*$/,
  // flake8/ruff/pylint: path:line:col: CODE message
  /^(.+?):(\d+):(?:(\d+):)?\s*([A-Z]+\d+)\s+(.+)$/,
];

/** Compress lint output to rule, location, and message with per-rule counts. */
export function compressLintOutput(raw: string): CompressionResult {
  const scanned = raw.slice(0, COMPRESSION_LIMITS.maxScanChars);
  const findings: CompressionFinding[] = [];
  let currentPath: string | undefined;

  for (const line of scanned.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed.trim() === '') continue;
    // A bare path line is eslint's stylish file header.
    if (/^[^\s].*\.[A-Za-z0-9]{1,10}$/.test(trimmed) && !/\s{2,}/.test(trimmed)) {
      currentPath = trimmed.replace(/\\/g, '/');
      continue;
    }
    const stylish = LINT_PATTERNS[0]?.exec(trimmed);
    if (stylish !== null && stylish !== undefined) {
      findings.push({
        key: stylish[5] ?? 'unknown-rule',
        count: 1,
        ...(currentPath !== undefined ? { path: currentPath } : {}),
        line: Number(stylish[1]),
        message: bound(stylish[4] ?? ''),
      });
      continue;
    }
    const coded = LINT_PATTERNS[1]?.exec(trimmed);
    if (coded !== null && coded !== undefined) {
      findings.push({
        key: coded[4] ?? 'unknown-rule',
        count: 1,
        path: (coded[1] ?? '').replace(/\\/g, '/'),
        line: Number(coded[2]),
        message: bound(coded[5] ?? ''),
      });
    }
  }

  const byRule = tally(findings);
  const parts = [
    '## Lint output (deterministically compressed)',
    `Raw output: ${scanned.split('\n').length} line(s), ${raw.length} characters. ${findings.length} finding(s).`,
    ...renderFindings('Findings by rule', byRule),
    '',
    'Leading output, verbatim (failure identity):',
    ...identityBlock(scanned).map((line) => `> ${line}`),
  ];
  return finish(parts, 'lint-log-v1', raw, byRule, findings.length > 0);
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * Compress a unified diff to its structural shape: which files changed, by
 * how much, and which declarations the hunks touched.
 *
 * Deliberately keeps hunk headers rather than hunk bodies. A hunk header
 * (`@@ … @@ function foo`) tells a reviewer WHERE the change is; the body is
 * recoverable from Git at any time, which is the definition of context that
 * does not need to be in the prompt.
 */
export function compressDiff(raw: string): CompressionResult {
  const scanned = raw.slice(0, COMPRESSION_LIMITS.maxScanChars);
  const files: CompressionFinding[] = [];
  const hunks: string[] = [];
  let currentFile: string | undefined;
  let insertions = 0;
  let deletions = 0;
  let fileInsertions = 0;
  let fileDeletions = 0;

  const flush = (): void => {
    if (currentFile === undefined) return;
    files.push({
      key: currentFile,
      count: 1,
      path: currentFile,
      message: `+${fileInsertions}/-${fileDeletions}`,
    });
    fileInsertions = 0;
    fileDeletions = 0;
  };

  for (const line of scanned.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      const match = /\sb\/(.+)$/.exec(line);
      currentFile = match?.[1]?.replace(/\\/g, '/');
      continue;
    }
    if (line.startsWith('+++ b/')) {
      if (currentFile === undefined) currentFile = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('@@')) {
      if (hunks.length < COMPRESSION_LIMITS.maxFindingsListed) {
        hunks.push(`${currentFile ?? '(unknown file)'}: ${bound(line)}`);
      }
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      insertions += 1;
      fileInsertions += 1;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      deletions += 1;
      fileDeletions += 1;
    }
  }
  flush();

  const parts = [
    '## Diff (deterministically compressed)',
    `${files.length} file(s) changed, ${insertions} insertion(s), ${deletions} deletion(s). Raw diff: ${raw.length} characters.`,
    ...renderFindings('Files changed', files),
    hunks.length > 0 ? 'Hunks:' : '',
    ...hunks.map((hunk) => `- ${hunk}`),
    '',
    'The full diff remains available from Git and from the run artifact.',
  ];
  return finish(parts, 'diff-summary-v1', raw, files, files.length > 0);
}

// ---------------------------------------------------------------------------
// Repetition collapse (the general fallback)
// ---------------------------------------------------------------------------

/**
 * Collapse repeated lines to a signature plus a count.
 *
 * The general-purpose reducer, and the one that answers §96 directly: a log
 * that repeats the same error a thousand times becomes one line and a count.
 * Volatile substrings (timestamps, hex ids, durations) are masked BEFORE
 * grouping, so lines that differ only in noise are recognised as the same
 * line — and the mask list is the same shape the failure fingerprint uses,
 * which is what keeps the two views of a failure consistent.
 */
export function collapseRepetition(raw: string): CompressionResult {
  const scanned = raw.slice(0, COMPRESSION_LIMITS.maxScanChars);
  const lines = scanned.split('\n');
  const order: string[] = [];
  const counts = new Map<string, number>();
  const examples = new Map<string, string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const signature = trimmed
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<TIMESTAMP>')
      .replace(/\b[0-9a-f]{7,64}\b/gi, '<HEX>')
      .replace(/\d+(\.\d+)?\s?(ms|s|sec|seconds)\b/gi, '<DURATION>')
      .replace(/\b\d{3,}\b/g, '<N>')
      .replace(/[ \t]+/g, ' ');
    if (!counts.has(signature)) {
      order.push(signature);
      examples.set(signature, bound(trimmed));
    }
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }

  const findings = order
    .map((signature) => ({
      key: examples.get(signature) ?? signature,
      count: counts.get(signature) ?? 1,
    }))
    .sort((left, right) =>
      right.count !== left.count ? right.count - left.count : left.key < right.key ? -1 : 1,
    );

  const parts = [
    '## Output (repetition collapsed)',
    `Raw output: ${lines.length} line(s), ${raw.length} characters; ${order.length} distinct line signature(s).`,
    ...renderFindings('Distinct lines by frequency', findings),
    '',
    'Leading output, verbatim (failure identity):',
    ...identityBlock(scanned).map((line) => `> ${line}`),
  ];
  // Collapsing is only a real structural win when there IS repetition.
  const structured = order.length > 0 && order.length < lines.length / 2;
  return finish(parts, 'repetition-collapse-v1', raw, findings, structured);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Artifact classes the deterministic compressors know how to read. */
export type CompressibleArtifactKind =
  | 'test-output'
  | 'compiler-output'
  | 'lint-output'
  | 'diff'
  | 'generic';

/**
 * Classify an artifact from its declared kind and its own leading bytes.
 *
 * The declared kind leads; content sniffing only fills the gap for the
 * generic case, and it errs toward `generic` (which collapses repetition
 * safely) rather than toward a parser that might mis-read the output.
 */
export function classifyArtifact(kind: string, content: string): CompressibleArtifactKind {
  const normalized = kind.toLowerCase();
  if (normalized.includes('diff') || normalized.includes('patch')) return 'diff';
  if (normalized.includes('lint')) return 'lint-output';
  if (normalized.includes('test') || normalized.includes('spec')) return 'test-output';
  if (normalized.includes('compile') || normalized.includes('typecheck') || normalized.includes('build')) {
    return 'compiler-output';
  }
  const head = content.slice(0, 4_000);
  if (/^diff --git |^--- a\/|^\+\+\+ b\//m.test(head)) return 'diff';
  if (/\((\d+),(\d+)\):\s*error\s+[A-Za-z]+\d+:/m.test(head)) return 'compiler-output';
  if (/^\s*(FAIL|✕|not ok|\d+\)\s)/m.test(head)) return 'test-output';
  return 'generic';
}

/**
 * Compress one artifact deterministically.
 *
 * Returns undefined when the input is too small to be worth compressing —
 * spending compute to turn a 500-byte error into a 450-byte summary is a
 * loss on both axes.
 */
export function compressArtifact(input: {
  kind: string;
  content: string;
  minChars?: number | undefined;
}): CompressionResult | undefined {
  if (!isWorthCompressing(input.content, input.minChars)) return undefined;
  switch (classifyArtifact(input.kind, input.content)) {
    case 'test-output':
      return compressTestOutput(input.content);
    case 'compiler-output':
      return compressCompilerOutput(input.content);
    case 'lint-output':
      return compressLintOutput(input.content);
    case 'diff':
      return compressDiff(input.content);
    default:
      return collapseRepetition(input.content);
  }
}
