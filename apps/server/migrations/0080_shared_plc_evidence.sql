-- Coordinated rollout: stop all old readers/writers before compact writes begin.
-- Legacy full-byte inserts remain supported; portable exports use the contents view.
CREATE TABLE public_plc_shared_evidence (
  digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
  payload_bytes bytea NOT NULL CHECK (octet_length(payload_bytes) BETWEEN 1 AND 8388608),
  CHECK (sha256(payload_bytes) = digest)
);
CREATE TRIGGER hail_public_plc_shared_immutable BEFORE UPDATE OR DELETE ON public_plc_shared_evidence
  FOR EACH ROW EXECUTE FUNCTION hail_immutable_public_plc_authority();
CREATE TRIGGER hail_public_plc_shared_no_truncate BEFORE TRUNCATE ON public_plc_shared_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_public_plc_authority();

ALTER TABLE public_plc_resolution_evidence ALTER COLUMN bundle_bytes DROP NOT NULL;
ALTER TABLE public_plc_resolution_evidence
  ADD COLUMN shared_digest bytea REFERENCES public_plc_shared_evidence(digest) ON DELETE RESTRICT,
  ADD COLUMN bundle_prefix bytea,
  ADD COLUMN bundle_suffix bytea,
  ADD CONSTRAINT public_plc_storage_shape CHECK (
    (bundle_bytes IS NOT NULL AND shared_digest IS NULL AND bundle_prefix IS NULL AND bundle_suffix IS NULL)
    OR (bundle_bytes IS NULL AND shared_digest IS NOT NULL AND bundle_prefix IS NOT NULL AND bundle_suffix IS NOT NULL
      AND octet_length(bundle_prefix) + octet_length(bundle_suffix) <= 8388608)
  );

-- Explicit columns preserve the signed portable row shape; storage details never escape.
CREATE VIEW public_plc_resolution_contents AS
SELECT e.evidence_digest, e.did, e.operation_cid, e.verified_at,
  coalesce(e.bundle_bytes, e.bundle_prefix || s.payload_bytes || e.bundle_suffix) AS bundle_bytes,
  e.record_version, e.read_evidence_policy_version
FROM public_plc_resolution_evidence e LEFT JOIN public_plc_shared_evidence s ON s.digest = e.shared_digest;

CREATE FUNCTION hail_check_plc_storage() RETURNS trigger AS $$
DECLARE reconstructed bytea; previous_bytes bytea;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Public PLC authority evidence is immutable' USING ERRCODE = '55000';
  END IF;
  reconstructed := NEW.bundle_bytes;
  IF reconstructed IS NULL THEN
    SELECT NEW.bundle_prefix || payload_bytes || NEW.bundle_suffix INTO reconstructed
      FROM public_plc_shared_evidence WHERE digest = NEW.shared_digest;
  END IF;
  IF reconstructed IS NULL OR octet_length(reconstructed) NOT BETWEEN 1 AND 8388608
      OR sha256(reconstructed) <> NEW.evidence_digest THEN
    RAISE EXCEPTION 'Public PLC storage bytes or digest mismatch';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    previous_bytes := OLD.bundle_bytes;
    IF previous_bytes IS NULL THEN
      SELECT OLD.bundle_prefix || payload_bytes || OLD.bundle_suffix INTO previous_bytes
        FROM public_plc_shared_evidence WHERE digest = OLD.shared_digest;
    END IF;
    IF previous_bytes IS DISTINCT FROM reconstructed OR
      (to_jsonb(OLD) - ARRAY['bundle_bytes','shared_digest','bundle_prefix','bundle_suffix']) IS DISTINCT FROM
      (to_jsonb(NEW) - ARRAY['bundle_bytes','shared_digest','bundle_prefix','bundle_suffix']) THEN
      RAISE EXCEPTION 'Public PLC authority evidence is immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER hail_public_plc_resolution_immutable ON public_plc_resolution_evidence;
CREATE TRIGGER hail_public_plc_resolution_immutable BEFORE INSERT OR UPDATE OR DELETE ON public_plc_resolution_evidence
  FOR EACH ROW EXECUTE FUNCTION hail_check_plc_storage();
