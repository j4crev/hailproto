-- Provider-local, exact-action passkey approvals; never portable account authority.
CREATE TABLE account_grant_approvals (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  serving_generation bigint NOT NULL CHECK (serving_generation > 0),
  session_id uuid NOT NULL REFERENCES account_passkey_sessions(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('allow','revoke')),
  request_digest bytea NOT NULL CHECK (octet_length(request_digest)=32),
  payload_bytes bytea NOT NULL CHECK (octet_length(payload_bytes) BETWEEN 1 AND 16384),
  signing_key text NOT NULL CHECK (length(signing_key) BETWEEN 10 AND 256),
  challenge text NOT NULL UNIQUE CHECK (length(challenge)=43 AND challenge ~ '^[A-Za-z0-9_-]+$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '5 minutes'),
  approved_at timestamptz,
  credential_id text REFERENCES account_passkeys(credential_id) ON DELETE RESTRICT,
  result jsonb,
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '6 minutes'),
  CHECK ((approved_at IS NULL)=(credential_id IS NULL)),
  CHECK (result IS NULL OR approved_at IS NOT NULL)
);
CREATE INDEX account_grant_approvals_account_idx ON account_grant_approvals(account_id,expires_at);

CREATE FUNCTION hail_preserve_grant_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.account_id,NEW.serving_generation,NEW.session_id,NEW.action,NEW.request_digest,
         NEW.payload_bytes,NEW.signing_key,NEW.challenge,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.account_id,OLD.serving_generation,OLD.session_id,OLD.action,OLD.request_digest,
         OLD.payload_bytes,OLD.signing_key,OLD.challenge,OLD.created_at,OLD.expires_at)
    OR OLD.approved_at IS NOT NULL AND ROW(NEW.approved_at,NEW.credential_id) IS DISTINCT FROM ROW(OLD.approved_at,OLD.credential_id)
    OR OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result THEN
    RAISE EXCEPTION 'Exact Grant approval intent and terminal proof cannot be replaced';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hail_preserve_grant_approval BEFORE UPDATE ON account_grant_approvals
  FOR EACH ROW EXECUTE FUNCTION hail_preserve_grant_approval();
