-- Signed destination request observed over the user-authorized HTTPS origin.
-- A signed self-asserted did:key alone cannot authorize a source fence.
ALTER TABLE provider_transfer_authorizations
  ADD COLUMN origin_request_bytes bytea,
  ADD COLUMN origin_request_signature bytea,
  ADD COLUMN origin_confirmed_at timestamptz,
  ADD CONSTRAINT hail_transfer_origin_proof_complete CHECK (
    (origin_request_bytes IS NULL AND origin_request_signature IS NULL AND origin_confirmed_at IS NULL)
    OR (origin_request_bytes IS NOT NULL AND origin_request_signature IS NOT NULL AND origin_confirmed_at IS NOT NULL)
  );

-- The destination returns the same signed request for every exact retry.
CREATE TABLE received_transfer_invitations (
  did text PRIMARY KEY CHECK (did ~ '^did:plc:[a-z2-7]{24}$'),
  nonce uuid NOT NULL UNIQUE,
  grant_digest bytea NOT NULL CHECK (octet_length(grant_digest) = 32),
  invitation_digest bytea NOT NULL CHECK (octet_length(invitation_digest) = 32),
  transfer_id uuid NOT NULL UNIQUE REFERENCES prepared_migration_target_keys(transfer_id) ON DELETE RESTRICT,
  request_bytes bytea NOT NULL,
  request_signature bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
