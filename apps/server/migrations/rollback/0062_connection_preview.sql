BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM schema_migrations WHERE version>62) OR EXISTS(SELECT 1 FROM connection_invitations)
    OR EXISTS(SELECT 1 FROM account_connections) OR EXISTS(SELECT 1 FROM connection_approvals) THEN
    RAISE EXCEPTION 'Retained connection consent prevents schema rollback; retain tables for code rollback';
  END IF;
END $$;
DROP TRIGGER connection_preview_fence ON provider_migration_fences;
DROP TRIGGER connection_preview_generation ON account_serving_generations;
DROP TRIGGER connection_preview_custody ON custody_transition_preparations;
DROP FUNCTION hail_connection_preview_cutover();
DROP TABLE connection_approvals;
DROP TABLE account_connections;
DROP TABLE connection_invitations;
DROP FUNCTION hail_guard_connection_pair();
DROP FUNCTION hail_preserve_connection_control();
DELETE FROM schema_migrations WHERE version=62;
COMMIT;
