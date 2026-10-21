-- Provider-local authentication secrets never enter portable DID snapshots.
CREATE TABLE account_api_credentials (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes) = 'array'
    AND jsonb_array_length(scopes) BETWEEN 1 AND 3
    AND scopes <@ '["account:read","grants:read","grants:write"]'::jsonb),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  revoked_at timestamptz
);
CREATE INDEX account_api_credentials_account_idx ON account_api_credentials (account_id);
