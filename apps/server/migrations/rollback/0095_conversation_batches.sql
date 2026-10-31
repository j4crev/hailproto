DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM connection_message_batches WHERE conversation_context IS NOT NULL) THEN
    RAISE EXCEPTION 'Retained shared message batches prevent rollback';
  END IF;
END $$;
ALTER TABLE connection_message_targets DROP CONSTRAINT connection_target_pair;
ALTER TABLE connection_message_targets ALTER COLUMN connection_id SET NOT NULL, ALTER COLUMN connection_epoch SET NOT NULL;
ALTER TABLE connection_message_batches DROP COLUMN conversation_context;
