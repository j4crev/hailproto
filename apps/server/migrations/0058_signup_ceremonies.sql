CREATE TABLE account_signup_ceremonies (
  id uuid PRIMARY KEY,
  invitation_id uuid NOT NULL UNIQUE,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash)=32),
  enrollment_hash bytea NOT NULL UNIQUE CHECK (octet_length(enrollment_hash)=32 AND enrollment_hash<>token_hash),
  request_digest bytea NOT NULL CHECK (octet_length(request_digest)=32),
  request jsonb NOT NULL CHECK (jsonb_typeof(request)='object'),
  account_id uuid UNIQUE REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  account_generation bigint CHECK (account_generation>0),
  preparation jsonb CHECK (jsonb_typeof(preparation)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '24 hours'),
  operation_bytes bytea CHECK (octet_length(operation_bytes) BETWEEN 1 AND 16384),
  monitor_payload bytea CHECK (octet_length(monitor_payload) BETWEEN 1 AND 4096),
  monitor_signature bytea CHECK (octet_length(monitor_signature)=64),
  activation_epoch uuid,
  enrollment_capability_id uuid UNIQUE,
  enrollment_issued_at timestamptz,
  enrollment_expires_at timestamptz,
  enrollment_generation bigint,
  enrolled_at timestamptz,
  enrolled_credential_id text REFERENCES account_passkeys(credential_id) ON DELETE RESTRICT,
  completed_at timestamptz,
  completed_by text REFERENCES account_passkeys(credential_id) ON DELETE RESTRICT,
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '25 hours'),
  CHECK (num_nonnulls(account_id,account_generation,preparation) IN (0,3)),
  CHECK ((monitor_payload IS NULL)=(monitor_signature IS NULL)),
  CHECK (num_nonnulls(enrollment_capability_id,enrollment_issued_at,enrollment_expires_at,enrollment_generation) IN (0,4)),
  CHECK (enrollment_generation IS NULL OR enrollment_generation>0),
  CHECK (enrollment_generation IS NULL OR enrollment_generation=account_generation),
  CHECK (enrollment_expires_at IS NULL OR enrollment_expires_at>enrollment_issued_at AND enrollment_expires_at<=enrollment_issued_at+interval '10 minutes'),
  CHECK ((enrolled_at IS NULL)=(enrolled_credential_id IS NULL)),
  CHECK ((completed_at IS NULL)=(completed_by IS NULL)),
  CHECK (completed_at IS NULL OR enrolled_at IS NOT NULL)
);

CREATE FUNCTION hail_preserve_signup_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Signup intent and terminal authority must be retained'; END IF;
  IF ROW(NEW.id,NEW.invitation_id,NEW.token_hash,NEW.enrollment_hash,NEW.request_digest,NEW.request,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.invitation_id,OLD.token_hash,OLD.enrollment_hash,OLD.request_digest,OLD.request,OLD.created_at,OLD.expires_at)
    OR OLD.account_id IS NOT NULL AND NEW.account_id IS DISTINCT FROM OLD.account_id
    OR OLD.account_generation IS NOT NULL AND NEW.account_generation IS DISTINCT FROM OLD.account_generation
    OR OLD.preparation IS NOT NULL AND NEW.preparation IS DISTINCT FROM OLD.preparation
    OR OLD.operation_bytes IS NOT NULL AND NEW.operation_bytes IS DISTINCT FROM OLD.operation_bytes
    OR OLD.enrollment_issued_at IS NOT NULL AND ROW(NEW.enrollment_capability_id,NEW.enrollment_issued_at,NEW.enrollment_expires_at,NEW.enrollment_generation)
       IS DISTINCT FROM ROW(OLD.enrollment_capability_id,OLD.enrollment_issued_at,OLD.enrollment_expires_at,OLD.enrollment_generation)
    OR OLD.enrolled_at IS NOT NULL AND ROW(NEW.enrolled_at,NEW.enrolled_credential_id) IS DISTINCT FROM ROW(OLD.enrolled_at,OLD.enrolled_credential_id)
    OR OLD.completed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Signup intent or terminal authority cannot be replaced';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hail_preserve_signup_intent BEFORE UPDATE OR DELETE ON account_signup_ceremonies
  FOR EACH ROW EXECUTE FUNCTION hail_preserve_signup_intent();
CREATE TRIGGER hail_signup_no_truncate BEFORE TRUNCATE ON account_signup_ceremonies
  FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_public_plc_authority();
