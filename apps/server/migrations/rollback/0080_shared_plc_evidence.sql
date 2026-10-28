-- Stop application processes. Allow capacity for restoring every full bundle.
BEGIN;
LOCK TABLE public_plc_resolution_evidence, public_plc_shared_evidence IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version > 80) THEN
    RAISE EXCEPTION 'Roll back later migrations first';
  END IF;
END $$;
UPDATE public_plc_resolution_evidence e SET bundle_bytes = c.bundle_bytes,
  shared_digest = NULL, bundle_prefix = NULL, bundle_suffix = NULL
FROM public_plc_resolution_contents c WHERE e.evidence_digest = c.evidence_digest AND e.bundle_bytes IS NULL;
DROP VIEW public_plc_resolution_contents;
DROP TRIGGER hail_public_plc_resolution_immutable ON public_plc_resolution_evidence;
DROP FUNCTION hail_check_plc_storage();
CREATE TRIGGER hail_public_plc_resolution_immutable BEFORE UPDATE OR DELETE ON public_plc_resolution_evidence
  FOR EACH ROW EXECUTE FUNCTION hail_immutable_public_plc_authority();
ALTER TABLE public_plc_resolution_evidence DROP CONSTRAINT public_plc_storage_shape,
  DROP COLUMN shared_digest, DROP COLUMN bundle_prefix, DROP COLUMN bundle_suffix;
ALTER TABLE public_plc_resolution_evidence ALTER COLUMN bundle_bytes SET NOT NULL;
DROP TABLE public_plc_shared_evidence;
DELETE FROM schema_migrations WHERE version = 80;
COMMIT;
