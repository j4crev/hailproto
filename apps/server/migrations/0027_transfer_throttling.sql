-- Provider-process-shared rate limits; the few global buckets are bounded
-- independently of attacker-supplied DIDs. Per-DID buckets are created only
-- after structural validation and capped by the global bucket.
CREATE TABLE transfer_rate_limits (
  bucket text PRIMARY KEY,
  window_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0)
);
CREATE INDEX hail_transfer_rate_window ON transfer_rate_limits (window_started_at);
