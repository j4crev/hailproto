ALTER TABLE private_poc_onboarding_preparations
  ADD COLUMN custody_profile text NOT NULL DEFAULT 'owner-controlled' CHECK (custody_profile IN ('owner-controlled','managed')),
  ADD COLUMN signup_token_hash bytea CHECK (signup_token_hash IS NULL OR octet_length(signup_token_hash)=32),
  ADD COLUMN initial_binding_cose bytea;
CREATE TABLE managed_custody_evidence (
  account_id uuid PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  owner_recovery_public_key text NOT NULL,
  provider_identity_public_key text NOT NULL,
  verification_mode text NOT NULL CHECK (verification_mode='poc-local'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER hail_fence_managed_custody BEFORE INSERT OR UPDATE OR DELETE ON managed_custody_evidence
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account','account_id');
ALTER TABLE account_api_credentials DROP CONSTRAINT account_api_credentials_scopes_check;
ALTER TABLE account_api_credentials ADD CONSTRAINT account_api_credentials_scopes_check CHECK (
  jsonb_typeof(scopes)='array' AND jsonb_array_length(scopes) BETWEEN 1 AND 6
  AND scopes <@ '["account:read","grants:read","grants:write","credentials:write","messages:read","messages:write"]'::jsonb);
