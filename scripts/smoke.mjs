import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const root = mkdtempSync(path.join(tmpdir(), 'specbridge-smoke-'));
const cli = path.resolve('packages/cli/dist/index.cjs');

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `specbridge ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

try {
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'smoke-fixture', type: 'module' }, null, 2) + '\n',
  );
  writeFileSync(path.join(root, 'src', 'index.ts'), 'export const ready = true;\n');

  const version = run(['--version']).trim();
  if (version !== '2.0.0') throw new Error(`Unexpected CLI version: ${version}`);

  const bootstrap = JSON.parse(run(['bootstrap']));
  if (bootstrap.snapshot?.schemaVersion !== 'specbridge.snapshot.v2') {
    throw new Error('Smoke bootstrap did not produce a v2 CurrentSystemSnapshot.');
  }

  const session = JSON.parse(
    run(['design', 'start', 'Smoke design', 'Design a small health-check API.']),
  );
  if (session.schemaVersion !== 'specbridge.design-session.v2') {
    throw new Error('Smoke design did not produce a v2 DesignSession.');
  }

  process.stdout.write('SpecBridge 2.0 smoke test passed.\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}
