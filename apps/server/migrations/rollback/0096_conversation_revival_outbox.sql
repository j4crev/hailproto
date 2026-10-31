DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM conversation_revival_batches) OR EXISTS(SELECT 1 FROM conversation_revival_targets) THEN
    RAISE EXCEPTION 'Retained conversation revival work prevents rollback';
  END IF;
END $$;
DROP TRIGGER conversation_revival_before_fence ON provider_migration_fences;
DROP TRIGGER conversation_revival_before_generation ON account_serving_generations;
DROP FUNCTION hail_conversation_cutover_guard();
DROP TABLE conversation_revival_targets;
DROP TABLE conversation_revival_batches;
DROP FUNCTION hail_conversation_revival_immutable();
