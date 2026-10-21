CREATE TABLE prepared_migration_target_keys (
  transfer_id uuid PRIMARY KEY,
  did text NOT NULL CHECK (did ~ '^did:plc:[a-z2-7]{24}$'),
  destination_service_base text NOT NULL,
  rotation_public_key text NOT NULL,
  rotation_private_ciphertext bytea NOT NULL CHECK (octet_length(rotation_private_ciphertext) >= 17),
  rotation_nonce bytea NOT NULL CHECK (octet_length(rotation_nonce) = 12),
  messaging_public_key text NOT NULL,
  messaging_private_ciphertext bytea NOT NULL CHECK (octet_length(messaging_private_ciphertext) >= 17),
  messaging_nonce bytea NOT NULL CHECK (octet_length(messaging_nonce) = 12),
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared', 'staged', 'invalidated')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (rotation_public_key <> messaging_public_key)
);

CREATE UNIQUE INDEX prepared_migration_one_current_did_idx
  ON prepared_migration_target_keys (did) WHERE state IN ('prepared', 'staged');
