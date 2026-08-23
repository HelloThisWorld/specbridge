import type { ProtectedControlPlaneInvariant } from '../vocabulary.js';

/**
 * The invariant screen for control-plane patches.
 *
 * Pure, deterministic, and deliberately paranoid. It reads a unified diff
 * and asks one question: *does this patch weaken something SpecBridge
 * promises?* Every pattern below corresponds to a promise a previous phase
 * made, and each is written to catch the REMOVAL or LOOSENING of the check
 * rather than its mere presence — a repair that legitimately touches the
 * authority firewall to fix a typo in a message should not be rejected, and
 * a repair that deletes a `throw` from it must be.
 *
 * Two design notes.
 *
 * It screens ADDED and REMOVED lines separately. An added `bypassPermissions`
 * is a violation; a removed `assertProtectedPaths(...)` is a violation; a
 * removed comment mentioning permissions is not. Conflating the two produces
 * either constant false positives or a screen that misses the actual attack.
 *
 * It errs towards REJECTING. A false positive costs one repair attempt and a
 * clear message; a false negative is an agent that disabled its own
 * verification gate at 4am to make a failing task pass. Those are not
 * symmetric.
 */

export interface DiffHunkLine {
  kind: 'added' | 'removed' | 'context';
  file: string;
  text: string;
}

export interface InvariantViolation {
  invariant: ProtectedControlPlaneInvariant;
  file: string;
  evidence: string;
}

/** Patterns whose APPEARANCE in an added line is a violation. */
const ADDED_PATTERNS: readonly { invariant: ProtectedControlPlaneInvariant; pattern: RegExp }[] = [
  { invariant: 'PERMISSION_BYPASS', pattern: /dangerously[-_]skip[-_]permissions/i },
  { invariant: 'PERMISSION_BYPASS', pattern: /bypassPermissions/ },
  { invariant: 'PERMISSION_BYPASS', pattern: /danger-full-access|--yolo/i },
  { invariant: 'SPEND_AUTHORIZATION', pattern: /spendMode\s*[:=]\s*['"]?AUTO_BOUNDED/ },
  { invariant: 'SPEND_AUTHORIZATION', pattern: /maxCostPer\w+Usd\s*[:=]\s*null/ },
  { invariant: 'COMPLETION_ORACLE', pattern: /mayComplete\s*[:=]\s*true/ },
  { invariant: 'EVIDENCE_REQUIREMENT', pattern: /skip(?:ping)?[ _]?(?:the )?verification/i },
  { invariant: 'APPROVAL_AUTHORITY', pattern: /approve(?:Stage|Spec)\w*\s*\(/ },
];

/**
 * Identifiers whose REMOVAL is a violation.
 *
 * These are the enforcement call sites: if a patch deletes a line containing
 * one and does not add an equivalent, the check it performed is gone.
 */
const GUARDED_IDENTIFIERS: readonly { invariant: ProtectedControlPlaneInvariant; token: RegExp }[] = [
  { invariant: 'PROTECTED_PATH_ENFORCEMENT', token: /assertInsideWorkspace|protectedPaths|isProtectedPath/ },
  { invariant: 'VERIFICATION_AUTHORITY', token: /requireVerifiedEvidence|evidenceStatus|assertEvidence/ },
  { invariant: 'APPROVAL_AUTHORITY', token: /assertApproved|approvalRequired|human-only/ },
  { invariant: 'SPEND_AUTHORIZATION', token: /consumeApiSpendApproval|reserveApiBudget|requestApiSpendApproval/ },
  { invariant: 'AUTHORITY_FIREWALL', token: /evaluateAuthority|assertAutonomousDecisionAllowed|escalateAuthority/ },
  { invariant: 'COMPLETION_ORACLE', token: /assertMissionMayComplete|missionMayComplete|isClosingEvidence/ },
  { invariant: 'EVIDENCE_REQUIREMENT', token: /CLOSING_EVIDENCE_KINDS|isClosingStatus/ },
];

/**
 * Screen a patch.
 *
 * `lines` is the parsed diff. Parsing is the caller's job because the diff
 * may come from git, from a runner's structured output, or from a test
 * fixture, and this function must stay pure enough to enumerate in a test.
 */
export function screenPatchForInvariants(lines: readonly DiffHunkLine[]): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const added = lines.filter((line) => line.kind === 'added');
  const removed = lines.filter((line) => line.kind === 'removed');

  for (const line of added) {
    for (const entry of ADDED_PATTERNS) {
      if (entry.pattern.test(line.text)) {
        violations.push({
          invariant: entry.invariant,
          file: line.file,
          evidence: `added: ${line.text.trim().slice(0, 200)}`,
        });
      }
    }
  }

  for (const line of removed) {
    for (const entry of GUARDED_IDENTIFIERS) {
      if (!entry.token.test(line.text)) continue;
      // A removal is only a violation when nothing added to the same file
      // restores it. A refactor that moves a guard is not a weakening.
      const restored = added.some(
        (candidate) => candidate.file === line.file && entry.token.test(candidate.text),
      );
      if (restored) continue;
      violations.push({
        invariant: entry.invariant,
        file: line.file,
        evidence: `removed without replacement: ${line.text.trim().slice(0, 200)}`,
      });
    }
  }

  return dedupe(violations);
}

function dedupe(violations: readonly InvariantViolation[]): InvariantViolation[] {
  const seen = new Set<string>();
  const out: InvariantViolation[] = [];
  for (const violation of violations) {
    const key = `${violation.invariant}:${violation.file}:${violation.evidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(violation);
  }
  return out;
}

/**
 * Parse a unified diff into screenable lines.
 *
 * Small and tolerant: a diff it cannot parse yields no lines, and a repair
 * whose diff could not be read is REFUSED by the caller rather than
 * screened as clean. "We could not look" must never be "we looked and it was
 * fine".
 */
export function parseUnifiedDiff(diff: string): DiffHunkLine[] {
  const lines: DiffHunkLine[] = [];
  let file = '';
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '').trim();
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('@@')) {
      continue;
    }
    if (file.length === 0) continue;
    if (raw.startsWith('+')) lines.push({ kind: 'added', file, text: raw.slice(1) });
    else if (raw.startsWith('-')) lines.push({ kind: 'removed', file, text: raw.slice(1) });
    else lines.push({ kind: 'context', file, text: raw.replace(/^ /, '') });
  }
  return lines;
}
