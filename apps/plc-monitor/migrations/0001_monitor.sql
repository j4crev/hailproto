CREATE TABLE monitor_cursor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_seq bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  last_healthy_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO monitor_cursor(singleton) VALUES (true);

CREATE TABLE monitored_dids (
  did text PRIMARY KEY CHECK (did ~ '^did:plc:[a-z2-7]{24}$'),
  expected_cid text NOT NULL,
  expected_state jsonb NOT NULL,
  alert_webhook_url text NOT NULL,
  enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_verified_cid text,
  last_verified_at timestamptz
);

CREATE TABLE monitor_observations (
  did text NOT NULL REFERENCES monitored_dids(did) ON DELETE RESTRICT,
  cid text NOT NULL,
  seq bigint NOT NULL CHECK (seq >= 0),
  operation jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expected boolean NOT NULL,
  PRIMARY KEY (did, cid),
  UNIQUE (seq)
);

CREATE TABLE monitor_alerts (
  id uuid PRIMARY KEY,
  did text,
  category text NOT NULL CHECK (category IN ('unexpected-operation', 'coverage-lost', 'invalid-operation-log', 'export-gap')),
  correlation text NOT NULL UNIQUE,
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX monitor_alerts_pending_idx ON monitor_alerts(next_attempt_at) WHERE sent_at IS NULL;
