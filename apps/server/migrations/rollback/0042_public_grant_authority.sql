BEGIN;
LOCK TABLE public_grant_authority_evidence IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=42 AND name='public-grant-authority') OR
     EXISTS(SELECT 1 FROM schema_migrations WHERE version>42) OR EXISTS(SELECT 1 FROM public_grant_authority_evidence) THEN
    RAISE EXCEPTION 'Retained public Grant authority or later migrations prevent rollback' USING ERRCODE='55000';
  END IF;
END $$;
DROP TABLE public_grant_authority_evidence;
DELETE FROM schema_migrations WHERE version=42;
COMMIT;
