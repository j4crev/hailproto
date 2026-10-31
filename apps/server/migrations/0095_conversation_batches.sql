ALTER TABLE connection_message_batches ADD COLUMN conversation_context bytea;
ALTER TABLE connection_message_targets ALTER COLUMN connection_id DROP NOT NULL, ALTER COLUMN connection_epoch DROP NOT NULL;
ALTER TABLE connection_message_targets ADD CONSTRAINT connection_target_pair CHECK((connection_id IS NULL)=(connection_epoch IS NULL));
