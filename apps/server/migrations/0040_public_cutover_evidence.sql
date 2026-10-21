-- Expand only. No legacy signed snapshot, account or observation row changes.
-- Historical transfer IDs deliberately do not reference recyclable working rows.
CREATE TABLE public_cutover_evidence (
  transfer_id uuid NOT NULL,
  evidence_digest bytea NOT NULL CHECK (octet_length(evidence_digest) = 32),
  did text NOT NULL CHECK (did ~ '^did:plc:[a-z2-7]{24}$'),
  operation_cid text NOT NULL,
  manifest_digest bytea NOT NULL CHECK (octet_length(manifest_digest) = 32),
  signed_operation_bytes bytea NOT NULL CHECK (octet_length(signed_operation_bytes) BETWEEN 1 AND 16000),
  monitor_attestation_digest bytea NOT NULL CHECK (octet_length(monitor_attestation_digest) = 32),
  verified_at timestamptz NOT NULL,
  bundle_bytes bytea NOT NULL CHECK (octet_length(bundle_bytes) BETWEEN 1 AND 8388608),
  PRIMARY KEY (transfer_id, evidence_digest)
);
CREATE INDEX public_cutover_evidence_did_idx ON public_cutover_evidence (did, verified_at);

CREATE TABLE public_cutover_evidence_selection (
  transfer_id uuid PRIMARY KEY,
  evidence_digest bytea NOT NULL,
  activated_at timestamptz,
  FOREIGN KEY (transfer_id, evidence_digest)
    REFERENCES public_cutover_evidence (transfer_id, evidence_digest) ON DELETE RESTRICT
);

CREATE FUNCTION hail_immutable_public_cutover_evidence() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Public cutover evidence is immutable' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hail_public_cutover_evidence_immutable BEFORE UPDATE OR DELETE ON public_cutover_evidence
  FOR EACH ROW EXECUTE FUNCTION hail_immutable_public_cutover_evidence();
CREATE TRIGGER hail_public_cutover_evidence_no_truncate BEFORE TRUNCATE ON public_cutover_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_public_cutover_evidence();

CREATE FUNCTION hail_retain_public_cutover_selection() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.activated_at IS NOT NULL THEN
      RAISE EXCEPTION 'Evidence cannot be inserted as already activated' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.activated_at IS NOT NULL THEN
    RAISE EXCEPTION 'Activated public evidence selection is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.transfer_id <> OLD.transfer_id THEN
    RAISE EXCEPTION 'Public evidence selection cannot change transfer identity' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.activated_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pending_migration_imports p WHERE p.transfer_id = NEW.transfer_id
      AND p.state = 'active' AND p.activated_at = NEW.activated_at
  ) THEN
    RAISE EXCEPTION 'Only committed public activation may seal evidence' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hail_public_cutover_selection BEFORE INSERT OR UPDATE OR DELETE ON public_cutover_evidence_selection
  FOR EACH ROW EXECUTE FUNCTION hail_retain_public_cutover_selection();
CREATE TRIGGER hail_public_cutover_selection_no_truncate BEFORE TRUNCATE ON public_cutover_evidence_selection
  FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_public_cutover_evidence();

-- Old public writers cannot activate from a digest-only assessment on the
-- expanded schema. Private-POC writers keep the existing separate contract.
CREATE FUNCTION hail_seal_public_cutover_evidence() RETURNS trigger AS $$
DECLARE
  observation portable_cutover_observations;
  evidence public_cutover_evidence;
  sealed timestamptz;
BEGIN
  IF OLD.state <> 'staged' OR NEW.state <> 'active' THEN RETURN NEW; END IF;
  SELECT * INTO observation FROM portable_cutover_observations WHERE transfer_id = NEW.transfer_id;
  IF observation.assessment_profile IS DISTINCT FROM 'public' THEN RETURN NEW; END IF;
  SELECT e.* INTO evidence
    FROM public_cutover_evidence e JOIN public_cutover_evidence_selection s
      USING (transfer_id, evidence_digest)
    WHERE s.transfer_id = NEW.transfer_id FOR UPDATE OF s;
  SELECT activated_at INTO sealed FROM public_cutover_evidence_selection WHERE transfer_id = NEW.transfer_id;
  IF observation.state <> 'eligible' OR evidence.transfer_id IS NULL OR sealed IS NOT NULL OR evidence.did <> NEW.did OR
     evidence.manifest_digest <> NEW.manifest_digest OR evidence.signed_operation_bytes <> NEW.signed_plc_operation_bytes OR
     evidence.operation_cid <> observation.operation_cid OR evidence.monitor_attestation_digest <> observation.monitor_attestation_digest OR
     evidence.verified_at <> observation.last_seen_at OR NEW.activated_at IS NULL OR
     abs(extract(epoch FROM NEW.activated_at - evidence.verified_at)) > 30 THEN
    RAISE EXCEPTION 'Public activation requires the exact fresh retained evidence bundle' USING ERRCODE = '55000';
  END IF;
  UPDATE public_cutover_evidence_selection SET activated_at = NEW.activated_at WHERE transfer_id = NEW.transfer_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hail_public_cutover_evidence_commit AFTER UPDATE OF state ON pending_migration_imports
  FOR EACH ROW EXECUTE FUNCTION hail_seal_public_cutover_evidence();
