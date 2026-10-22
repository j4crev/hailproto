-- Owner-proof recovery yields one short-lived provider-local enrollment token,
-- never browser access to owner keys or a long-lived API credential.
CREATE TABLE account_passkey_enrollment_capabilities (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  serving_generation bigint NOT NULL CHECK (serving_generation > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  consumed_at timestamptz,
  credential_id text REFERENCES account_passkeys(credential_id) ON DELETE RESTRICT,
  CHECK ((consumed_at IS NULL) = (credential_id IS NULL))
);
CREATE INDEX account_passkey_enrollment_capabilities_expiry_idx
  ON account_passkey_enrollment_capabilities (expires_at);

ALTER TABLE account_access_challenges DROP CONSTRAINT account_access_challenges_check1;
ALTER TABLE account_access_challenges ADD COLUMN enrollment_capability_id uuid
  REFERENCES account_passkey_enrollment_capabilities(id) ON DELETE CASCADE;
ALTER TABLE account_access_challenges ADD CONSTRAINT account_access_challenges_completion_target_check CHECK (
  completion_hash IS NULL AND credential_id IS NULL AND enrollment_capability_id IS NULL OR
  completion_hash IS NOT NULL AND num_nonnulls(credential_id,enrollment_capability_id) = 1
);

ALTER TABLE account_passkey_challenges ADD COLUMN enrollment_capability_id uuid
  REFERENCES account_passkey_enrollment_capabilities(id) ON DELETE CASCADE;
