BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=54) OR
    EXISTS (SELECT 1 FROM schema_migrations WHERE version>54) OR
    EXISTS (SELECT 1 FROM account_passkeys WHERE revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Rollback would remove active passkey access' USING ERRCODE = '55000';
  END IF;
END $$;
DROP TABLE account_passkey_sessions;
DROP TABLE account_passkey_challenges;
DROP TABLE account_passkeys;
DELETE FROM schema_migrations WHERE version=54;
COMMIT;
