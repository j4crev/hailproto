ALTER TABLE verified_body_provenance
  DROP CONSTRAINT verified_body_provenance_profile_check,
  ADD CONSTRAINT verified_body_provenance_profile_check
    CHECK (profile IN ('spt-1', 'spt-2'));
