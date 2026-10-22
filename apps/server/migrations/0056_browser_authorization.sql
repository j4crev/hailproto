-- Browser authorization is provider-local. Codes are hashed, one-use, and
-- bound to the exact loopback redirect, PKCE challenge, account and generation.
CREATE TABLE account_browser_authorizations (
  id uuid PRIMARY KEY,
  client_id text NOT NULL CHECK (client_id = 'hailp-cli-v1'),
  redirect_uri text NOT NULL CHECK (length(redirect_uri) BETWEEN 20 AND 128),
  state text NOT NULL CHECK (state ~ '^[A-Za-z0-9_-]{43}$'),
  code_hash bytea NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes) = 'array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes'),
  account_id uuid REFERENCES provider_accounts(id) ON DELETE CASCADE,
  serving_generation bigint CHECK (serving_generation IS NULL OR serving_generation > 0),
  completed_at timestamptz,
  exchanged_at timestamptz,
  credential_id uuid REFERENCES account_api_credentials(id) ON DELETE RESTRICT,
  CHECK ((completed_at IS NULL) = (account_id IS NULL)),
  CHECK ((completed_at IS NULL) = (serving_generation IS NULL)),
  CHECK ((exchanged_at IS NULL) = (credential_id IS NULL)),
  CHECK (exchanged_at IS NULL OR completed_at IS NOT NULL)
);
CREATE INDEX account_browser_authorizations_expiry_idx ON account_browser_authorizations (expires_at);
