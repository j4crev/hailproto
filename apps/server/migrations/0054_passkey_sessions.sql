-- Passkeys and sessions are provider-local access state. They never enter
-- portable snapshots or substitute for Hail/PLC signing authority.
CREATE TABLE account_passkeys (
  credential_id text PRIMARY KEY CHECK (length(credential_id) BETWEEN 1 AND 1366 AND credential_id ~ '^[A-Za-z0-9_-]+$'),
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  serving_generation bigint NOT NULL CHECK (serving_generation > 0),
  public_key bytea NOT NULL CHECK (octet_length(public_key) BETWEEN 32 AND 2048),
  signature_counter bigint NOT NULL DEFAULT 0 CHECK (signature_counter >= 0),
  device_type text NOT NULL CHECK (device_type IN ('singleDevice','multiDevice')),
  backed_up boolean NOT NULL,
  transports jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(transports) = 'array'),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (credential_id, account_id, serving_generation)
);
CREATE INDEX account_passkeys_account_idx ON account_passkeys (account_id, created_at);

CREATE TABLE account_passkey_challenges (
  id uuid PRIMARY KEY,
  challenge text NOT NULL UNIQUE CHECK (length(challenge) BETWEEN 32 AND 512 AND challenge ~ '^[A-Za-z0-9_-]+$'),
  purpose text NOT NULL CHECK (purpose IN ('registration','authentication')),
  account_id uuid REFERENCES provider_accounts(id) ON DELETE CASCADE,
  serving_generation bigint CHECK (serving_generation IS NULL OR serving_generation > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  CHECK ((purpose = 'registration') = (account_id IS NOT NULL AND serving_generation IS NOT NULL))
);
CREATE INDEX account_passkey_challenges_expiry_idx ON account_passkey_challenges (expires_at);

CREATE TABLE account_passkey_sessions (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  credential_id text NOT NULL,
  serving_generation bigint NOT NULL CHECK (serving_generation > 0),
  scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes) = 'array' AND scopes =
    '["account:read","grants:read","messages:read","messages:write"]'::jsonb),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  revoked_at timestamptz,
  FOREIGN KEY (credential_id, account_id, serving_generation)
    REFERENCES account_passkeys(credential_id, account_id, serving_generation) ON DELETE RESTRICT
);
CREATE INDEX account_passkey_sessions_account_idx ON account_passkey_sessions (account_id, expires_at);
