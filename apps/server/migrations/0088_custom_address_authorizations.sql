CREATE TABLE custom_address_authorizations (
  id uuid PRIMARY KEY,
  domain_id uuid NOT NULL REFERENCES account_custom_domains(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  account_generation bigint NOT NULL CHECK (account_generation > 0),
  provider_origin text NOT NULL,
  canonical_address text NOT NULL UNIQUE CHECK (canonical_address = lower(canonical_address)),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  signup_id uuid UNIQUE,
  signup_token_hash bytea CHECK (signup_token_hash IS NULL OR octet_length(signup_token_hash) = 32),
  request_digest bytea CHECK (request_digest IS NULL OR octet_length(request_digest) = 32),
  consumed_at timestamptz,
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '15 minutes'),
  CHECK ((consumed_at IS NULL AND signup_id IS NULL AND signup_token_hash IS NULL AND request_digest IS NULL) OR
    (consumed_at IS NOT NULL AND signup_id IS NOT NULL AND signup_token_hash IS NOT NULL AND request_digest IS NOT NULL))
);
CREATE INDEX custom_address_authorizations_owner ON custom_address_authorizations(account_id, expires_at);
CREATE TRIGGER hail_fence_custom_address_authorizations BEFORE INSERT OR UPDATE OR DELETE ON custom_address_authorizations
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account', 'account_id');
