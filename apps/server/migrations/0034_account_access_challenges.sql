-- Provider-local owner proofs are not portable identity or transfer state.
CREATE TABLE account_access_challenges (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes'),
  completion_hash bytea CHECK (completion_hash IS NULL OR octet_length(completion_hash) = 32),
  credential_id uuid REFERENCES account_api_credentials(id) ON DELETE RESTRICT,
  CHECK ((completion_hash IS NULL) = (credential_id IS NULL))
);
CREATE INDEX account_access_challenges_expiry_idx ON account_access_challenges (expires_at);
