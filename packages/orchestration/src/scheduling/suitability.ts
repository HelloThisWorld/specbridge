import type { ComplexityClass } from '../jobs/vocabulary.js';
import type { LocalSuitabilityClass } from './vocabulary.js';

/**
 * Deterministic local-suitability classification (vNext.2).
 *
 * The first-version rule set, exactly as specified: deterministic heuristics
 * over task metadata — no learned scheduler, no model in the loop. The
 * output decides which lane ATTEMPTS the work first; deterministic
 * verification decides whether the attempt stands.
 *
 * The load-bearing criterion for LOCAL_TRY is not perceived difficulty but
 * verifiability: an imperfect local implementation is acceptable exactly
 * when compile/tests catch imperfection cheaply. Without deterministic
 * verification, local code output would need strong-model review — which
 * spends the quota local execution exists to save — so unverifiable work
 * never classifies LOCAL_TRY.
 */

export interface SuitabilityInput {
  taskId: string;
  title: string;
  complexity: ComplexityClass | undefined;
  /** Bounded related requirement/design excerpt, when available. */
  relatedSpecText?: string | undefined;
  /** Whether trusted verification commands exist for this workspace/spec. */
  deterministicVerificationAvailable: boolean;
  /** Whether a healthy local worker is configured at all. */
  localWorkerAvailable: boolean;
  /** LOCAL-lane executor attempts already spent on this task. */
  localAttemptsUsed?: number | undefined;
  /** Bounded local attempts allowed (policy). */
  maxLocalAttempts?: number | undefined;
}

export interface SuitabilitySignal {
  signal: string;
  evidence: string;
}

export interface SuitabilityAssessment {
  class: LocalSuitabilityClass;
  /** Coarse task category recorded on attempts/ledger for burn grouping. */
  category: string;
  signals: SuitabilitySignal[];
}

/**
 * Category tables: documented data, not clever heuristics. Word-boundary
 * matched, case-insensitive, first match wins within a table. Editing these
 * changes routing policy and is test-visible.
 */
const LOCAL_SAFE_PATTERNS: readonly { category: string; pattern: RegExp }[] = [
  { category: 'summarization', pattern: /\b(summari[sz]e|summary|digest)\b/i },
  { category: 'log-processing', pattern: /\b(parse|cluster|triage)\b.*\blogs?\b|\blogs?\b.*\b(parse|parsing|clustering|triage)\b/i },
  { category: 'classification', pattern: /\b(classif\w+|categori[sz]\w+|label(?:ing)?)\b/i },
  { category: 'ranking', pattern: /\b(rank(?:ing)?|relevance|prioriti[sz]e)\b/i },
  { category: 'extraction', pattern: /\b(extract\w*|symbol extraction|structured extraction)\b/i },
  { category: 'compression', pattern: /\b(compress\w*|compact\w*|condense)\b/i },
  { category: 'duplicate-detection', pattern: /\b(duplicate|de-?dup\w*)\b/i },
  { category: 'reporting', pattern: /\b(report|test result summar\w+|diff summar\w+)\b/i },
];

const LOCAL_TRY_PATTERNS: readonly { category: string; pattern: RegExp }[] = [
  { category: 'boilerplate', pattern: /\b(boilerplate|scaffold\w*|stub\w*)\b/i },
  { category: 'data-object', pattern: /\b(dto|data object|data class|record type|value object)\b/i },
  { category: 'mapper', pattern: /\b(mapper|mapping function|converter)\b/i },
  { category: 'rename', pattern: /\b(rename|renaming)\b/i },
  { category: 'mechanical-refactor', pattern: /\b(mechanical refactor\w*|repetitive|find-and-replace)\b/i },
  { category: 'config-change', pattern: /\b(configuration change|config value|configuration option|config flag)\b/i },
  { category: 'unit-test', pattern: /\b(unit tests?|test case|repetitive tests?)\b/i },
  { category: 'validation', pattern: /\b(validation|validator)\b/i },
  { category: 'documentation', pattern: /\b(documentation|docs?|readme|changelog|comment)\b/i },
  { category: 'simple-change', pattern: /\b(simple|small|trivial|minor|straightforward)\b/i },
];

/** Classify one task. Pure and deterministic; same input, same output. */
export function classifyLocalSuitability(input: SuitabilityInput): SuitabilityAssessment {
  const signals: SuitabilitySignal[] = [];
  const text = `${input.title}\n${input.relatedSpecText ?? ''}`;

  if (!input.localWorkerAvailable) {
    signals.push({ signal: 'no-local-worker', evidence: 'no healthy local worker is configured' });
    return { class: 'STRONG_REQUIRED', category: 'general', signals };
  }

  // Bounded local retries: once the budget is spent, escalation is
  // mandatory — the local lane never loops on the same task indefinitely.
  const attemptsUsed = input.localAttemptsUsed ?? 0;
  const maxAttempts = input.maxLocalAttempts ?? 2;
  if (attemptsUsed >= maxAttempts) {
    signals.push({
      signal: 'local-attempts-exhausted',
      evidence: `${attemptsUsed}/${maxAttempts} local attempts used`,
    });
    return { class: 'STRONG_REQUIRED', category: 'escalated', signals };
  }

  // HIGH complexity work routes straight to the strong lane: architecture,
  // security, cross-module, and repeated-failure signals all land in HIGH
  // through the deterministic complexity model, and re-listing its keyword
  // tables here would create a second drifting copy of the same policy.
  if (input.complexity === 'HIGH') {
    signals.push({ signal: 'complexity-high', evidence: 'deterministic complexity class is HIGH' });
    return { class: 'STRONG_REQUIRED', category: 'strong', signals };
  }

  for (const entry of LOCAL_SAFE_PATTERNS) {
    const match = text.match(entry.pattern);
    if (match !== null) {
      signals.push({
        signal: `local-safe:${entry.category}`,
        evidence: `matched "${(match[0] ?? '').slice(0, 80)}"`,
      });
      return { class: 'LOCAL_SAFE', category: entry.category, signals };
    }
  }

  for (const entry of LOCAL_TRY_PATTERNS) {
    const match = text.match(entry.pattern);
    if (match !== null) {
      signals.push({
        signal: `local-try:${entry.category}`,
        evidence: `matched "${(match[0] ?? '').slice(0, 80)}"`,
      });
      if (!input.deterministicVerificationAvailable && entry.category !== 'documentation') {
        // Imperfect local output is only acceptable when verification is
        // cheap and deterministic; without it, the work routes strong.
        signals.push({
          signal: 'no-deterministic-verification',
          evidence: 'no trusted verification commands are configured',
        });
        return { class: 'STRONG_REQUIRED', category: entry.category, signals };
      }
      // MEDIUM-complexity work is not "simple X" however the title reads.
      if (input.complexity === 'MEDIUM') {
        signals.push({
          signal: 'complexity-medium',
          evidence: 'MEDIUM complexity overrides a local-try keyword match',
        });
        return { class: 'STRONG_REQUIRED', category: entry.category, signals };
      }
      return { class: 'LOCAL_TRY', category: entry.category, signals };
    }
  }

  signals.push({ signal: 'no-local-category', evidence: 'no local-safe or local-try category matched' });
  return { class: 'STRONG_REQUIRED', category: 'general', signals };
}
