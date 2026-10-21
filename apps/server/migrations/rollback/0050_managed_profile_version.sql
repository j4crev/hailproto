DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM managed_custody_evidence WHERE verification_mode='strict-public-v1') OR
     EXISTS (SELECT 1 FROM public_onboarding_evidence) OR
     EXISTS (SELECT 1 FROM public_plc_resolution_evidence) OR
     EXISTS (SELECT 1 FROM public_cutover_evidence) OR
     EXISTS (SELECT 1 FROM custody_transition_preparations) THEN
    RAISE EXCEPTION 'cannot remove frozen profile versions while production evidence exists';
  END IF;
END $$;

ALTER TABLE public_cutover_evidence DROP COLUMN read_evidence_policy_version, DROP COLUMN record_version;
ALTER TABLE public_plc_resolution_evidence DROP COLUMN read_evidence_policy_version, DROP COLUMN record_version;
ALTER TABLE public_onboarding_evidence DROP COLUMN read_evidence_policy_version, DROP COLUMN record_version;
ALTER TABLE custody_transition_preparations DROP COLUMN managed_profile_version;
ALTER TABLE private_poc_onboarding_preparations DROP CONSTRAINT private_poc_onboarding_managed_profile_version;
ALTER TABLE private_poc_onboarding_preparations DROP COLUMN managed_profile_version;
ALTER TABLE public_onboarding_preparations DROP CONSTRAINT public_onboarding_managed_profile_version;
ALTER TABLE public_onboarding_preparations DROP COLUMN managed_profile_version;
ALTER TABLE managed_custody_evidence DROP COLUMN managed_profile_version;
DELETE FROM schema_migrations WHERE version=50;
