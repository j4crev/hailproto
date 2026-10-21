BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=5) OR
    EXISTS (SELECT 1 FROM schema_migrations WHERE version>5) OR
    EXISTS (SELECT 1 FROM monitored_dids WHERE last_audit IS NOT NULL OR coverage_since IS NOT NULL OR last_polled_at IS NOT NULL OR poll_ready)
    OR EXISTS (SELECT 1 FROM monitor_observations WHERE seq IS NULL) THEN
    RAISE EXCEPTION 'cannot discard per-DID monitor evidence';
  END IF;
END $$;

ALTER TABLE monitor_observations ALTER COLUMN seq SET NOT NULL;
ALTER TABLE monitor_observations ADD CONSTRAINT monitor_observations_seq_key UNIQUE (seq);
ALTER TABLE monitored_dids DROP COLUMN poll_ready;
ALTER TABLE monitored_dids DROP COLUMN last_polled_at;
ALTER TABLE monitored_dids DROP COLUMN coverage_since;
ALTER TABLE monitored_dids DROP COLUMN last_audit;
DELETE FROM schema_migrations WHERE version=5;
COMMIT;
