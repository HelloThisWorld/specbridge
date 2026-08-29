import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Contract freeze: the committed snapshots under contracts/ must match the
 * built public surface. Drift without an intentional snapshot update (and a
 * CHANGELOG entry) fails CI. These tests also pin a handful of load-bearing
 * literals directly, so a snapshot regeneration cannot silently launder an
 * unintended breaking change through a single command.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const contractsDir = path.join(repoRoot, 'contracts');

function readContract(name: string): unknown {
  return JSON.parse(readFileSync(path.join(contractsDir, name), 'utf8'));
}

/**
 * The checker walks the SHIPPED `--help` surface, which costs one full Node
 * start plus one full CLI-bundle parse per command — 158 of them at vNext.10,
 * roughly 70s on an idle developer machine and well past that on a loaded
 * 4-vCPU runner. It blocks a test worker for the whole time, and at vNext.10
 * it finally exceeded its 120s budget on `node 20 on windows-latest`.
 *
 * CI already runs this exact command as a dedicated step ("Public contract
 * snapshots match the built surface" -> `pnpm check:public-contracts`, which
 * is byte-identically `node scripts/check-public-contracts.mjs --check`). On
 * CI this test is therefore a second execution of a check that has already
 * failed the build if it was going to, bought at the price of the
 * longest-blocking test in the suite.
 *
 * It is skipped there and kept everywhere else, because locally `pnpm test`
 * is often the only gate anyone runs. The invariant is not relaxed: contract
 * drift still fails every one of the six CI matrix jobs, through the step
 * that exists to enforce it. Only the duplicate execution goes.
 */
const onCi = process.env['CI'] !== undefined;

describe('public contract snapshots', () => {
  it.skipIf(onCi)(
    'checker passes against the current build (requires pnpm build)',
    { timeout: 120_000 },
    () => {
      const cliDist = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
      if (!existsSync(cliDist)) {
        throw new Error(
          'packages/cli/dist is missing — run "pnpm build" before the contract tests.',
        );
      }
      const output = execFileSync(
        process.execPath,
        [path.join(repoRoot, 'scripts', 'check-public-contracts.mjs'), '--check'],
        { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
      );
      expect(output).toContain('all snapshots match');
    },
  );

  it('snapshot files exist for every frozen area', () => {
    const expected = [
      'cli-commands.json',
      'exit-codes.json',
      'report-ids.json',
      'schema-versions.json',
      'verification-rules.json',
      'runner-contract.json',
      'template-contract.json',
      'extension-contract.json',
      'mcp-contract.json',
      'plugin-skills.json',
      'github-action.json',
      'context-contract.json',
      'intake-contract.json',
    ];
    const present = readdirSync(contractsDir).filter((name) => name.endsWith('.json'));
    for (const name of expected) expect(present, name).toContain(name);
  });

  it('exit codes stay pinned to their documented numbers', () => {
    expect(readContract('exit-codes.json')).toEqual({
      ok: 0,
      gateFailure: 1,
      usageError: 2,
      runnerUnavailable: 3,
      runnerFailure: 4,
      timeout: 5,
      safetyFailure: 6,
    });
  });

  it('verification rule IDs stay contiguous SBV001–SBV026', () => {
    const { ruleIds } = readContract('verification-rules.json') as { ruleIds: string[] };
    expect(ruleIds).toEqual(
      Array.from({ length: 26 }, (_, index) => `SBV${String(index + 1).padStart(3, '0')}`),
    );
  });

  it('MCP tool names include the frozen v0.5–v0.7 surface', () => {
    const { tools, prompts, serverName } = readContract('mcp-contract.json') as {
      tools: string[];
      prompts: string[];
      serverName: string;
    };
    expect(serverName).toBe('specbridge');
    for (const name of ['workspace_detect', 'spec_list', 'task_begin', 'task_complete', 'registry_search']) {
      expect(tools).toContain(name);
    }
    // v1.0 froze 37 tools. v1.1 is purely additive: the ten orchestration
    // tools are new, and nothing that existed was removed or renamed.
    const V1_1_ADDITIONS = [
      'orchestration_assess_intent',
      'orchestration_begin',
      'orchestration_checkpoint',
      'orchestration_clarify',
      'orchestration_finalize',
      'orchestration_record_action',
      'orchestration_resolve_clarification',
      'orchestration_review_plan',
      'orchestration_status',
      'orchestration_submit_plan',
    ];
    for (const name of V1_1_ADDITIONS) expect(tools).toContain(name);
    const V1_2_ADDITIONS = ['job_list', 'job_read', 'job_cancel'];
    for (const name of V1_2_ADDITIONS) expect(tools).toContain(name);
    const MISSION_ADDITIONS = [
      'mission_begin',
      'mission_status',
      'mission_read',
      'mission_record_turn',
      'mission_assess',
      'mission_questions',
      'mission_answer',
      'mission_synthesize',
      'contract_list',
      'contract_read',
      'contract_change_request',
      'objective_read',
      'workunit_read',
      'evaluation_read',
    ];
    for (const name of MISSION_ADDITIONS) expect(tools).toContain(name);
    // vNext.10.1 Zero-Touch Spec Intake. Three tools, and the fourth one a
    // reader might expect — an approval — deliberately does not exist.
    const INTAKE_ADDITIONS = ['spec_intake_start', 'spec_intake_read', 'spec_intake_answer'];
    for (const name of INTAKE_ADDITIONS) expect(tools).toContain(name);
    expect(tools).not.toContain('spec_intake_approve');
    expect(tools.filter((name) => name.startsWith('spec_intake_'))).toHaveLength(3);
    // vNext.10.2 Phase 1 Workspace Bootstrap. Three tools, none of which can
    // create product authority: bootstrap and inspection read the repository
    // and existing truth; nothing writes a contract.
    const BOOTSTRAP_ADDITIONS = ['workspace_bootstrap', 'workspace_snapshot', 'repository_inspect'];
    for (const name of BOOTSTRAP_ADDITIONS) expect(tools).toContain(name);
    // vNext.10.2 Phase 2 Research Layer. Evidence-only explicit surfaces;
    // there is no approval, contract-application, or completion tool.
    const RESEARCH_ADDITIONS = [
      'research_gate',
      'research_start',
      'research_get',
      'research_list',
      'research_provider_status',
    ];
    for (const name of RESEARCH_ADDITIONS) expect(tools).toContain(name);
    const RESEARCH_LIFECYCLE_ADDITIONS = ['research_consider', 'prepare_intake_decision'];
    for (const name of RESEARCH_LIFECYCLE_ADDITIONS) expect(tools).toContain(name);
    expect(tools).not.toContain('research_approve');
    expect(tools).not.toContain('research_apply_contract');
    expect(tools).not.toContain('research_complete_task');
    expect(
      tools.filter(
        (name) =>
          !V1_1_ADDITIONS.includes(name) &&
          !V1_2_ADDITIONS.includes(name) &&
          !MISSION_ADDITIONS.includes(name) &&
          !INTAKE_ADDITIONS.includes(name) &&
          !BOOTSTRAP_ADDITIONS.includes(name) &&
          !RESEARCH_ADDITIONS.includes(name) &&
          !RESEARCH_LIFECYCLE_ADDITIONS.includes(name),
      ),
    ).toHaveLength(37);
    expect(tools).toHaveLength(77);
    // No approval tool, no shell, no filesystem, no git — at any version.
    for (const forbidden of tools) {
      expect(forbidden).not.toMatch(/^(.*_approve|.*_shell|.*_exec|.*_git|.*_write_file)$/);
    }
    expect(prompts).toEqual([
      'specbridge-author-stage',
      'specbridge-implement-task',
      'specbridge-status',
      'specbridge-verify',
    ]);
  });

  it('the v1.0.0 CLI tree keeps every pre-1.0 command and the new migrate/state groups', () => {
    const { tree } = readContract('cli-commands.json') as {
      tree: { subcommands: Record<string, { subcommands?: Record<string, unknown> }> };
    };
    const top = Object.keys(tree.subcommands);
    for (const name of [
      'doctor', 'steering', 'spec', 'runner', 'config', 'run', 'compat', 'mcp',
      'template', 'extension', 'registry', 'migrate', 'state',
    ]) {
      expect(top, name).toContain(name);
    }
    expect(Object.keys(tree.subcommands['migrate']?.subcommands ?? {})).toEqual(
      expect.arrayContaining(['status', 'plan', 'apply', 'verify']),
    );
    expect(Object.keys(tree.subcommands['state']?.subcommands ?? {})).toEqual(
      expect.arrayContaining(['validate', 'recover']),
    );
  });

  it('GitHub Action inputs/outputs stay pinned', () => {
    expect(readContract('github-action.json')).toEqual({
      inputs: [
        'annotation-limit', 'annotations', 'base-ref', 'fail-on', 'head-ref', 'mode',
        'report-directory', 'run-verification', 'spec', 'strict', 'write-step-summary',
      ],
      outputs: [
        'affected-specs', 'error-count', 'html-report', 'info-count', 'json-report',
        'markdown-report', 'result', 'spec-count', 'verification-id', 'warning-count',
      ],
    });
  });

  it('Claude Code Skill names stay pinned', () => {
    const { skills } = readContract('plugin-skills.json') as { skills: string[] };
    // The v1.0 eleven are frozen; v1.1 added `develop`, v1.2 adds
    // `orchestrate`, mission-driven development adds `discover`, and
    // nothing is ever removed.
    for (const name of [
      'approve', 'author', 'continue', 'doctor', 'extensions', 'implement',
      'new', 'runners', 'status', 'templates', 'verify',
    ]) {
      expect(skills, name).toContain(name);
    }
    // vNext.10.1 adds `build` (the Zero-Touch Spec Intake entry path) and
    // `spec-draft` (conversation -> specification, feeding `build`).
    expect(skills).toEqual([
      'approve', 'author', 'build', 'continue', 'develop', 'discover', 'doctor', 'extensions',
      'implement', 'new', 'orchestrate', 'runners', 'spec-draft', 'status', 'templates', 'verify',
    ]);
  });

  it('the v1.1 orchestration vocabulary is snapshotted and complete', () => {
    const contract = readContract('orchestration-contract.json') as Record<string, string[]>;
    expect(contract['intentOutcomes']).toEqual(['BLOCKED', 'NEEDS_CLARIFICATION', 'READY', 'REJECTED']);
    expect(contract['planReviewModes']).toEqual(['auto', 'disabled', 'review']);
    expect(contract['finalPhases']).toEqual(['ABORTED', 'CANCELLED', 'COMPLETED', 'REJECTED']);
    // Every phase in the machine is snapshotted, and every final phase is a
    // phase.
    for (const phase of contract['finalPhases'] ?? []) {
      expect(contract['phases']).toContain(phase);
    }
    // The failure taxonomy covers each documented category.
    for (const category of [
      'TRANSIENT_TRANSPORT', 'TRANSIENT_TOOL', 'VERIFICATION_FAILURE', 'IMPLEMENTATION_DEFECT',
      'AMBIGUITY', 'BLOCKED_DEPENDENCY', 'CAPABILITY_UNAVAILABLE', 'AUTHENTICATION', 'PERMISSION',
      'SAFETY_POLICY', 'STALE_CONTEXT', 'REPOSITORY_DIVERGED', 'PROTECTED_PATH', 'NO_PROGRESS',
      'BUDGET_EXHAUSTED', 'CANCELLED', 'INVALID_CONFIGURATION', 'INTERNAL',
    ]) {
      expect(contract['failureCategories'], category).toContain(category);
    }
    expect(contract['enforcementLevels']).toEqual([
      'contract-enforced', 'hard-enforced', 'skill-guided',
    ]);
    // Error codes are SBO-prefixed and contiguous from SBO001.
    const codes = contract['errorCodes'] ?? [];
    expect(codes[0]).toBe('SBO001');
    for (const code of codes) expect(code).toMatch(/^SBO\d{3}$/);
  });

  it('the new sidecar schemas are versioned from day one', () => {
    const versions = readContract('schema-versions.json') as Record<string, string>;
    for (const key of ['orchestrationState', 'executionPlan', 'orchestrationCheckpoint']) {
      expect(versions[key], key).toMatch(/^\d+\.\d+\.\d+$/);
    }
    // v1.0 schema versions are unchanged: no migration is forced on anyone.
    expect(versions['specState']).toBe('1.0.0');
    expect(versions['runRecord']).toBe('1.0.0');
    expect(versions['runnerConfig']).toBe('2.0.0');
    expect(versions['evidence']).toBe('1.0.0');
  });
});
