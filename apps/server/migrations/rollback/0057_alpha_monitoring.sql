BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=57) OR
    EXISTS (SELECT 1 FROM schema_migrations WHERE version>57) OR
    EXISTS (SELECT 1 FROM public_onboarding_preparations WHERE monitor_assurance<>'independent') OR
    EXISTS (SELECT 1 FROM public_onboarding_evidence WHERE monitor_assurance<>'independent') OR
    EXISTS (SELECT 1 FROM managed_custody_evidence WHERE verification_mode='reduced-assurance-alpha-v1') THEN
    RAISE EXCEPTION 'Alpha monitoring records prevent rollback';
  END IF;
END $$;
DROP TRIGGER hail_preserve_alpha_monitor_assurance ON managed_custody_evidence;
DROP FUNCTION hail_preserve_alpha_monitor_assurance();
ALTER TABLE managed_custody_evidence DROP CONSTRAINT managed_custody_evidence_verification_mode_check;
ALTER TABLE managed_custody_evidence ADD CONSTRAINT managed_custody_evidence_verification_mode_check
  CHECK (verification_mode IN ('poc-local', 'strict-public-v1'));
ALTER TABLE public_onboarding_evidence DROP CONSTRAINT public_onboarding_monitor_assurance_match;
ALTER TABLE public_onboarding_evidence DROP COLUMN monitor_assurance;
ALTER TABLE public_onboarding_preparations DROP CONSTRAINT public_onboarding_monitor_assurance_unique;
ALTER TABLE public_onboarding_preparations DROP CONSTRAINT public_onboarding_monitor_assurance_custody;
ALTER TABLE public_onboarding_preparations DROP COLUMN monitor_assurance;
DELETE FROM schema_migrations WHERE version=57;
COMMIT;
