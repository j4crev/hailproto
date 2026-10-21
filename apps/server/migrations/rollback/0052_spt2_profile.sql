BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=52) OR
    EXISTS (SELECT 1 FROM schema_migrations WHERE version>52) OR
    EXISTS (SELECT 1 FROM verified_body_provenance WHERE profile='spt-2') THEN
    RAISE EXCEPTION 'cannot discard retained spt-2 bodies';
  END IF;
END $$;
ALTER TABLE verified_body_provenance
  DROP CONSTRAINT verified_body_provenance_profile_check,
  ADD CONSTRAINT verified_body_provenance_profile_check CHECK (profile='spt-1');
DELETE FROM schema_migrations WHERE version=52;
COMMIT;
