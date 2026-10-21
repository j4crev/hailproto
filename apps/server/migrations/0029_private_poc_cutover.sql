-- A private PLC rehearsal is deliberately not independent public finality.
ALTER TABLE portable_custody_evidence
  ADD COLUMN monitor_verification_mode text NOT NULL DEFAULT 'independent'
    CHECK (monitor_verification_mode IN ('independent', 'poc-local'));

ALTER TABLE portable_cutover_observations
  ADD COLUMN assessment_profile text NOT NULL DEFAULT 'public'
    CHECK (assessment_profile IN ('public', 'private-poc'));
