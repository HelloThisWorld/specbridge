import type { AntigravityProfileConfig, Diagnostic, RunnerStatus } from '@specbridge/core';
import { antigravityProfileSchema } from '@specbridge/core';
import type {
  AgentRunner,
  RunnerCapability,
  RunnerDetectionContext,
  RunnerDetectionResult,
  RunnerExecutionOptions,
  RunnerToolPolicy,
  StageGenerationInput,
  StageGenerationResult,
  TaskExecutionInput,
  TaskExecutionResult,
} from '../contract.js';
import type { RunnerCapabilitySet, RunnerSupportLevel } from '../contracts/capabilities.js';
import { capabilitySet } from '../contracts/capabilities.js';
import { runnerError } from '../contracts/errors.js';
import { runSafeProcess } from '../safe-process.js';

/**
 * Antigravity CLI adapter (v0.6.1) — EXPERIMENTAL, capability detection only.
 *
 * Purpose: detect the executable, its version, and any DOCUMENTED headless /
 * machine-readable capabilities, and report them transparently. Nothing is
 * automated: SpecBridge never starts the interactive TUI, never allocates a
 * pseudo-terminal, never injects keystrokes, never parses ANSI screen
 * output, never logs in, never trusts a workspace, and never inspects
 * private session files. No Gemini CLI flag, output format, or session
 * layout is assumed — Antigravity is a different product.
 *
 * Stage generation, refinement, task execution, and resume are all disabled:
 * the declared capability set is empty, so selection refuses every operation
 * before any process could start. Even when detection finds promising
 * tokens, the support level stays `experimental` in v0.6.1 — a stable,
 * documented, headless structured-output contract plus passing conformance
 * evidence is required before any operation can be considered, and that
 * decision is deliberately NOT made by detection heuristics.
 */

export const ANTIGRAVITY_DECLARED_CAPABILITIES: RunnerCapabilitySet = capabilitySet([]);

/** Documented-capability probes: reported transparently, never acted on. */
const ANTIGRAVITY_OBSERVATION_PROBES: { id: string; label: string; tokens: string[] }[] = [
  { id: 'headless', label: 'Documented headless invocation', tokens: ['--prompt', '--non-interactive', '--headless'] },
  { id: 'machine-readable', label: 'Documented machine-readable output', tokens: ['--output-format', '--json'] },
  { id: 'structured-final-output', label: 'Documented structured final output', tokens: ['json'] },
  { id: 'sandbox', label: 'Documented sandbox / permission controls', tokens: ['--sandbox', '--approval-mode'] },
  { id: 'workspace-write-control', label: 'Documented workspace-write controls', tokens: ['--allowed-tools', 'workspace-write'] },
  { id: 'session-identity', label: 'Documented session identity', tokens: ['--list-sessions', '--session'] },
  { id: 'resume', label: 'Documented session resume', tokens: ['--resume'] },
];

const PROBE_TIMEOUT_MS = 15_000;

function tokenPresent(helpText: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,=<[|])${escaped}(?![\\w-])`, 'm').test(helpText);
}

export class AntigravityCliRunner implements AgentRunner {
  readonly name = 'antigravity-cli';
  readonly kind = 'antigravity-cli';
  readonly category = 'experimental';
  readonly declaredCapabilities = ANTIGRAVITY_DECLARED_CAPABILITIES;
  /** Experimental in v0.6.1 — never selected automatically, never production. */
  readonly declaredSupportLevel: RunnerSupportLevel = 'experimental';
  private readonly config: AntigravityProfileConfig;

  constructor(config?: Partial<AntigravityProfileConfig>) {
    this.config = antigravityProfileSchema.parse({ runner: 'antigravity-cli', ...(config ?? {}) });
  }

  async detect(context: RunnerDetectionContext): Promise<RunnerDetectionResult> {
    const diagnostics: Diagnostic[] = [];
    const base: Pick<
      RunnerDetectionResult,
      'runner' | 'kind' | 'executable' | 'authentication' | 'category' | 'capabilitySet' | 'networkBacked'
    > = {
      runner: this.name,
      kind: 'antigravity-cli',
      executable: this.config.command.executable,
      // No safe offline status command is documented; credential files and
      // private session stores are never read.
      authentication: 'unknown',
      category: this.category,
      capabilitySet: ANTIGRAVITY_DECLARED_CAPABILITIES,
      networkBacked: false,
    };
    const emptyCapabilities = (): RunnerCapability[] =>
      ANTIGRAVITY_OBSERVATION_PROBES.map((probe) => ({
        id: probe.id,
        label: probe.label,
        available: false,
        required: false,
      }));

    if (!this.config.enabled) {
      diagnostics.push({
        severity: 'error',
        code: 'RUNNER_DISABLED',
        message:
          'This Antigravity profile is disabled in .specbridge/config.json (enabled = false). ' +
          'It is experimental: enabling it only unlocks diagnostics, never automation.',
      });
      return {
        ...base,
        status: 'misconfigured',
        capabilities: emptyCapabilities(),
        diagnostics,
        supportLevel: 'experimental',
      };
    }

    const timeoutMs = Math.min(context.timeoutMs ?? PROBE_TIMEOUT_MS, this.config.timeoutMs);
    const invoke = (argv: string[]) =>
      runSafeProcess({
        executable: this.config.command.executable,
        argv: [...this.config.command.args, ...argv],
        cwd: process.cwd(),
        timeoutMs,
        maxStdoutBytes: 1024 * 1024,
        maxStderrBytes: 256 * 1024,
      });

    // 1. Version probe. stdin is not connected; a build that insists on an
    //    interactive session simply hits the bounded timeout and is
    //    classified — no TTY, no PTY, no keystrokes, ever.
    const versionResult = await invoke(['--version']);
    if (versionResult.status === 'spawn-failed') {
      diagnostics.push({
        severity: 'error',
        code: 'RUNNER_EXECUTABLE_NOT_FOUND',
        message:
          `Antigravity executable "${this.config.command.executable}" could not be started. ` +
          'Install it yourself or set the profile command in .specbridge/config.json.',
      });
      return {
        ...base,
        status: 'unavailable',
        capabilities: emptyCapabilities(),
        diagnostics,
        supportLevel: 'experimental',
      };
    }
    if (versionResult.status === 'timeout') {
      diagnostics.push({
        severity: 'error',
        code: 'RUNNER_INTERACTIVE_ONLY',
        message:
          '"--version" did not return: the executable appears to start an interactive session. ' +
          'SpecBridge never automates a TUI (no PTY, no keystrokes, no screen scraping) — automation stays disabled.',
      });
      return {
        ...base,
        status: 'incompatible',
        capabilities: emptyCapabilities(),
        diagnostics,
        supportLevel: 'experimental',
      };
    }
    if (versionResult.status !== 'ok') {
      diagnostics.push({
        severity: 'error',
        code: 'RUNNER_VERSION_FAILED',
        message: `"${this.config.command.executable} --version" ${versionResult.failureReason ?? 'produced no output'}.`,
      });
      return {
        ...base,
        status: 'error',
        capabilities: emptyCapabilities(),
        diagnostics,
        supportLevel: 'experimental',
      };
    }
    const version = versionResult.stdout.trim().split(/\r?\n/)[0]?.trim();

    // 2. Help probe — observation only.
    const help = await invoke(['--help']);
    const helpText = `${help.stdout}\n${help.stderr}`;
    const helpUsable = help.status === 'ok' && helpText.trim().length > 0;
    const interactiveOnly =
      help.status === 'timeout' ||
      (helpUsable && /interactive|tui/i.test(helpText) && !/--prompt|--non-interactive|--headless/i.test(helpText));

    const capabilities: RunnerCapability[] = ANTIGRAVITY_OBSERVATION_PROBES.map((probe) => {
      const available = helpUsable && probe.tokens.some((token) => tokenPresent(helpText, token));
      return {
        id: probe.id,
        label: probe.label,
        available,
        required: false,
        detail: available
          ? 'detected in help output — automation still stays disabled in v0.6.1'
          : 'not proven for this installation',
      };
    });

    const notProven = capabilities.filter((capability) => !capability.available);
    if (interactiveOnly) {
      diagnostics.push({
        severity: 'warning',
        code: 'RUNNER_INTERACTIVE_ONLY',
        message:
          'This installation documents only an interactive workflow. SpecBridge never automates a TUI ' +
          '(no PTY, no keystroke injection, no ANSI screen parsing).',
      });
    }
    if (notProven.length > 0) {
      diagnostics.push({
        severity: 'info',
        code: 'RUNNER_CAPABILITY_NOT_PROVEN',
        message: `Not proven for this installation: ${notProven.map((capability) => capability.label.toLowerCase()).join('; ')}.`,
      });
    }
    diagnostics.push({
      severity: 'info',
      code: 'RUNNER_EXPERIMENTAL',
      message:
        'Antigravity support is experimental: executable and capability diagnostics only. ' +
        'Stage authoring, task execution, and resume are disabled until a documented, headless, ' +
        'structured-output contract passes the applicable conformance suite (not in v0.6.1).',
    });

    const status: RunnerStatus = helpUsable || help.status === 'timeout' ? 'available' : 'error';
    return {
      ...base,
      status,
      ...(version !== undefined && version.length > 0 ? { version } : {}),
      capabilities,
      diagnostics,
      supportLevel: 'experimental',
    };
  }

  executionBoundaryNote(_policy: RunnerToolPolicy): string {
    return 'Experimental: detection and diagnostics only; no authoring, no task execution, no automation.';
  }

  private refusal(): {
    runner: string;
    outcome: 'failed';
    failureReason: string;
    rawStdout: string;
    rawStderr: string;
    durationMs: number;
    warnings: string[];
    error: ReturnType<typeof runnerError>;
  } {
    return {
      runner: this.name,
      outcome: 'failed',
      failureReason:
        'the antigravity-cli adapter is experimental: it detects capabilities only and never executes authoring or tasks',
      rawStdout: '',
      rawStderr: '',
      durationMs: 0,
      warnings: [],
      error: runnerError({
        code: 'unsupported_operation',
        message: 'The experimental Antigravity adapter performs detection only in v0.6.1.',
        remediation: [
          'Use a claude-code, codex-cli, or gemini-cli profile for execution, or an authoring profile for spec drafting.',
        ],
      }),
    };
  }

  /** Selection refuses every operation first; these are defense in depth. */
  generateStage(
    _input: StageGenerationInput,
    _execution: RunnerExecutionOptions,
  ): Promise<StageGenerationResult> {
    return Promise.resolve(this.refusal());
  }

  executeTask(
    _input: TaskExecutionInput,
    _execution: RunnerExecutionOptions,
  ): Promise<TaskExecutionResult> {
    return Promise.resolve({ ...this.refusal(), resumeSupported: false });
  }
}
