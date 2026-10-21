BEGIN;
LOCK TABLE public_onboarding_evidence, public_onboarding_preparations, managed_custody_evidence IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 44 AND name = 'public-onboarding') OR
     EXISTS (SELECT 1 FROM schema_migrations WHERE version > 44) OR
     EXISTS (SELECT 1 FROM public_onboarding_evidence) OR
     EXISTS (SELECT 1 FROM public_onboarding_preparations) OR
     EXISTS (SELECT 1 FROM managed_custody_evidence WHERE verification_mode = 'strict-public-v1') THEN
    RAISE EXCEPTION 'Public onboarding evidence or later migrations prevent rollback' USING ERRCODE = '55000';
  END IF;
END $$;
ALTER TABLE managed_custody_evidence DROP CONSTRAINT managed_custody_evidence_verification_mode_check;
ALTER TABLE managed_custody_evidence ADD CONSTRAINT managed_custody_evidence_verification_mode_check
  CHECK (verification_mode = 'poc-local');
DROP TABLE public_onboarding_evidence;
DROP TABLE public_onboarding_preparations;
DELETE FROM schema_migrations WHERE version = 44;
COMMIT;
