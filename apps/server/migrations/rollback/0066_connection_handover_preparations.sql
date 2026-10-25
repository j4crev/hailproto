BEGIN;
LOCK TABLE connection_handover_preparations IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM schema_migrations WHERE version>66) OR EXISTS(SELECT 1 FROM connection_handover_preparations) THEN
    RAISE EXCEPTION 'Retained connection handover evidence prevents schema rollback';
  END IF;
END $$;
DROP TABLE connection_handover_preparations;
DELETE FROM schema_migrations WHERE version=66;
COMMIT;
