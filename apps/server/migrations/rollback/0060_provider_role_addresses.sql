-- Run only after rolling back application code that queries these tables.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM provider_role_claims) THEN
    RAISE EXCEPTION 'Cannot roll back provider-role protection after operator assignments';
  END IF;
END; $$;
DROP TRIGGER provider_accounts_role_address ON provider_accounts;
DROP FUNCTION enforce_provider_role_address();
DROP TABLE provider_role_claims;
DROP TABLE provider_reserved_names;
DELETE FROM schema_migrations WHERE version = 60;
COMMIT;
