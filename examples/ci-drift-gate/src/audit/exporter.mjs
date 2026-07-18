import { maskIp, redactEmail } from './redact.mjs';

/**
 * Render audit entries as CSV (Requirement 1). Redaction is applied here,
 * inside the exporter, so no caller can produce an unredacted row
 * (see design.md, Security Considerations).
 */
const HEADER = 'occurred_at,actor_email,source_ip,action';

export function toCsv(entries) {
  const rows = entries.map(
    (entry) =>
      `${entry.occurredAt},${redactEmail(entry.actorEmail)},${maskIp(entry.sourceIp)},${entry.action}`,
  );
  return [HEADER, ...rows].join('\n') + '\n';
}
