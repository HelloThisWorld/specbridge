import type { AgentConfig, VerificationCommand } from '@specbridge/core';
import type { EvidenceAssessment } from '@specbridge/evidence';
import { reusableCommandPass, runVerificationCommands } from '@specbridge/evidence';
import type { VerificationCommandResult } from '@specbridge/evidence';

/**
 * Trusted verification-command orchestration for `spec verify`.
 *
 * Commands come exclusively from `.specbridge/config.json` (argv arrays,
 * validated by the config schema). Spec policies may only *name* configured
 * commands — a policy can never introduce a new command line.
 *
 * Execution modes:
 *   - `all`            (--run-verification): run every configured command
 *   - `required-only`  (default when a selected policy requires commands):
 *                      run just the policy-required commands
 *   - `none`           (--no-run-verification, or nothing required): run
 *                      nothing; try to reuse passing results from valid,
 *                      fresh evidence recorded at the exact current HEAD
 */

export type CommandRunMode = 'all' | 'required-only' | 'none';

export interface OrchestratedCommand {
  name: string;
  argv: string[];
  required: boolean;
  disposition: 'executed' | 'reused-evidence' | 'not-run';
  passed: boolean;
  timedOut: boolean;
  spawnFailed: boolean;
  exitCode: number | null;
  durationMs: number | null;
  /** Run id of the evidence record a passing result was reused from. */
  reusedFromRunId?: string;
  /** Specs whose policy required this command by name. */
  requiredBySpecs: string[];
  /** Present when the command executed in this run. */
  result?: VerificationCommandResult;
}

export interface OrchestratedCommands {
  mode: CommandRunMode;
  commands: OrchestratedCommand[];
  /** Policy-required command names that are not configured at all (SBV013). */
  missingRequired: { name: string; requiredBySpecs: string[] }[];
}

export interface OrchestrateCommandsOptions {
  config: AgentConfig;
  /** Required command names per selected spec. */
  requiredBySpec: Map<string, string[]>;
  /** CLI tri-state: true = all, false = none, undefined = auto. */
  runVerification: boolean | undefined;
  workspaceRoot: string;
  /** Current HEAD SHA (needed for evidence reuse). */
  headSha?: string;
  /** Valid evidence assessments per spec (reuse source). */
  evidenceBySpec: Map<string, readonly EvidenceAssessment[]>;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Sink for full command output (report artifacts). */
  onCommandFinished?: (result: VerificationCommandResult, stdout: string, stderr: string) => void;
}

export async function orchestrateVerificationCommands(
  options: OrchestrateCommandsOptions,
): Promise<OrchestratedCommands> {
  const configured = options.config.verification.commands;
  const configuredByName = new Map<string, VerificationCommand>(
    configured.map((command) => [command.name, command]),
  );

  // name → specs that require it (sorted for deterministic output).
  const requiringSpecs = new Map<string, string[]>();
  for (const [specName, names] of options.requiredBySpec) {
    for (const name of names) {
      const list = requiringSpecs.get(name) ?? [];
      list.push(specName);
      requiringSpecs.set(name, list);
    }
  }
  for (const list of requiringSpecs.values()) list.sort((a, b) => a.localeCompare(b, 'en'));

  const missingRequired = [...requiringSpecs.entries()]
    .filter(([name]) => !configuredByName.has(name))
    .map(([name, specs]) => ({ name, requiredBySpecs: specs }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));

  const mode: CommandRunMode =
    options.runVerification === true
      ? 'all'
      : options.runVerification === false
        ? 'none'
        : requiringSpecs.size > 0
          ? 'required-only'
          : 'none';

  const toRun: VerificationCommand[] =
    mode === 'all'
      ? [...configured]
      : mode === 'required-only'
        ? configured.filter((command) => requiringSpecs.has(command.name))
        : [];

  const commands: OrchestratedCommand[] = [];

  if (toRun.length > 0) {
    const runResult = await runVerificationCommands(options.workspaceRoot, toRun, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.onProgress !== undefined
        ? { onCommandStart: (command) => options.onProgress?.(`Running ${command.name}…`) }
        : {}),
      ...(options.onCommandFinished !== undefined
        ? { onCommandFinished: options.onCommandFinished }
        : {}),
    });
    for (const result of runResult.commands) {
      commands.push({
        name: result.name,
        argv: [...result.argv],
        required: result.required,
        disposition: 'executed',
        passed: result.passed,
        timedOut: result.timedOut,
        spawnFailed: result.status === 'spawn-failed',
        exitCode: result.exitCode ?? null,
        durationMs: result.durationMs,
        requiredBySpecs: requiringSpecs.get(result.name) ?? [],
        result,
      });
    }
  }

  // Required commands that did not execute: attempt evidence reuse.
  for (const [name, specs] of [...requiringSpecs.entries()].sort((a, b) =>
    a[0].localeCompare(b[0], 'en'),
  )) {
    const configuredCommand = configuredByName.get(name);
    if (configuredCommand === undefined) continue; // reported via missingRequired
    if (commands.some((command) => command.name === name)) continue;

    let reusedFrom: string | undefined;
    for (const specName of specs) {
      const assessments = options.evidenceBySpec.get(specName) ?? [];
      const record = reusableCommandPass(assessments, name, options.headSha);
      if (record !== undefined) {
        reusedFrom = record.runId;
        break;
      }
    }

    commands.push({
      name,
      argv: [...configuredCommand.argv],
      required: true,
      disposition: reusedFrom !== undefined ? 'reused-evidence' : 'not-run',
      passed: reusedFrom !== undefined,
      timedOut: false,
      spawnFailed: false,
      exitCode: null,
      durationMs: null,
      ...(reusedFrom !== undefined ? { reusedFromRunId: reusedFrom } : {}),
      requiredBySpecs: specs,
    });
  }

  commands.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return { mode, commands, missingRequired };
}
