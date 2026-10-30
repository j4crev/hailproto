-- Provider-local domain administration is separate from account identity.
CREATE TABLE account_custom_domains (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  domain text NOT NULL CHECK (domain = lower(domain) AND octet_length(domain) <= 253),
  provider_host text NOT NULL,
  challenge_hash bytea NOT NULL CHECK (octet_length(challenge_hash) = 32),
  challenge_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  challenge_created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  next_check_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ownership_checked_at timestamptz,
  delegation_checked_at timestamptz,
  verified_at timestamptz,
  UNIQUE (account_id, domain)
);
-- Pending attempts never reserve another user's namespace. Only completed proof
-- claims the domain; racing claims are serialized by this unique index.
CREATE UNIQUE INDEX account_custom_domains_verified_domain
  ON account_custom_domains(domain) WHERE verified_at IS NOT NULL;
CREATE TRIGGER hail_fence_custom_domains BEFORE INSERT OR UPDATE OR DELETE ON account_custom_domains
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account', 'account_id');
