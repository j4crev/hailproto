BEGIN;
LOCK TABLE pending_migration_imports, portable_cutover_observations, public_cutover_evidence,
  public_cutover_evidence_selection IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 40 AND name = 'public-cutover-evidence') OR
     EXISTS (SELECT 1 FROM schema_migrations WHERE version > 40) OR
     EXISTS (SELECT 1 FROM public_cutover_evidence) OR EXISTS (SELECT 1 FROM public_cutover_evidence_selection) THEN
    RAISE EXCEPTION 'Retained public evidence or later migrations prevent rollback' USING ERRCODE = '55000';
  END IF;
END;
$$;
DROP TRIGGER hail_public_cutover_evidence_commit ON pending_migration_imports;
DROP FUNCTION hail_seal_public_cutover_evidence();
DROP TABLE public_cutover_evidence_selection;
DROP FUNCTION hail_retain_public_cutover_selection();
DROP TABLE public_cutover_evidence;
DROP FUNCTION hail_immutable_public_cutover_evidence();
DELETE FROM schema_migrations WHERE version = 40;
COMMIT;
