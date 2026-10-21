ALTER TABLE portable_custody_evidence
  ADD COLUMN monitor_public_key text;

CREATE TABLE portable_cutover_observations (
  transfer_id uuid PRIMARY KEY REFERENCES pending_migration_imports(transfer_id) ON DELETE RESTRICT,
  did text NOT NULL CHECK (did ~ '^did:plc:[a-z2-7]{24}$'),
  operation_cid text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  mirror_origins jsonb NOT NULL,
  monitor_attestation_digest bytea NOT NULL CHECK (octet_length(monitor_attestation_digest) = 32),
  state text NOT NULL CHECK (state IN ('quarantined', 'eligible')),
  CHECK (last_seen_at >= first_seen_at)
);
