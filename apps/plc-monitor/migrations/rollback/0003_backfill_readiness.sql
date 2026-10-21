BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version > 3) THEN
    RAISE EXCEPTION 'Remove later monitor migrations before rolling back readiness';
  END IF;
  IF EXISTS (SELECT 1 FROM monitored_dids) AND
     EXISTS (SELECT 1 FROM monitor_cursor WHERE NOT caught_up) THEN
    RAISE EXCEPTION 'Cannot discard incomplete backfill readiness for enrolled DIDs';
  END IF;
  IF EXISTS (SELECT 1 FROM monitor_bootstrap_checkpoints) THEN
    RAISE EXCEPTION 'Cannot discard sole reviewed bootstrap checkpoint evidence';
  END IF;
END $$;
DROP TABLE monitor_bootstrap_checkpoints;
ALTER TABLE monitor_cursor DROP COLUMN caught_up;
DELETE FROM schema_migrations WHERE version = 3;
COMMIT;
