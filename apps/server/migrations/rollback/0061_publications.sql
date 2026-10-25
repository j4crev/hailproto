BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=61) OR EXISTS (SELECT 1 FROM schema_migrations WHERE version>61)
    OR EXISTS (SELECT 1 FROM account_publications) THEN
    RAISE EXCEPTION 'Retained publication intent prevents rollback; use code rollback after finishing pending work';
  END IF;
END $$;
DROP TRIGGER hail_publications_before_fence ON provider_migration_fences;
DROP TRIGGER hail_publications_before_generation ON account_serving_generations;
DROP FUNCTION hail_finish_publications_before_cutover();
DROP TABLE publication_targets;
DROP FUNCTION hail_admit_publication_target();
DROP TABLE account_publications;
DROP FUNCTION hail_preserve_publication_intent();
DELETE FROM schema_migrations WHERE version=61;
COMMIT;
