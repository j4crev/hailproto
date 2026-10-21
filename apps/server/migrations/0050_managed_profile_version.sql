-- Freeze profile identifiers independently from custody, registry and
-- activation modes. Existing candidate rows were all created under v1.
ALTER TABLE managed_custody_evidence
  ADD COLUMN managed_profile_version text NOT NULL DEFAULT 'hail-managed-custody-v1'
    CHECK (managed_profile_version = 'hail-managed-custody-v1');
ALTER TABLE managed_custody_evidence ALTER COLUMN managed_profile_version DROP DEFAULT;

ALTER TABLE public_onboarding_preparations ADD COLUMN managed_profile_version text;
UPDATE public_onboarding_preparations SET managed_profile_version='hail-managed-custody-v1'
  WHERE custody_profile='managed';
ALTER TABLE public_onboarding_preparations ADD CONSTRAINT public_onboarding_managed_profile_version CHECK (
  (custody_profile='managed' AND managed_profile_version='hail-managed-custody-v1') OR
  (custody_profile='owner-controlled' AND managed_profile_version IS NULL)
);

ALTER TABLE private_poc_onboarding_preparations ADD COLUMN managed_profile_version text;
UPDATE private_poc_onboarding_preparations SET managed_profile_version='hail-managed-custody-v1'
  WHERE custody_profile='managed';
ALTER TABLE private_poc_onboarding_preparations ADD CONSTRAINT private_poc_onboarding_managed_profile_version CHECK (
  (custody_profile='managed' AND managed_profile_version='hail-managed-custody-v1') OR
  (custody_profile='owner-controlled' AND managed_profile_version IS NULL)
);

ALTER TABLE custody_transition_preparations
  ADD COLUMN managed_profile_version text NOT NULL DEFAULT 'hail-managed-custody-v1'
    CHECK (managed_profile_version = 'hail-managed-custody-v1');
ALTER TABLE custody_transition_preparations ALTER COLUMN managed_profile_version DROP DEFAULT;

ALTER TABLE public_onboarding_evidence
  ADD COLUMN record_version integer NOT NULL DEFAULT 1 CHECK (record_version = 1),
  ADD COLUMN read_evidence_policy_version text NOT NULL DEFAULT 'hail.plc-read-evidence-v1'
    CHECK (read_evidence_policy_version = 'hail.plc-read-evidence-v1');
ALTER TABLE public_onboarding_evidence ALTER COLUMN record_version DROP DEFAULT;
ALTER TABLE public_onboarding_evidence ALTER COLUMN read_evidence_policy_version DROP DEFAULT;

ALTER TABLE public_plc_resolution_evidence
  ADD COLUMN record_version integer NOT NULL DEFAULT 1 CHECK (record_version = 1),
  ADD COLUMN read_evidence_policy_version text NOT NULL DEFAULT 'hail.plc-read-evidence-v1'
    CHECK (read_evidence_policy_version = 'hail.plc-read-evidence-v1');
ALTER TABLE public_plc_resolution_evidence ALTER COLUMN record_version DROP DEFAULT;
ALTER TABLE public_plc_resolution_evidence ALTER COLUMN read_evidence_policy_version DROP DEFAULT;

ALTER TABLE public_cutover_evidence
  ADD COLUMN record_version integer NOT NULL DEFAULT 1 CHECK (record_version = 1),
  ADD COLUMN read_evidence_policy_version text NOT NULL DEFAULT 'hail.plc-read-evidence-v1'
    CHECK (read_evidence_policy_version = 'hail.plc-read-evidence-v1');
ALTER TABLE public_cutover_evidence ALTER COLUMN record_version DROP DEFAULT;
ALTER TABLE public_cutover_evidence ALTER COLUMN read_evidence_policy_version DROP DEFAULT;
