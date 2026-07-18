/**
 * Deterministic offline tests for the audit export example. Wired into
 * SpecBridge as the trusted verification command "audit-tests"
 * (.specbridge/config.json); the verification policy for audit-log-export
 * requires it to pass. No network, no model, exit 0 on success.
 */
import assert from 'node:assert/strict';
import { maskIp, redactEmail } from '../../src/audit/redact.mjs';
import { toCsv } from '../../src/audit/exporter.mjs';

let checks = 0;
function check(fn) {
  fn();
  checks += 1;
}

check(() => assert.equal(redactEmail('ada@example.com'), '***@example.com'));
check(() => assert.equal(redactEmail('not-an-email'), 'not-an-email'));
check(() => assert.equal(maskIp('203.0.113.7'), '203.0.113.xxx'));
check(() => assert.equal(maskIp('not-an-ip'), 'not-an-ip'));

// Empty range: header row only (Requirement 1.2).
check(() => assert.equal(toCsv([]), 'occurred_at,actor_email,source_ip,action\n'));

// Redaction is applied inside the exporter (Requirements 2.1, 2.2).
check(() =>
  assert.equal(
    toCsv([
      {
        occurredAt: '2026-07-01T12:00:00Z',
        actorEmail: 'ada@example.com',
        sourceIp: '203.0.113.7',
        action: 'login',
      },
    ]),
    'occurred_at,actor_email,source_ip,action\n' +
      '2026-07-01T12:00:00Z,***@example.com,203.0.113.xxx,login\n',
  ),
);

console.log(`audit-tests: ${checks} checks passed`);
