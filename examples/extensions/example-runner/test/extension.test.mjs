import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

// Protocol-level smoke test: initialize handshake over real stdio.
test('extension answers the initialize handshake', async () => {
  const child = spawn(process.execPath, [path.resolve('dist/extension.cjs')], {
    cwd: path.resolve('.'),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const response = await new Promise((resolve, reject) => {
    let buffered = '';
    child.stdout.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      const line = buffered.split('\n')[0];
      if (line) resolve(JSON.parse(line));
    });
    child.on('error', reject);
    setTimeout(() => reject(new Error('no response')), 5000).unref();
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 'test-1', method: 'initialize',
      params: {
        protocolVersion: '1.0.0', specbridgeVersion: '0.7.1',
        extensionId: 'example-runner', extensionVersion: '1.0.0',
        grantedPermissions: {"specRead":true,"repositoryRead":true,"repositoryWrite":true,"network":false,"childProcess":false,"environmentVariables":[]},
      },
    }) + '\n');
  });
  child.kill();
  assert.equal(response.result.extensionId, 'example-runner');
});
