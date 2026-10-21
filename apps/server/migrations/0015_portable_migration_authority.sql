-- Provider-authenticated snapshots use the current operational messaging key;
-- the user's independent identity signature authorizes the exact transfer.
ALTER TABLE provider_migration_exports
  RENAME COLUMN identity_public_key TO source_messaging_public_key;
ALTER TABLE pending_migration_imports
  RENAME COLUMN identity_public_key TO source_messaging_public_key;

ALTER TABLE provider_migration_fences
  ADD COLUMN destination_rotation_public_key text,
  ADD COLUMN destination_messaging_public_key text;

CREATE TABLE portable_custody_evidence (
  account_id uuid PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  user_recovery_public_key text NOT NULL,
  user_identity_public_key text NOT NULL,
  monitor_origin text NOT NULL,
  monitor_confirmed_at timestamptz NOT NULL,
  backup_confirmed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (user_recovery_public_key <> user_identity_public_key)
);

-- A portable account must not store either user private key. The provider may
-- retain public role metadata and its own lower-priority operational secrets.
CREATE FUNCTION hail_require_portable_key_separation() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'portable_custody_evidence' THEN
    IF EXISTS (SELECT 1 FROM account_keys WHERE account_id = NEW.account_id AND role = 'hail-identity') THEN
      RAISE EXCEPTION 'Portable custody forbids provider identity private-key storage';
    END IF;
  ELSIF NEW.role = 'hail-identity' AND EXISTS (
    SELECT 1 FROM portable_custody_evidence WHERE account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'Portable custody forbids provider identity private-key storage';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hail_portable_custody_record BEFORE INSERT OR UPDATE ON portable_custody_evidence
  FOR EACH ROW EXECUTE FUNCTION hail_require_portable_key_separation();
CREATE TRIGGER hail_portable_key_record BEFORE INSERT OR UPDATE ON account_keys
  FOR EACH ROW EXECUTE FUNCTION hail_require_portable_key_separation();
CREATE TRIGGER hail_fence_portable_custody BEFORE INSERT OR UPDATE OR DELETE ON portable_custody_evidence
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account', 'account_id');

ALTER TABLE pending_migration_imports
  ADD COLUMN user_consent_payload bytea,
  ADD COLUMN user_consent_signature bytea,
  ADD COLUMN user_identity_public_key text,
  ADD CONSTRAINT pending_migration_consent_shape CHECK (
    (user_consent_payload IS NULL AND user_consent_signature IS NULL AND user_identity_public_key IS NULL) OR
    (octet_length(user_consent_payload) BETWEEN 1 AND 16384 AND
     octet_length(user_consent_signature) = 64 AND user_identity_public_key IS NOT NULL)
  );
