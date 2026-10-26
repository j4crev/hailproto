-- Drafts cannot be registered by either old or new onboarding writers: only
-- verified preparations are visible to PublicOnboarding.register/activate.
CREATE TABLE public_onboarding_drafts (LIKE public_onboarding_preparations INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE public_onboarding_drafts ALTER COLUMN backup_confirmed_at DROP NOT NULL;
ALTER TABLE public_onboarding_drafts ADD PRIMARY KEY (account_id);
ALTER TABLE public_onboarding_drafts ADD FOREIGN KEY (account_id) REFERENCES provider_accounts(id) ON DELETE RESTRICT;
ALTER TABLE public_onboarding_drafts ADD CHECK (backup_confirmed_at IS NULL AND monitor_assurance='reduced-assurance-alpha-v1');
ALTER TABLE account_signup_ceremonies ADD COLUMN recovery_package boolean NOT NULL DEFAULT false;
ALTER TABLE account_signup_ceremonies ADD COLUMN backup_confirmed_at timestamptz;
ALTER TABLE account_signup_ceremonies ADD COLUMN recovery_operation_digest bytea CHECK (octet_length(recovery_operation_digest)=32);
ALTER TABLE account_signup_ceremonies ADD COLUMN publication_started_at timestamptz;
CREATE FUNCTION hail_preserve_signup_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.recovery_package IS DISTINCT FROM OLD.recovery_package OR
     OLD.backup_confirmed_at IS NOT NULL AND NEW.backup_confirmed_at IS DISTINCT FROM OLD.backup_confirmed_at OR
     OLD.recovery_operation_digest IS NOT NULL AND NEW.recovery_operation_digest IS DISTINCT FROM OLD.recovery_operation_digest OR
     NEW.recovery_package AND NEW.backup_confirmed_at IS NOT NULL AND NEW.recovery_operation_digest IS NULL OR
     NEW.recovery_package AND NEW.operation_bytes IS NOT NULL AND
       (NEW.recovery_operation_digest IS NULL OR sha256(NEW.operation_bytes)<>NEW.recovery_operation_digest) OR
     OLD.publication_started_at IS NOT NULL AND NEW.publication_started_at IS DISTINCT FROM OLD.publication_started_at OR
     NEW.recovery_package AND NEW.publication_started_at IS NOT NULL AND NEW.backup_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'Recovery verification and publication history cannot be replaced';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hail_preserve_signup_recovery BEFORE UPDATE ON account_signup_ceremonies
  FOR EACH ROW EXECUTE FUNCTION hail_preserve_signup_recovery();

-- Also fence older binaries that may try to prepare a new-format ceremony
-- during a rolling deployment. Only the atomic verification transaction can
-- promote its draft; a legacy "backupVerified" assertion cannot upgrade it.
CREATE FUNCTION hail_require_signup_backup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM account_signup_ceremonies
    WHERE token_hash=NEW.signup_token_hash AND recovery_package AND backup_confirmed_at IS NULL) THEN
    RAISE EXCEPTION 'Verify the recovery package before promoting signup preparation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hail_require_signup_backup BEFORE INSERT ON public_onboarding_preparations
  FOR EACH ROW EXECUTE FUNCTION hail_require_signup_backup();
