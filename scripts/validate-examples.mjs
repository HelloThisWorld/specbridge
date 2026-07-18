/**
 * Example validation: runs the BUILT CLI (packages/cli/dist) against a
 * TEMPORARY COPY of every example workspace that has a README, executing
 * only the offline, deterministic commands each README declares. The
 * committed example directories are never touched. Requires `pnpm build`
 * first. No network, no model, no API key. Exits non-zero on any failure.
 *
 * The commands checked per example are an explicit allowlist below —
 * read-only CLI commands plus the documented drift/restore round trips
 * (which mutate only the temporary copy).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

if (!existsSync(cliPath)) {
  console.error(`validate-examples: built CLI not found at ${cliPath} — run "pnpm build" first.`);
  process.exit(2);
}

let failures = 0;
let ran = 0;
const tempDirs = [];

/** Copy one committed example into a fresh temp dir and return that dir. */
function copyExample(name) {
  const source = path.join(repoRoot, 'examples', name);
  if (!existsSync(path.join(source, 'README.md'))) {
    throw new Error(`example "${name}" has no README.md at ${source}`);
  }
  const target = mkdtempSync(path.join(os.tmpdir(), `sb-examples-${name}-`));
  tempDirs.push(target);
  cpSync(source, target, { recursive: true });
  return target;
}

/**
 * Initialize a git repository in the temp copy and commit everything, so
 * `spec verify` has a HEAD to compare against. Line-ending conversion is
 * disabled: approval hashes cover exact file bytes.
 */
function initGit(cwd) {
  const steps = [
    ['init', '-q'],
    ['config', 'core.autocrlf', 'false'],
    ['config', 'user.name', 'SpecBridge Examples'],
    ['config', 'user.email', 'examples@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['add', '-A'],
    ['commit', '-q', '-m', 'example fixture'],
  ];
  for (const args of steps) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
    }
  }
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  }
}

function run(label, { cwd, args, expectCode, expectStdout = [], expectStderr = [] }) {
  ran += 1;
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  const problems = [];
  if (result.status !== expectCode) {
    problems.push(`exit code ${result.status}, expected ${expectCode}`);
  }
  for (const needle of expectStdout) {
    if (!result.stdout.includes(needle)) problems.push(`stdout missing: ${JSON.stringify(needle)}`);
  }
  for (const needle of expectStderr) {
    if (!result.stderr.includes(needle)) problems.push(`stderr missing: ${JSON.stringify(needle)}`);
  }
  if (problems.length > 0) {
    failures += 1;
    console.error(`FAIL  ${label}`);
    for (const problem of problems) console.error(`      ${problem}`);
    console.error(`      stdout: ${result.stdout.slice(0, 400)}`);
    console.error(`      stderr: ${result.stderr.slice(0, 400)}`);
  } else {
    console.log(`ok    ${label}`);
  }
}

try {
  // --- existing-kiro-project ------------------------------------------------
  // Allowlist: doctor, spec list, spec show, compat check (all read-only).
  {
    const dir = copyExample('existing-kiro-project');
    run('existing-kiro-project: doctor', {
      cwd: dir,
      args: ['doctor'],
      expectCode: 0,
      expectStdout: ['.kiro directory detected', 'Safe for read-only use'],
    });
    run('existing-kiro-project: spec list', {
      cwd: dir,
      args: ['spec', 'list'],
      expectCode: 0,
      expectStdout: ['user-authentication', 'login-timeout-fix'],
    });
    run('existing-kiro-project: spec show', {
      cwd: dir,
      args: ['spec', 'show', 'user-authentication'],
      expectCode: 0,
      expectStdout: ['Spec: user-authentication', 'Round-trip safe'],
    });
    run('existing-kiro-project: compat check', {
      cwd: dir,
      args: ['compat', 'check'],
      expectCode: 0,
      expectStdout: ['PASS', 'byte-identical'],
    });
  }

  // --- requirements-first-project -------------------------------------------
  // Allowlist: spec list, spec status (read-only; committed approval state).
  {
    const dir = copyExample('requirements-first-project');
    run('requirements-first-project: spec list', {
      cwd: dir,
      args: ['spec', 'list'],
      expectCode: 0,
      expectStdout: ['notification-preferences', 'requirements-first'],
    });
    run('requirements-first-project: spec status', {
      cwd: dir,
      args: ['spec', 'status', 'notification-preferences'],
      expectCode: 0,
      expectStdout: ['Status: DESIGN_DRAFT', 'Content unchanged since approval'],
    });
  }

  // --- design-first-project -------------------------------------------------
  // Allowlist: spec list.
  {
    const dir = copyExample('design-first-project');
    run('design-first-project: spec list', {
      cwd: dir,
      args: ['spec', 'list'],
      expectCode: 0,
      expectStdout: ['export-pipeline', 'design-first'],
    });
  }

  // --- quick-spec-project ---------------------------------------------------
  // Allowlist: spec list.
  {
    const dir = copyExample('quick-spec-project');
    run('quick-spec-project: spec list', {
      cwd: dir,
      args: ['spec', 'list'],
      expectCode: 0,
      expectStdout: ['healthcheck-endpoint', 'quick'],
    });
  }

  // --- bugfix-spec-project --------------------------------------------------
  // Allowlist: spec show, spec context.
  {
    const dir = copyExample('bugfix-spec-project');
    run('bugfix-spec-project: spec show', {
      cwd: dir,
      args: ['spec', 'show', 'cart-total-rounding'],
      expectCode: 0,
      expectStdout: ['Spec: cart-total-rounding', 'Type: bugfix'],
    });
    run('bugfix-spec-project: spec context', {
      cwd: dir,
      args: ['spec', 'context', 'cart-total-rounding'],
      expectCode: 0,
      expectStdout: ['# SpecBridge Agent Context'],
    });
  }

  // --- claude-code-workflow -------------------------------------------------
  // Allowlist: doctor, spec list, spec status, spec context, spec verify,
  // plus the README's drift/restore round trip (mutates the temp copy only).
  {
    const dir = copyExample('claude-code-workflow');
    initGit(dir);
    run('claude-code-workflow: doctor', {
      cwd: dir,
      args: ['doctor'],
      expectCode: 0,
      expectStdout: ['notification-digest', 'No migration required'],
    });
    run('claude-code-workflow: spec list', {
      cwd: dir,
      args: ['spec', 'list'],
      expectCode: 0,
      expectStdout: ['notification-digest', 'TASKS_DRAFT'],
    });
    run('claude-code-workflow: spec status shows byte-verified approvals', {
      cwd: dir,
      args: ['spec', 'status', 'notification-digest'],
      expectCode: 0,
      expectStdout: ['Status: TASKS_DRAFT', 'Content unchanged since approval'],
    });
    run('claude-code-workflow: spec context assembles offline', {
      cwd: dir,
      args: ['spec', 'context', 'notification-digest', '--target', 'claude-code'],
      expectCode: 0,
      expectStdout: ['# SpecBridge Agent Context', 'Requirement 1'],
    });
    run('claude-code-workflow: spec verify passes on the committed state', {
      cwd: dir,
      args: ['spec', 'verify', 'notification-digest', '--working-tree'],
      expectCode: 0,
      expectStdout: ['PASSED', '0 errors'],
    });
    const requirements = path.join(dir, '.kiro', 'specs', 'notification-digest', 'requirements.md');
    appendFileSync(requirements, '\nEdited after approval to demonstrate drift.\n');
    run('claude-code-workflow: verify fails after post-approval edit (SBV002)', {
      cwd: dir,
      args: ['spec', 'verify', 'notification-digest', '--working-tree'],
      expectCode: 1,
      expectStdout: ['SBV002', 'FAILED'],
    });
    git(dir, 'checkout', '--', '.kiro/specs/notification-digest/requirements.md');
    run('claude-code-workflow: verify passes again after restore', {
      cwd: dir,
      args: ['spec', 'verify', 'notification-digest', '--working-tree'],
      expectCode: 0,
      expectStdout: ['PASSED'],
    });
  }

  // --- ci-drift-gate --------------------------------------------------------
  // Allowlist: spec policy validate, spec verify (runs the trusted
  // audit-tests command from the example's own config), plus the README's
  // drift check (mutates the temp copy only).
  {
    const dir = copyExample('ci-drift-gate');
    initGit(dir);
    run('ci-drift-gate: spec policy validate', {
      cwd: dir,
      args: ['spec', 'policy', 'validate', 'audit-log-export'],
      expectCode: 0,
      expectStdout: ['The policy is valid', 'strict'],
    });
    run('ci-drift-gate: spec verify passes and runs audit-tests', {
      cwd: dir,
      args: ['spec', 'verify', 'audit-log-export', '--working-tree'],
      expectCode: 0,
      expectStdout: ['audit-tests', 'PASSED'],
    });
    const requirements = path.join(dir, '.kiro', 'specs', 'audit-log-export', 'requirements.md');
    appendFileSync(requirements, '\nEdited after approval to demonstrate drift.\n');
    run('ci-drift-gate: verify fails after post-approval edit (SBV002)', {
      cwd: dir,
      args: ['spec', 'verify', 'audit-log-export', '--working-tree'],
      expectCode: 1,
      expectStdout: ['SBV002', 'FAILED'],
    });
  }

  // --- template-and-extension -----------------------------------------------
  // Allowlist: template search/show/preview, registry list/search,
  // extension list (all read-only; preview writes nothing by design).
  {
    const dir = copyExample('template-and-extension');
    run('template-and-extension: template search', {
      cwd: dir,
      args: ['template', 'search', 'rest-api'],
      expectCode: 0,
      expectStdout: ['builtin:rest-api'],
    });
    run('template-and-extension: template show', {
      cwd: dir,
      args: ['template', 'show', 'rest-api'],
      expectCode: 0,
      expectStdout: ['Variables:', 'requirements.md'],
    });
    run('template-and-extension: template preview writes nothing', {
      cwd: dir,
      args: [
        'template',
        'preview',
        'rest-api',
        '--name',
        'orders-endpoint',
        '--var',
        'resourceName=order',
      ],
      expectCode: 0,
      expectStdout: ['nothing was written', 'orders-endpoint'],
    });
    run('template-and-extension: registry list', {
      cwd: dir,
      args: ['registry', 'list'],
      expectCode: 0,
      expectStdout: ['examples', 'builtin'],
    });
    run('template-and-extension: registry search', {
      cwd: dir,
      args: ['registry', 'search', 'analyzer'],
      expectCode: 0,
      expectStdout: ['example-analyzer@1.0.0'],
    });
    run('template-and-extension: extension list starts empty', {
      cwd: dir,
      args: ['extension', 'list'],
      expectCode: 0,
      expectStdout: ['Installed extensions (0)'],
    });
  }
} finally {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Best-effort cleanup; a stubborn temp dir must not fail validation.
    }
  }
}

console.log('');
if (failures > 0) {
  console.error(`validate-examples: ${failures}/${ran} checks failed`);
  process.exit(1);
}
console.log(`validate-examples: all ${ran} checks passed`);
