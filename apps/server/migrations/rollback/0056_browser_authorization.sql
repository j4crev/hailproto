BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=56) OR
    EXISTS (SELECT 1 FROM schema_migrations WHERE version>56) OR
    EXISTS (SELECT 1 FROM account_browser_authorizations WHERE exchanged_at IS NULL AND expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'Rollback would discard active browser authorization';
  END IF;
END $$;
DROP TABLE account_browser_authorizations;
DELETE FROM schema_migrations WHERE version=56;
COMMIT;
