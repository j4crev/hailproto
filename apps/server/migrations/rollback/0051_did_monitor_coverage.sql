BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=51) OR
    EXISTS (SELECT 1 FROM schema_migrations WHERE version>51) OR
    EXISTS (SELECT 1 FROM public_onboarding_evidence WHERE monitor_export_sequence IS NULL) THEN
    RAISE EXCEPTION 'cannot discard per-DID monitor coverage evidence';
  END IF;
END $$;
ALTER TABLE public_onboarding_evidence ALTER COLUMN monitor_export_sequence SET NOT NULL;
DELETE FROM schema_migrations WHERE version=51;
COMMIT;
