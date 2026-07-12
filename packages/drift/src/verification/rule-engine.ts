import type {
  VerificationCategory,
  VerificationConfidence,
  VerificationDiagnostic,
  VerificationSeverity,
} from '@specbridge/core';
import { VERIFICATION_DIAGNOSTIC_SCHEMA_VERSION } from '@specbridge/core';
import type { EffectivePolicy } from './policy.js';
import type { GlobalVerificationContext, SpecVerificationContext } from './context.js';

/**
 * Deterministic verification rule engine.
 *
 * Rules are pure functions over a pre-assembled context: no rule touches the
 * file system for spec content (parsed once during context building), no
 * rule executes anything, and no rule may write. Rule IDs are stable and
 * never silently renumbered; the registry order is the documentation order.
 */

export interface ResolvedRuleConfig {
  enabled: boolean;
  severity: VerificationSeverity;
  /** True when the severity comes from an explicit policy override. */
  overridden: boolean;
}

interface RuleBase {
  readonly id: string;
  readonly title: string;
  readonly category: VerificationCategory;
  /** Default severity per policy mode; heuristic rules may not default to error. */
  readonly defaultSeverity: { advisory: VerificationSeverity; strict: VerificationSeverity };
  readonly confidence: VerificationConfidence;
  /** One-paragraph trigger description for `verify explain`. */
  readonly triggeredWhen: string;
  /** Default remediation for `verify explain` and diagnostics. */
  readonly resolution: string;
}

export interface SpecVerificationRule extends RuleBase {
  readonly scope: 'spec';
  evaluate(
    context: SpecVerificationContext,
    resolved: ResolvedRuleConfig,
  ): VerificationDiagnostic[] | Promise<VerificationDiagnostic[]>;
}

export interface GlobalVerificationRule extends RuleBase {
  readonly scope: 'global';
  evaluate(
    context: GlobalVerificationContext,
    resolved: ResolvedRuleConfig,
  ): VerificationDiagnostic[] | Promise<VerificationDiagnostic[]>;
}

export type VerificationRule = SpecVerificationRule | GlobalVerificationRule;

/** Resolve one rule's configuration against a spec's effective policy. */
export function resolveRuleConfig(
  rule: RuleBase,
  policy: Pick<EffectivePolicy, 'mode' | 'ruleOverrides'>,
): ResolvedRuleConfig {
  const override = policy.ruleOverrides[rule.id];
  const severity = override?.severity ?? rule.defaultSeverity[policy.mode];
  return {
    enabled: override?.enabled ?? true,
    severity,
    overridden: override?.severity !== undefined,
  };
}

const SEVERITY_ORDER: Record<VerificationSeverity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Resolve a global rule against every selected spec's policy: the rule is
 * disabled only when every policy disables it, and the strictest severity
 * wins (a global finding must not be weakened by one lenient spec).
 */
export function resolveGlobalRuleConfig(
  rule: RuleBase,
  policies: readonly Pick<EffectivePolicy, 'mode' | 'ruleOverrides'>[],
): ResolvedRuleConfig {
  if (policies.length === 0) {
    return { enabled: true, severity: rule.defaultSeverity.advisory, overridden: false };
  }
  const resolved = policies.map((policy) => resolveRuleConfig(rule, policy));
  const enabled = resolved.some((config) => config.enabled);
  const strictest = resolved.reduce((best, config) =>
    SEVERITY_ORDER[config.severity] < SEVERITY_ORDER[best.severity] ? config : best,
  );
  return { enabled, severity: strictest.severity, overridden: strictest.overridden };
}

export interface DiagnosticInput {
  rule: RuleBase;
  severity: VerificationSeverity;
  message: string;
  remediation?: string;
  specName?: string | null;
  taskId?: string | null;
  requirementId?: string | null;
  file?: { path: string; line?: number | null; column?: number | null } | null;
  evidence?: Record<string, unknown>;
  /** Override the rule's predominant confidence for this one finding. */
  confidence?: VerificationConfidence;
}

/** Build a schema-complete diagnostic from rule metadata plus specifics. */
export function makeDiagnostic(input: DiagnosticInput): VerificationDiagnostic {
  const file =
    input.file === null || input.file === undefined
      ? null
      : {
          path: input.file.path,
          line: input.file.line ?? null,
          column: input.file.column ?? null,
        };
  return {
    schemaVersion: VERIFICATION_DIAGNOSTIC_SCHEMA_VERSION,
    ruleId: input.rule.id,
    title: input.rule.title,
    severity: input.severity,
    category: input.rule.category,
    message: input.message,
    remediation: input.remediation ?? input.rule.resolution,
    specName: input.specName ?? null,
    taskId: input.taskId ?? null,
    requirementId: input.requirementId ?? null,
    file,
    evidence: input.evidence ?? {},
    confidence: input.confidence ?? input.rule.confidence,
  };
}

/** Human-readable default-severity description for `verify explain`. */
export function describeDefaultSeverity(rule: RuleBase): string {
  if (rule.defaultSeverity.advisory === rule.defaultSeverity.strict) {
    return rule.defaultSeverity.advisory;
  }
  return `${rule.defaultSeverity.advisory} in advisory mode, ${rule.defaultSeverity.strict} in strict mode`;
}

export interface RuleEngineResult {
  diagnostics: VerificationDiagnostic[];
  /** Rules skipped because a policy disabled them. */
  disabledRules: string[];
}

/** Evaluate every enabled spec-scoped rule against one spec context. */
export async function evaluateSpecRules(
  rules: readonly VerificationRule[],
  context: SpecVerificationContext,
): Promise<RuleEngineResult> {
  const diagnostics: VerificationDiagnostic[] = [];
  const disabledRules: string[] = [];
  for (const rule of rules) {
    if (rule.scope !== 'spec') continue;
    const resolved = resolveRuleConfig(rule, context.policy);
    if (!resolved.enabled) {
      disabledRules.push(rule.id);
      continue;
    }
    diagnostics.push(...(await rule.evaluate(context, resolved)));
  }
  return { diagnostics, disabledRules };
}

/** Evaluate every enabled global rule once for the whole run. */
export async function evaluateGlobalRules(
  rules: readonly VerificationRule[],
  context: GlobalVerificationContext,
): Promise<RuleEngineResult> {
  const policies = context.specContexts.map((spec) => spec.policy);
  const diagnostics: VerificationDiagnostic[] = [];
  const disabledRules: string[] = [];
  for (const rule of rules) {
    if (rule.scope !== 'global') continue;
    const resolved = resolveGlobalRuleConfig(rule, policies);
    if (!resolved.enabled) {
      disabledRules.push(rule.id);
      continue;
    }
    diagnostics.push(...(await rule.evaluate(context, resolved)));
  }
  return { diagnostics, disabledRules };
}
