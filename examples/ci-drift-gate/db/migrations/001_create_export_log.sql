-- Protected path: the verification policy for audit-log-export lists
-- db/migrations/** as protected. Any change under this directory is
-- flagged by `spec verify` as SBV006 (protected path modified, error).
CREATE TABLE export_log (
  user_id      TEXT        NOT NULL,
  range_start  DATE        NOT NULL,
  range_end    DATE        NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL
);
