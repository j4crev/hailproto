BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=58) OR
    EXISTS (SELECT 1 FROM schema_migrations WHERE version>58) OR
    EXISTS (SELECT 1 FROM account_signup_ceremonies) THEN
    RAISE EXCEPTION 'Retained signup ceremonies prevent rollback';
  END IF;
END $$;
DROP TABLE account_signup_ceremonies;
DROP FUNCTION hail_preserve_signup_intent();
DELETE FROM schema_migrations WHERE version=58;
COMMIT;
