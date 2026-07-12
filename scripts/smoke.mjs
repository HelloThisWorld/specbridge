/**
 * CLI smoke test: runs the BUILT CLI (packages/cli/dist) against the example
 * workspaces, the same way a user would. Requires `pnpm build` first.
 * Exits non-zero on the first failure. No network, no model, no API key.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
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
  expectStdout: ['requirements-first', 'DESIGN_DRAFT'],
});

run('spec status reports stage approvals from sidecar state', {
  cwd: examples('requirements-first-project'),
  args: ['spec', 'status', 'notification-preferences'],
  expectCode: 0,
  expectStdout: ['Status: DESIGN_DRAFT', 'Approved', 'Content unchanged since approval'],
});

run('bugfix example classifies from layout alone', {
  cwd: examples('bugfix-spec-project'),
  args: ['spec', 'list'],
  expectCode: 0,
  expectStdout: ['cart-total-rounding', 'bugfix'],
});

run('planned commands fail honestly', {
  cwd: kiroProject,
  args: ['spec', 'sync', 'user-authentication'],
  expectCode: 2,
  expectStderr: ['not implemented yet'],
});

// v0.3 runner diagnostics are read-only and offline.
run('runner list shows honest runner statuses', {
  cwd: kiroProject,
  args: ['runner', 'list'],
  expectCode: 0,
  expectStdout: ['mock', 'not implemented in v0.3'],
});

run('runner doctor mock reports available with safety lines', {
  cwd: kiroProject,
  args: ['runner', 'doctor', 'mock'],
  expectCode: 0,
  expectStdout: ['Status: available', 'bypassPermissions is not enabled'],
});

run('spec run on an unmanaged spec fails with actionable guidance', {
  cwd: kiroProject,
  args: ['spec', 'run', 'user-authentication'],
  expectCode: 1,
  expectStderr: ['no SpecBridge workflow state', 'spec approve'],
});

// v0.2 authoring workflow, end to end, in a throwaway workspace.
const scratch = mkdtempSync(path.join(os.tmpdir(), 'specbridge-smoke-'));
mkdirSync(path.join(scratch, '.kiro'), { recursive: true });

run('spec new creates a Kiro-compatible spec offline', {
  cwd: scratch,
  args: [
    'spec',
    'new',
    'notification-preferences',
    '--mode',
    'requirements-first',
    '--description',
    'Allow users to select email and push notification preferences.',
  ],
  expectCode: 0,
  expectStdout: ['Created spec: notification-preferences', 'requirements.md', 'sidecar workflow state'],
});

run('freshly generated placeholders block approval', {
  cwd: scratch,
  args: ['spec', 'approve', 'notification-preferences', '--stage', 'requirements'],
  expectCode: 1,
  expectStderr: ['Cannot approve requirements'],
});

writeFileSync(
  path.join(scratch, '.kiro', 'specs', 'notification-preferences', 'requirements.md'),
  [
    '# Requirements Document',
    '',
    '## Introduction',
    '',
    'Allow users to select email and push notification preferences.',
    '',
    '## Requirements',
    '',
    '### Requirement 1: Channel selection',
    '',
    '**User Story:** As a user, I want to pick notification channels, so that I control where alerts arrive.',
    '',
    '#### Acceptance Criteria',
    '',
    '1. WHEN a user saves channel preferences, THE SYSTEM SHALL persist the selection.',
    '2. IF the preferences service is unavailable, THEN THE SYSTEM SHALL keep the previous preferences.',
    '',
    '## Out of Scope',
    '',
    '- Digest scheduling.',
    '',
    '## Non-Functional Requirements',
    '',
    '- Security: preferences are only readable by their owner.',
    '',
  ].join('\n'),
);

run('spec analyze passes after real content is written', {
  cwd: scratch,
  args: ['spec', 'analyze', 'notification-preferences', '--stage', 'requirements'],
  expectCode: 0,
  expectStdout: ['Result: OK'],
});

run('spec approve records the stage approval', {
  cwd: scratch,
  args: ['spec', 'approve', 'notification-preferences', '--stage', 'requirements'],
  expectCode: 0,
  expectStdout: ['requirements approved', 'Status: DESIGN_DRAFT'],
});

writeFileSync(
  path.join(scratch, '.kiro', 'specs', 'notification-preferences', 'requirements.md'),
  '# Requirements Document\n\nmodified after approval\n',
);

run('spec status detects the stale approval', {
  cwd: scratch,
  args: ['spec', 'status', 'notification-preferences'],
  expectCode: 0,
  expectStdout: ['STALE_APPROVAL', 'Modified after approval'],
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
