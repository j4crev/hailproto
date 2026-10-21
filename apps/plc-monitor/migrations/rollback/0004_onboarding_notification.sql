BEGIN;
LOCK TABLE monitor_alerts IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 4) OR
     EXISTS (SELECT 1 FROM schema_migrations WHERE version > 4) OR
     EXISTS (SELECT 1 FROM monitor_alerts WHERE category = 'onboarding-enrollment') THEN
    RAISE EXCEPTION 'Onboarding notification evidence or later migrations prevent rollback' USING ERRCODE = '55000';
  END IF;
END $$;
ALTER TABLE monitor_alerts DROP CONSTRAINT monitor_alerts_category_check;
ALTER TABLE monitor_alerts ADD CONSTRAINT monitor_alerts_category_check
  CHECK (category IN ('unexpected-operation', 'coverage-lost', 'invalid-operation-log', 'export-gap'));
DELETE FROM schema_migrations WHERE version = 4;
COMMIT;
