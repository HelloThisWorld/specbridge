import type { Command } from 'commander';
import type { IntakeDeps, SystemFinding } from '@specbridge/intake';
import {
  assessSnapshotFreshness,
  bootstrapWorkspace,
  inspectWorkspace,
  readCurrentSystemSnapshot,
} from '@specbridge/intake';
import {
  dim,
  infoLine,
  okLine,
  reportTitle,
  sectionTitle,
  warnLine,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { loadExecutionContext } from '../execution-context.js';

/**
 * `specbridge workspace bootstrap|snapshot|inspect` — the repository-aware
 * starting point of a product conversation.
 *
 *   bootstrap   build or revalidate the CurrentSystemSnapshot
 *   snapshot    show what SpecBridge currently believes about this system,
 *               with an explicit freshness verdict
 *   inspect     bounded deeper look at the implementation, via the existing
 *               repository index and deterministic retrieval
 *
 * None of this is Spec Intake and none of it creates product authority:
 * bootstrap helps the conversation; `spec start` still governs what becomes
 * product truth.
 */

function deps(runtime: CliRuntime): IntakeDeps {
  const context = loadExecutionContext(runtime);
  return {
    workspace: context.workspace,
    config: context.config,
    clock: () => runtime.now(),
    host: 'cli',
  };
}

function renderFindings(runtime: CliRuntime, title: string, findings: readonly SystemFinding[]): void {
  if (findings.length === 0) return;
  runtime.out(sectionTitle(title));
  for (const finding of findings.slice(0, 15)) {
    runtime.out(`  [${finding.class}] ${finding.statement}`);
    const first = finding.evidence[0];
    if (first !== undefined) {
      const where =
        first.path !== undefined
          ? `${first.repositoryId}:${first.path}`
          : (first.contractId ?? first.adrId ?? first.ruleId ?? first.decisionId ?? first.sealId ?? first.repositoryId);
      runtime.out(dim(`      evidence: ${where}${finding.evidence.length > 1 ? ` (+${finding.evidence.length - 1})` : ''}`));
    }
  }
  if (findings.length > 15) runtime.out(dim(`  … ${findings.length - 15} more`));
}

export function registerWorkspaceCommands(program: Command, runtime: CliRuntime): void {
  const workspace = program
    .command('workspace')
    .description('Workspace bootstrap: understand the current system before product discovery');

  workspace
    .command('bootstrap')
    .description('Build or revalidate the CurrentSystemSnapshot for this workspace')
    .option('--rebuild', 'force a full index rebuild and snapshot regeneration')
    .option('--json', 'machine-readable output')
    .action((options: { rebuild?: boolean; json?: boolean }) => {
      const result = bootstrapWorkspace(deps(runtime), {
        ...(options.rebuild === true ? { rebuild: true } : {}),
      });
      if (options.json === true) {
        runtime.out(JSON.stringify({ reused: result.reused, snapshot: result.snapshot }, null, 2));
        return;
      }
      const snapshot = result.snapshot;
      runtime.out(reportTitle(`Workspace bootstrap — ${snapshot.mode}`));
      runtime.out(
        result.reused
          ? okLine('snapshot is current; reused without regeneration')
          : okLine(`snapshot ${snapshot.snapshotId} generated`),
      );
      for (const repo of snapshot.repositories) {
        runtime.out(
          infoLine(
            `${repo.repositoryId}${repo.relPath === '' ? '' : ` (${repo.relPath}/)`}: ` +
              `${repo.indexedFiles} indexed file(s), ${repo.gitHead === null ? 'no git baseline' : `HEAD ${repo.gitHead.slice(0, 12)}`}`,
          ),
        );
      }
      runtime.out(
        infoLine(
          `${snapshot.capabilities.length} capability, ${snapshot.architecture.length} architecture, ` +
            `${snapshot.publicSurfaces.length} surface, ${snapshot.existingProductTruth.length} product-truth reference(s)`,
        ),
      );
      if (snapshot.uncertainties.length > 0) {
        runtime.out(warnLine(`${snapshot.uncertainties.length} uncertainty/uncertainties recorded — see \`workspace snapshot\``));
      }
    });

  workspace
    .command('snapshot')
    .description('Show what SpecBridge currently believes about this system')
    .option('--json', 'machine-readable output')
    .action((options: { json?: boolean }) => {
      const d = deps(runtime);
      const snapshot = readCurrentSystemSnapshot(d.workspace);
      const freshness = assessSnapshotFreshness(d.workspace, snapshot);
      if (options.json === true) {
        runtime.out(JSON.stringify({ freshness, snapshot }, null, 2));
        return;
      }
      if (snapshot === undefined) {
        runtime.out(warnLine('No snapshot exists yet. Run `specbridge workspace bootstrap`.'));
        return;
      }
      runtime.out(reportTitle(`Current system — ${snapshot.mode}`));
      if (freshness.status === 'STALE') {
        runtime.out(warnLine('STALE: the repositories moved since this snapshot was taken.'));
        for (const reason of freshness.reasons.slice(0, 5)) runtime.out(dim(`  ${reason}`));
        runtime.out(dim('  Re-run `specbridge workspace bootstrap` before relying on it.'));
      } else {
        runtime.out(okLine(`fresh as of ${snapshot.createdAt}`));
      }
      renderFindings(runtime, 'Capabilities', snapshot.capabilities);
      renderFindings(runtime, 'Architecture', snapshot.architecture);
      renderFindings(runtime, 'Public surfaces', snapshot.publicSurfaces);
      renderFindings(runtime, 'Domain objects', snapshot.domainObjects);
      renderFindings(runtime, 'Implementation patterns', snapshot.implementationPatterns);
      renderFindings(runtime, 'Constraints', snapshot.constraints);
      if (snapshot.existingProductTruth.length > 0) {
        runtime.out(sectionTitle('Existing product truth'));
        for (const ref of snapshot.existingProductTruth.slice(0, 15)) {
          runtime.out(`  ${ref.kind} ${ref.ref}${ref.revision !== undefined ? ` r${ref.revision}` : ''}: ${ref.title}`);
        }
        if (snapshot.existingProductTruth.length > 15) {
          runtime.out(dim(`  … ${snapshot.existingProductTruth.length - 15} more`));
        }
      }
      if (snapshot.uncertainties.length > 0) {
        runtime.out(sectionTitle('Uncertainties'));
        for (const entry of snapshot.uncertainties.slice(0, 10)) {
          runtime.out(`  ${entry.area}: ${entry.detail}`);
        }
      }
    });

  workspace
    .command('inspect <question...>')
    .description('Bounded deeper inspection of the current implementation')
    .option('--repo <id>', 'restrict to one repository of the snapshot')
    .option('--max-sections <n>', 'file sections to materialize (default 5)')
    .option('--json', 'machine-readable output')
    .action((question: string[], options: { repo?: string; maxSections?: string; json?: boolean }) => {
      const result = inspectWorkspace(deps(runtime), {
        question: question.join(' '),
        ...(options.repo !== undefined ? { repositoryId: options.repo } : {}),
        ...(options.maxSections !== undefined ? { maxSections: Number(options.maxSections) } : {}),
      });
      if (options.json === true) {
        runtime.out(JSON.stringify(result, null, 2));
        return;
      }
      if (result.sections.length === 0) {
        runtime.out(warnLine('Nothing in the index ranked as relevant to that question.'));
        return;
      }
      for (const section of result.sections) {
        runtime.out(
          sectionTitle(
            `${section.repositoryId}:${section.path}` +
              (section.startLine !== undefined ? ` (${section.startLine}–${section.endLine})` : ''),
          ),
        );
        runtime.out(section.content);
      }
      if (result.pointers.length > 0) {
        runtime.out(dim(`also relevant: ${result.pointers.map((p) => `${p.repositoryId}:${p.path}`).join(', ')}`));
      }
    });
}
