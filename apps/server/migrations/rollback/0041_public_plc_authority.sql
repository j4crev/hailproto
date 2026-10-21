BEGIN;
LOCK TABLE public_plc_resolution_evidence, public_envelope_authority_evidence IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=41 AND name='public-plc-authority') OR
     EXISTS (SELECT 1 FROM schema_migrations WHERE version>41) OR
     EXISTS (SELECT 1 FROM public_plc_resolution_evidence) OR EXISTS (SELECT 1 FROM public_envelope_authority_evidence) THEN
    RAISE EXCEPTION 'Retained public PLC authority or later migrations prevent rollback' USING ERRCODE='55000';
  END IF;
END;
$$;
DROP TABLE public_envelope_authority_evidence;
DROP TABLE public_plc_resolution_evidence;
DROP FUNCTION hail_immutable_public_plc_authority();
DELETE FROM schema_migrations WHERE version=41;
COMMIT;
