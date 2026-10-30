-- Temporary DNS proof does not claim a domain or create an account.
CREATE TABLE standalone_domain_signups (
  id uuid PRIMARY KEY,
  provider_origin text NOT NULL,
  canonical_address text NOT NULL CHECK (canonical_address=lower(canonical_address)),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash)=32),
  challenge_hash bytea NOT NULL CHECK (octet_length(challenge_hash)=32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '24 hours'),
  next_check_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  verified_at timestamptz,
  authorization_expires_at timestamptz,
  signup_id uuid UNIQUE,
  signup_token_hash bytea,
  request_digest bytea,
  consumed_at timestamptz,
  account_id uuid REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  CHECK (expires_at>created_at),
  CHECK ((verified_at IS NULL AND authorization_expires_at IS NULL) OR
    (verified_at IS NOT NULL AND authorization_expires_at IS NOT NULL AND authorization_expires_at>verified_at)),
  CHECK ((consumed_at IS NULL AND signup_id IS NULL AND signup_token_hash IS NULL AND request_digest IS NULL AND account_id IS NULL) OR
    (consumed_at IS NOT NULL AND signup_id IS NOT NULL AND signup_token_hash IS NOT NULL AND request_digest IS NOT NULL AND octet_length(signup_token_hash)=32 AND octet_length(request_digest)=32 AND verified_at IS NOT NULL))
);
CREATE INDEX standalone_domain_signups_expiry ON standalone_domain_signups(expires_at) WHERE consumed_at IS NULL;
