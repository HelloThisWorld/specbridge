/**
 * CLI smoke test: runs the BUILT CLI (packages/cli/dist) against the example
 * workspaces, the same way a user would. Requires `pnpm build` first.
 * Exits non-zero on the first failure. No network, no model, no API key.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const examples = (name) => path.join(repoRoot, 'examples', name);

if (!existsSync(cliPath)) {
  console.error(`smoke: built CLI not found at ${cliPath} — run "pnpm build" first.`);
  process.exit(2);
}

let failures = 0;
let ran = 0;

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

const kiroProject = examples('existing-kiro-project');

run('doctor on the example Kiro project', {
  cwd: kiroProject,
  args: ['doctor'],
  expectCode: 0,
  expectStdout: [
    '.kiro directory detected',
    'user-authentication',
    'login-timeout-fix',
    'No migration required',
    'Safe for read-only use',
  ],
});

run('doctor --json is valid JSON and healthy', {
  cwd: kiroProject,
  args: ['doctor', '--json'],
  expectCode: 0,
  expectStdout: ['"schema": "specbridge.doctor/1"', '"healthy": true'],
});

run('spec list shows all three example specs', {
  cwd: kiroProject,
  args: ['spec', 'list'],
  expectCode: 0,
  expectStdout: ['user-authentication', 'notification-settings', 'login-timeout-fix', 'bugfix'],
});

run('spec show renders a summary', {
  cwd: kiroProject,
  args: ['spec', 'show', 'user-authentication'],
  expectCode: 0,
  expectStdout: ['Spec: user-authentication', 'Type: feature', 'Round-trip safe'],
});

run('spec show --file tasks prints the file', {
  cwd: kiroProject,
  args: ['spec', 'show', 'user-authentication', '--file', 'tasks'],
  expectCode: 0,
  expectStdout: ['- [x] 1. Set up authentication module scaffolding'],
});

run('spec context assembles agent-ready context', {
  cwd: kiroProject,
  args: ['spec', 'context', 'user-authentication', '--target', 'claude-code'],
  expectCode: 0,
  expectStdout: [
    '# SpecBridge Agent Context',
    'Working agreements',
    'Requirement 1',
    'compat check user-authentication',
  ],
});

run('compat check proves byte-identical round trips', {
  cwd: kiroProject,
  args: ['compat', 'check'],
  expectCode: 0,
  expectStdout: ['PASS', 'byte-identical'],
});

run('steering show prints raw content', {
  cwd: kiroProject,
  args: ['steering', 'show', 'product'],
  expectCode: 0,
  expectStdout: ['Acme Portal'],
});

run('sidecar workflow modes surface in spec list', {
  cwd: examples('requirements-first-project'),
  args: ['spec', 'list'],
  expectCode: 0,
  expectStdout: ['requirements-first', 'DESIGN_APPROVED'],
});

run('bugfix example classifies from layout alone', {
  cwd: examples('bugfix-spec-project'),
  args: ['spec', 'list'],
  expectCode: 0,
  expectStdout: ['cart-total-rounding', 'bugfix'],
});

run('planned commands fail honestly', {
  cwd: kiroProject,
  args: ['spec', 'run', 'user-authentication'],
  expectCode: 2,
  expectStderr: ['not implemented yet'],
});

run('unknown spec errors helpfully', {
  cwd: kiroProject,
  args: ['spec', 'show', 'does-not-exist'],
  expectCode: 2,
  expectStderr: ['Available specs:'],
});

// Version consistency between package.json and the version constant.
const cliPackage = JSON.parse(
  readFileSync(path.join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8'),
);
run(`--version matches package.json (${cliPackage.version})`, {
  cwd: kiroProject,
  args: ['--version'],
  expectCode: 0,
  expectStdout: [cliPackage.version],
});

console.log('');
if (failures > 0) {
  console.error(`smoke: ${failures}/${ran} checks failed`);
  process.exit(1);
}
console.log(`smoke: all ${ran} checks passed`);
