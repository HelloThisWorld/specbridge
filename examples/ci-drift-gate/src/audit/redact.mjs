/**
 * Redaction rules for audit exports (Requirement 2). Pure functions —
 * the only place redaction logic is allowed to live (see design.md).
 */

/** Redact the local part of an email address: "ada@example.com" -> "***@example.com". */
export function redactEmail(value) {
  const at = value.indexOf('@');
  if (at <= 0) return value;
  return `***${value.slice(at)}`;
}

/** Mask the final octet of an IPv4 address: "203.0.113.7" -> "203.0.113.xxx". */
export function maskIp(value) {
  const match = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(value);
  if (match === null) return value;
  return `${match[1]}.xxx`;
}
