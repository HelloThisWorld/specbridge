import type { Command } from 'commander';
import { CLI_BIN } from '@specbridge/core';
import { builtInVerificationRules, describeDefaultSeverity, findRule } from '@specbridge/drift';
import {
  createJsonReport,
  dim,
  renderColumns,
  reportTitle,
  sectionTitle,
  serializeJsonReport,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { VERSION } from '../version.js';

/**
 * `specbridge verify rules` / `specbridge verify explain <rule-id>` —
 * deterministic, read-only inspection of the built-in verification rules.
 */

interface RulesOptions {
  json?: boolean;
}

export function registerVerifyRuleCommands(program: Command, runtime: CliRuntime): void {
  const verify = program
    .command('verify')
    .description('Inspect the deterministic verification rules (read-only)');

  verify
    .command('rules')
    .description('List every built-in verification rule with its stable ID')
    .option('--json', 'output a machine-readable JSON report')
    .action((options: RulesOptions) => {
      const rules = builtInVerificationRules();
      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.verify-rules/1', `${CLI_BIN} ${VERSION}`, {
              rules: rules.map((rule) => ({
                id: rule.id,
                title: rule.title,
                category: rule.category,
                scope: rule.scope,
                confidence: rule.confidence,
                defaultSeverity: rule.defaultSeverity,
              })),
            }),
          ),
        );
        return;
      }
      runtime.out(reportTitle(`Verification rules (${rules.length})`));
      runtime.out();
      const rows = rules.map((rule) => [
        rule.id,
        rule.defaultSeverity.advisory === rule.defaultSeverity.strict
          ? rule.defaultSeverity.advisory
          : `${rule.defaultSeverity.advisory}/${rule.defaultSeverity.strict}`,
        rule.category,
        rule.confidence === 'heuristic' ? `${rule.title} (heuristic)` : rule.title,
      ]);
      for (const line of renderColumns(rows)) runtime.out(line);
      runtime.out();
      runtime.out(dim(`Severity column shows advisory/strict defaults; policies may override per rule.`));
      runtime.out(dim(`Details: ${CLI_BIN} verify explain <rule-id>`));
    });

  verify
    .command('explain <rule-id>')
    .description('Explain one verification rule: trigger, defaults, and resolution')
    .option('--json', 'output a machine-readable JSON report')
    .action((ruleId: string, options: RulesOptions) => {
      const rule = findRule(ruleId);
      if (rule === undefined) {
        runtime.err(
          `Unknown rule "${ruleId}". Valid IDs run SBV001–SBV025; list them with "${CLI_BIN} verify rules".`,
        );
        runtime.exitCode = 2;
        return;
      }
      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.verify-explain/1', `${CLI_BIN} ${VERSION}`, {
              id: rule.id,
              title: rule.title,
              category: rule.category,
              scope: rule.scope,
              confidence: rule.confidence,
              defaultSeverity: rule.defaultSeverity,
              triggeredWhen: rule.triggeredWhen,
              resolution: rule.resolution,
            }),
          ),
        );
        return;
      }
      runtime.out(reportTitle(`${rule.id} — ${rule.title}`));
      runtime.out();
      runtime.out(sectionTitle('Default severity'));
      runtime.out(`  ${describeDefaultSeverity(rule)}`);
      runtime.out();
      runtime.out(sectionTitle('Category'));
      runtime.out(`  ${rule.category} (${rule.confidence}, ${rule.scope}-scoped)`);
      runtime.out();
      runtime.out(sectionTitle('Triggered when'));
      runtime.out(`  ${rule.triggeredWhen}`);
      runtime.out();
      runtime.out(sectionTitle('Resolution'));
      runtime.out(`  ${rule.resolution}`);
    });
}
