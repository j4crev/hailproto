-- A rollback must not discard consumed invitations or admitted setup authority.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM provider_signup_admissions)
    OR EXISTS(SELECT 1 FROM account_signup_ceremonies WHERE invitation_id IS NULL)
    OR EXISTS(SELECT 1 FROM provider_registration_audit) THEN
    RAISE EXCEPTION 'Registration policy has been used; retain admission and audit evidence';
  END IF;
END $$;
ALTER TABLE account_signup_ceremonies ALTER COLUMN invitation_id SET NOT NULL;
DROP TABLE provider_signup_admissions;
DROP TABLE provider_registration_audit;
DROP TABLE provider_registration_settings;
DELETE FROM schema_migrations WHERE version=78;
