CREATE TABLE provider_migration_exports (
  transfer_id uuid PRIMARY KEY REFERENCES provider_migration_fences(transfer_id) ON DELETE RESTRICT,
  did text NOT NULL,
  manifest_bytes bytea NOT NULL CHECK (octet_length(manifest_bytes) BETWEEN 1 AND 67108864),
  manifest_digest bytea NOT NULL CHECK (octet_length(manifest_digest) = 32),
  identity_public_key text NOT NULL,
  signature bytea NOT NULL CHECK (octet_length(signature) = 64),
  signing_plc_document jsonb NOT NULL,
  signing_plc_data jsonb NOT NULL,
  signing_plc_operation_log jsonb NOT NULL,
  exported_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- A staged import is deliberately inert. No local account, key or federation
-- row becomes authoritative merely because an operator submitted a snapshot.
CREATE TABLE pending_migration_imports (
  transfer_id uuid PRIMARY KEY,
  did text NOT NULL CHECK (did ~ '^did:plc:[a-z2-7]{24}$'),
  source_service_base text NOT NULL,
  destination_service_base text NOT NULL,
  manifest_bytes bytea NOT NULL CHECK (octet_length(manifest_bytes) BETWEEN 1 AND 67108864),
  manifest_digest bytea NOT NULL CHECK (octet_length(manifest_digest) = 32),
  identity_public_key text NOT NULL,
  signature bytea NOT NULL CHECK (octet_length(signature) = 64),
  state text NOT NULL CHECK (state IN ('staged', 'invalidated')),
  verified_plc_document jsonb NOT NULL,
  verified_plc_data jsonb NOT NULL,
  verified_plc_operation_log jsonb NOT NULL,
  staged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  invalidated_at timestamptz
);

CREATE UNIQUE INDEX pending_migration_one_staged_did_idx
  ON pending_migration_imports(did) WHERE state = 'staged';
