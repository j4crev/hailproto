CREATE TABLE detached_bodies (
  digest bytea NOT NULL CHECK (octet_length(digest) = 32),
  sender_account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  body_bytes bytea NOT NULL CHECK (octet_length(body_bytes) BETWEEN 1 AND 262144),
  available_until bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (available_until IS NULL OR available_until > 0),
  PRIMARY KEY (digest, sender_account_id)
);

CREATE TABLE body_authorizations (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  body_digest bytea NOT NULL,
  sender_account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  recipient_did text NOT NULL CHECK (recipient_did ~ '^did:plc:[a-z2-7]{24}$'),
  message_id uuid NOT NULL CHECK (message_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  expires_at bigint NOT NULL CHECK (expires_at > 0),
  available_until bigint NOT NULL CHECK (available_until > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sender_account_id, message_id),
  FOREIGN KEY (body_digest, sender_account_id) REFERENCES detached_bodies(digest, sender_account_id) ON DELETE RESTRICT
);

CREATE INDEX body_authorizations_expiry_idx ON body_authorizations(expires_at);
