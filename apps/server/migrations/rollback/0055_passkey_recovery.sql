BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=55) OR
    EXISTS (SELECT 1 FROM schema_migrations WHERE version>55) OR
    EXISTS (SELECT 1 FROM account_passkey_enrollment_capabilities WHERE consumed_at IS NULL AND expires_at>clock_timestamp()) OR
    EXISTS (SELECT 1 FROM account_access_challenges WHERE payload ->> 'purpose'='passkey-enrollment' AND completion_hash IS NULL AND expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'Rollback would discard active passkey recovery';
  END IF;
END $$;
DELETE FROM account_passkey_challenges WHERE enrollment_capability_id IS NOT NULL;
DELETE FROM account_access_challenges WHERE payload ->> 'purpose' = 'passkey-enrollment';
ALTER TABLE account_passkey_challenges DROP COLUMN enrollment_capability_id;
ALTER TABLE account_access_challenges DROP CONSTRAINT account_access_challenges_completion_target_check;
ALTER TABLE account_access_challenges DROP COLUMN enrollment_capability_id;
ALTER TABLE account_access_challenges ADD CONSTRAINT account_access_challenges_check1
  CHECK ((completion_hash IS NULL) = (credential_id IS NULL));
DROP TABLE account_passkey_enrollment_capabilities;
DELETE FROM schema_migrations WHERE version = 55;
COMMIT;
