BEGIN;
LOCK TABLE public_signing_authority_evidence IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = 43 AND name = 'public-signing-authority'
  ) OR EXISTS (
    SELECT 1 FROM schema_migrations WHERE version > 43
  ) OR EXISTS (
    SELECT 1 FROM public_signing_authority_evidence
  ) THEN
    RAISE EXCEPTION 'Retained public signing authority or later migrations prevent rollback'
      USING ERRCODE = '55000';
  END IF;
END $$;
DROP TABLE public_signing_authority_evidence;
DELETE FROM schema_migrations WHERE version = 43;
COMMIT;
