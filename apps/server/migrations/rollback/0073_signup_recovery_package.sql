BEGIN;
-- Do not discard recovery/resume evidence, including expired provisional setups.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version>73) OR EXISTS (SELECT 1 FROM account_signup_ceremonies WHERE recovery_package) OR EXISTS (SELECT 1 FROM public_onboarding_drafts) THEN
    RAISE EXCEPTION 'Retain recovery package ceremonies; rollback would discard signup evidence';
  END IF;
END $$;
DROP TRIGGER hail_require_signup_backup ON public_onboarding_preparations;
DROP FUNCTION hail_require_signup_backup();
DROP TRIGGER hail_preserve_signup_recovery ON account_signup_ceremonies;
DROP FUNCTION hail_preserve_signup_recovery();
ALTER TABLE account_signup_ceremonies DROP COLUMN recovery_operation_digest, DROP COLUMN publication_started_at, DROP COLUMN backup_confirmed_at, DROP COLUMN recovery_package;
DROP TABLE public_onboarding_drafts;
DELETE FROM schema_migrations WHERE version=73;
COMMIT;
