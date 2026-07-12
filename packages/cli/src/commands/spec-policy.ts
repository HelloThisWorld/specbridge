import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { MarkdownDocument, extractPathReferences, requireSpec, specFile } from '@specbridge/compat-kiro';
import { CLI_BIN, SpecBridgeError, readAgentConfig, writeFileAtomic } from '@specbridge/core';
import type { VerificationPolicy } from '@specbridge/drift';
import {
  VERIFICATION_POLICY_SCHEMA_VERSION,
  policyPath,
  readVerificationPolicy,
  resolveEffectivePolicy,
} from '@specbridge/drift';
import { listTaskEvidence } from '@specbridge/evidence';
import { readdirSync } from 'node:fs';
import {
  createJsonReport,
  dim,
  failLine,
  okLine,
  reportTitle,
  sectionTitle,
  serializeJsonReport,
  warnLine,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { relPath } from '../context.js';
import { VERSION } from '../version.js';

/**
 * `specbridge spec policy init|show|validate` — spec-specific verification
 * policy management. A policy file is plain configuration under
 * `.specbridge/policies/<spec>.json`; it is never a spec stage and needs no
 * approval. `init` is the only writing subcommand and never overwrites.
 */

interface PolicyInitOptions {
  mode?: string;
  dryRun?: boolean;
  json?: boolean;
}

interface PolicyReadOptions {
  json?: boolean;
}

function isInfrastructurePath(candidate: string): boolean {
  return (
    candidate.startsWith('.git') ||
    candidate.startsWith('.kiro/') ||
    candidate.startsWith('.specbridge/')
  );
}

/**
 * Propose impact areas from observed paths: the first two directory segments
 * become a `dir/**` pattern (top-level files stay exact). Proposals are
 * hints for review, never authoritative.
 */
export function proposeImpactAreas(paths: readonly string[]): string[] {
  const areas = new Set<string>();
  for (const candidate of paths) {
    const posix = candidate.split('\\').join('/');
    if (posix.length === 0 || isInfrastructurePath(posix)) continue;
    const segments = posix.split('/');
    if (segments.length === 1) {
      areas.add(posix);
      continue;
    }
    const depth = Math.min(2, segments.length - 1);
    areas.add(`${segments.slice(0, depth).join('/')}/**`);
  }
  return [...areas].sort((a, b) => a.localeCompare(b, 'en'));
}

function collectProposalSources(
  runtime: CliRuntime,
  specName: string,
): { paths: string[]; sources: string[] } {
  const workspace = runtime.workspace();
  const folder = requireSpec(workspace, specName);
  const paths: string[] = [];
  const sources: string[] = [];

  const design = specFile(folder, 'design');
  if (design !== undefined) {
    try {
      const references = extractPathReferences(MarkdownDocument.load(design.path));
      const explicit = references.filter((reference) => !reference.isGlob);
      if (explicit.length > 0) {
        paths.push(...explicit.map((reference) => reference.path));
        sources.push(`design.md (${explicit.length} explicit path reference${explicit.length === 1 ? '' : 's'})`);
      }
    } catch {
      // Unreadable design contributes nothing.
    }
  }

  const evidenceDir = path.join(workspace.sidecarDir, 'evidence', specName);
  if (existsSync(evidenceDir)) {
    let evidencePathCount = 0;
    for (const entry of readdirSync(evidenceDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const { records } = listTaskEvidence(workspace, specName, entry.name);
      for (const record of records) {
        if (record.status !== 'verified' && record.status !== 'manually-accepted') continue;
        for (const file of record.changedFiles) {
          paths.push(file.path);
          evidencePathCount += 1;
        }
      }
    }
    if (evidencePathCount > 0) {
      sources.push(`task evidence (${evidencePathCount} recorded file change${evidencePathCount === 1 ? '' : 's'})`);
    }
  }

  return { paths, sources };
}

export function registerSpecPolicyCommand(spec: Command, runtime: CliRuntime): void {
  const policy = spec
    .command('policy')
    .description('Manage spec-specific verification policies (.specbridge/policies/)');

  policy
    .command('init <name>')
    .description('Create a starter verification policy for a spec (never overwrites)')
    .option('--mode <mode>', 'advisory or strict', 'advisory')
    .option('--dry-run', 'print the proposed policy without writing it')
    .option('--json', 'output a machine-readable JSON report')
    .addHelpText(
      'after',
      `
Impact areas are proposed from explicit design.md path references and
recorded task evidence — they are hints, not authoritative facts. Review the
file before enforcing strict verification.

Example:
  ${CLI_BIN} spec policy init notification-preferences --mode strict`,
    )
    .action((name: string, options: PolicyInitOptions) => {
      const workspace = runtime.workspace();
      requireSpec(workspace, name);
      const mode = options.mode ?? 'advisory';
      if (mode !== 'advisory' && mode !== 'strict') {
        throw new SpecBridgeError(
          'INVALID_ARGUMENT',
          `--mode must be advisory or strict, got "${mode}".`,
        );
      }
      const filePath = policyPath(workspace, name);
      if (existsSync(filePath) && options.dryRun !== true) {
        throw new SpecBridgeError(
          'INVALID_STATE',
          `A verification policy already exists at ${relPath(workspace, filePath)}. ` +
            'Edit it directly, or delete it first — policy init never overwrites.',
        );
      }

      const { paths, sources } = collectProposalSources(runtime, name);
      const impactAreas = proposeImpactAreas(paths);
      const configRead = readAgentConfig(workspace);
      const requiredCommands = (configRead.config?.verification.commands ?? [])
        .filter((command) => command.required)
        .map((command) => command.name);

      const proposal: VerificationPolicy = {
        schemaVersion: VERIFICATION_POLICY_SCHEMA_VERSION,
        specName: name,
        mode,
        impactAreas,
        protectedPaths: [],
        requiredVerificationCommands: requiredCommands,
        requireVerifiedTaskEvidence: false,
        requireRequirementTaskLinks: false,
        requireTestEvidence: false,
        rules: {},
      };
      const serialized = `${JSON.stringify(proposal, null, 2)}\n`;

      if (options.dryRun !== true) {
        writeFileAtomic(filePath, serialized);
      }

      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.policy-init/1', `${CLI_BIN} ${VERSION}`, {
              specName: name,
              path: relPath(workspace, filePath),
              written: options.dryRun !== true,
              dryRun: options.dryRun === true,
              policy: proposal,
              proposalSources: sources,
            }),
          ),
        );
        return;
      }

      runtime.out(
        reportTitle(
          options.dryRun === true
            ? 'Verification policy proposal (dry run — nothing written):'
            : 'Verification policy created:',
        ),
      );
      runtime.out();
      runtime.out(`  ${relPath(workspace, filePath)}`);
      runtime.out();
      runtime.out(sectionTitle('Impact areas'));
      if (impactAreas.length === 0) {
        runtime.out(dim('  (none proposed — no explicit design paths or evidence found)'));
      } else {
        for (const area of impactAreas) runtime.out(`  ${area}`);
      }
      if (sources.length > 0) {
        runtime.out(dim(`  Proposed from: ${sources.join('; ')} — review before trusting.`));
      }
      runtime.out();
      runtime.out(sectionTitle('Required commands'));
      if (requiredCommands.length === 0) {
        runtime.out(dim('  (none — configure verification.commands in .specbridge/config.json)'));
      } else {
        for (const command of requiredCommands) runtime.out(`  ${command}`);
      }
      runtime.out();
      runtime.out('Review this file before enforcing strict verification.');
      if (options.dryRun === true) {
        runtime.out(dim('Dry run: no file was written.'));
      }
    });

  policy
    .command('show <name>')
    .description('Show the stored and effective verification policy for a spec (read-only)')
    .option('--json', 'output a machine-readable JSON report')
    .action((name: string, options: PolicyReadOptions) => {
      const workspace = runtime.workspace();
      requireSpec(workspace, name);
      const read = readVerificationPolicy(workspace, name);
      const configRead = readAgentConfig(workspace);
      const effective = resolveEffectivePolicy(workspace, name, {
        globalProtectedPaths: configRead.config?.execution.protectedPaths ?? [],
      });

      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.policy-show/1', `${CLI_BIN} ${VERSION}`, {
              specName: name,
              path: relPath(workspace, read.path),
              exists: read.exists,
              policy: read.policy ?? null,
              diagnostics: read.diagnostics,
              effective,
            }),
          ),
        );
        return;
      }

      runtime.out(reportTitle(`Verification policy: ${name}`));
      runtime.out(dim(`  ${relPath(workspace, read.path)}${read.exists ? '' : ' (not present — defaults apply)'}`));
      for (const diagnostic of read.diagnostics) {
        runtime.out(failLine(diagnostic.message));
      }
      runtime.out();
      runtime.out(sectionTitle('Effective policy'));
      runtime.out(`  Mode: ${effective.mode}`);
      runtime.out(
        `  Impact areas: ${effective.impactAreas.length > 0 ? effective.impactAreas.join(', ') : '(none declared)'}`,
      );
      runtime.out(`  Protected paths: ${effective.protectedPaths.join(', ')}`);
      runtime.out(
        `  Required commands: ${effective.requiredVerificationCommands.length > 0 ? effective.requiredVerificationCommands.join(', ') : '(none)'}`,
      );
      runtime.out(`  Require verified task evidence: ${effective.requireVerifiedTaskEvidence}`);
      runtime.out(`  Require requirement-task links: ${effective.requireRequirementTaskLinks}`);
      runtime.out(`  Require test evidence: ${effective.requireTestEvidence}`);
      const overrides = Object.entries(effective.ruleOverrides);
      if (overrides.length > 0) {
        runtime.out(sectionTitle('Rule overrides'));
        for (const [ruleId, override] of overrides) {
          runtime.out(
            `  ${ruleId}: ${override.enabled ? 'enabled' : 'disabled'}${override.severity !== undefined ? `, severity ${override.severity}` : ''}`,
          );
        }
      }
    });

  policy
    .command('validate <name>')
    .description('Validate a verification policy file against the versioned schema (read-only)')
    .option('--json', 'output a machine-readable JSON report')
    .addHelpText('after', '\nExit codes: 0 valid · 1 invalid · 2 no policy file / usage error.')
    .action((name: string, options: PolicyReadOptions) => {
      const workspace = runtime.workspace();
      requireSpec(workspace, name);
      const read = readVerificationPolicy(workspace, name);
      if (!read.exists) {
        throw new SpecBridgeError(
          'INVALID_STATE',
          `No verification policy exists at ${relPath(workspace, read.path)}. Create one with "${CLI_BIN} spec policy init ${name}".`,
        );
      }

      const problems: string[] = read.diagnostics.map((diagnostic) => diagnostic.message);
      if (read.policy !== undefined) {
        // Required command names must exist in the trusted configuration.
        const configRead = readAgentConfig(workspace);
        const configured = new Set(
          (configRead.config?.verification.commands ?? []).map((command) => command.name),
        );
        for (const required of read.policy.requiredVerificationCommands) {
          if (!configured.has(required)) {
            problems.push(
              `requiredVerificationCommands names "${required}", which is not configured in .specbridge/config.json (SBV013 would fail verification).`,
            );
          }
        }
      }

      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.policy-validate/1', `${CLI_BIN} ${VERSION}`, {
              specName: name,
              path: relPath(workspace, read.path),
              valid: problems.length === 0,
              problems,
            }),
          ),
        );
        runtime.exitCode = problems.length === 0 ? 0 : 1;
        return;
      }

      runtime.out(reportTitle(`Validate policy: ${relPath(workspace, read.path)}`));
      if (problems.length === 0) {
        runtime.out(okLine('The policy is valid.'));
        const raw = JSON.parse(readFileSync(read.path, 'utf8')) as { mode?: string };
        runtime.out(dim(`  Mode: ${raw.mode ?? 'advisory'}`));
      } else {
        for (const problem of problems) runtime.out(failLine(problem));
        runtime.out();
        runtime.out(warnLine('Fix the problems above; verification would report SBV020/SBV013.'));
        runtime.exitCode = 1;
      }
    });
}
