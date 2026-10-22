-- Expand only. Existing accounts retain their recorded assurance. An alpha
-- preparation cannot be activated by an old writer labeling it independent.
ALTER TABLE public_onboarding_preparations
  ADD COLUMN monitor_assurance text NOT NULL DEFAULT 'independent'
    CHECK (monitor_assurance IN ('independent', 'reduced-assurance-alpha-v1')),
  ADD CONSTRAINT public_onboarding_monitor_assurance_custody CHECK
    (monitor_assurance = 'independent' OR custody_profile = 'managed'),
  ADD CONSTRAINT public_onboarding_monitor_assurance_unique UNIQUE (account_id, monitor_assurance);

ALTER TABLE public_onboarding_evidence
  ADD COLUMN monitor_assurance text NOT NULL DEFAULT 'independent'
    CHECK (monitor_assurance IN ('independent', 'reduced-assurance-alpha-v1')),
  ADD CONSTRAINT public_onboarding_monitor_assurance_match FOREIGN KEY (account_id, monitor_assurance)
    REFERENCES public_onboarding_preparations(account_id, monitor_assurance) ON DELETE RESTRICT;

ALTER TABLE managed_custody_evidence DROP CONSTRAINT managed_custody_evidence_verification_mode_check;
ALTER TABLE managed_custody_evidence ADD CONSTRAINT managed_custody_evidence_verification_mode_check
  CHECK (verification_mode IN ('poc-local', 'strict-public-v1', 'reduced-assurance-alpha-v1'));

-- Existing custody-transition writers must not promote alpha monitoring by
-- deleting/replacing its custody record. Promotion needs a reviewed new path.
CREATE FUNCTION hail_preserve_alpha_monitor_assurance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.verification_mode = 'reduced-assurance-alpha-v1' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Alpha monitoring requires an explicit assurance transition';
    ELSIF NEW.verification_mode <> OLD.verification_mode THEN
      RAISE EXCEPTION 'Alpha monitoring requires an explicit assurance transition';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hail_preserve_alpha_monitor_assurance
  BEFORE UPDATE OR DELETE ON managed_custody_evidence
  FOR EACH ROW EXECUTE FUNCTION hail_preserve_alpha_monitor_assurance();
