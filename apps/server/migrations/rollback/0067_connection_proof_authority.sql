BEGIN;
LOCK TABLE connection_proof_signatures IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM schema_migrations WHERE version>67) OR EXISTS(SELECT 1 FROM connection_proof_signatures) THEN
    RAISE EXCEPTION 'Retained connection proof authority prevents schema rollback';
  END IF;
END $$;
DROP TABLE connection_proof_signatures;
DELETE FROM schema_migrations WHERE version=67;
COMMIT;
