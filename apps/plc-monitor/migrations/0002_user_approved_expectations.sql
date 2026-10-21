CREATE TABLE monitor_approvals (
  did text NOT NULL REFERENCES monitored_dids(did) ON DELETE RESTRICT,
  operation_cid text NOT NULL,
  previous_expected_cid text NOT NULL,
  approved_state jsonb NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (did, operation_cid)
);
