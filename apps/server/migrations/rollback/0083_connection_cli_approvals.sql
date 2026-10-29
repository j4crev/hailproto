BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM connection_approvals WHERE api_credential_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Retained CLI connection approvals prevent schema rollback; retain expanded schema for code rollback';
  END IF;
END $$;
ALTER TABLE connection_approvals DROP CONSTRAINT connection_approval_access,
  DROP COLUMN api_credential_id, ALTER COLUMN session_id SET NOT NULL;
DELETE FROM schema_migrations WHERE version=83;
COMMIT;
