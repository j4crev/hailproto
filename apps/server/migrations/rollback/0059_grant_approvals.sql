BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=59) OR
    EXISTS (SELECT 1 FROM schema_migrations WHERE version>59) OR
    EXISTS (SELECT 1 FROM account_grant_approvals) THEN
    RAISE EXCEPTION 'Retained Grant approvals prevent rollback; use compatible code without deleting consent evidence';
  END IF;
END $$;
DROP TABLE account_grant_approvals;
DROP FUNCTION hail_preserve_grant_approval();
DELETE FROM schema_migrations WHERE version=59;
COMMIT;
