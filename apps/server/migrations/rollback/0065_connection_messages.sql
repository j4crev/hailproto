BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM schema_migrations WHERE version>65) OR EXISTS(SELECT 1 FROM connection_message_batches) OR
    EXISTS(SELECT 1 FROM sent_envelopes WHERE authorization_type='connection') OR EXISTS(SELECT 1 FROM received_envelopes WHERE authorization_type='connection') THEN
    RAISE EXCEPTION 'Retained connection messages prevent schema rollback; retain tables for code rollback'; END IF;
END $$;
DROP TRIGGER connection_messages_before_fence ON provider_migration_fences;
DROP TRIGGER connection_messages_before_generation ON account_serving_generations;
DROP FUNCTION hail_finish_connection_messages_before_cutover();
DROP TABLE connection_message_targets,connection_message_batches;
DROP FUNCTION hail_admit_connection_message_target();
DROP FUNCTION hail_preserve_connection_message_intent();
DROP FUNCTION hail_connection_message_allowed(text,text,uuid,bigint,boolean);
ALTER TABLE sent_envelopes DROP CONSTRAINT sent_envelopes_authorization_shape,DROP COLUMN connection_id,DROP COLUMN connection_epoch;
ALTER TABLE received_envelopes DROP CONSTRAINT received_envelopes_authorization_shape,DROP COLUMN connection_id,DROP COLUMN connection_epoch;
ALTER TABLE sent_envelopes ADD CONSTRAINT sent_envelopes_authorization_shape CHECK(
  (authorization_type='grant' AND grant_id IS NOT NULL AND reply_to_message_id IS NULL) OR
  (authorization_type='reply' AND grant_id IS NULL AND reply_to_message_id IS NOT NULL));
ALTER TABLE received_envelopes ADD CONSTRAINT received_envelopes_authorization_shape CHECK(
  (authorization_type='grant' AND grant_id IS NOT NULL AND reply_to_message_id IS NULL) OR
  (authorization_type='reply' AND grant_id IS NULL AND reply_to_message_id IS NOT NULL));
DELETE FROM schema_migrations WHERE version=65;
COMMIT;
