ALTER TABLE sent_envelopes ADD COLUMN conversation_creator text, ADD COLUMN conversation_id uuid,
  ADD COLUMN conversation_descriptor_hash bytea, ADD COLUMN conversation_message_id uuid;
ALTER TABLE received_envelopes ADD COLUMN conversation_creator text, ADD COLUMN conversation_id uuid,
  ADD COLUMN conversation_descriptor_hash bytea, ADD COLUMN conversation_message_id uuid;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['sent_envelopes','received_envelopes'] LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',t,t||'_authorization_shape');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK(
      (authorization_type=''grant'' AND grant_id IS NOT NULL AND reply_to_message_id IS NULL AND connection_id IS NULL AND connection_epoch IS NULL AND conversation_id IS NULL) OR
      (authorization_type=''reply'' AND grant_id IS NULL AND reply_to_message_id IS NOT NULL AND connection_id IS NULL AND connection_epoch IS NULL AND conversation_id IS NULL) OR
      (authorization_type=''connection'' AND grant_id IS NULL AND reply_to_message_id IS NULL AND connection_id IS NOT NULL AND connection_epoch IS NOT NULL AND connection_epoch>0 AND conversation_id IS NULL) OR
      (authorization_type=''conversation'' AND grant_id IS NULL AND reply_to_message_id IS NULL AND connection_id IS NULL AND connection_epoch IS NULL
        AND conversation_creator IS NOT NULL AND conversation_id IS NOT NULL AND conversation_descriptor_hash IS NOT NULL AND octet_length(conversation_descriptor_hash)=32 AND conversation_message_id IS NOT NULL))',t,t||'_authorization_shape');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK(authorization_type=''conversation'' OR (conversation_creator IS NULL AND conversation_id IS NULL AND conversation_descriptor_hash IS NULL AND conversation_message_id IS NULL))',t,t||'_conversation_shape');
  END LOOP;
END $$;
CREATE INDEX sent_conversation_lookup ON sent_envelopes(sender_account_id,conversation_creator,conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX received_conversation_lookup ON received_envelopes(local_account_id,conversation_creator,conversation_id) WHERE conversation_id IS NOT NULL;
CREATE UNIQUE INDEX received_conversation_message_identity ON received_envelopes(local_account_id,conversation_creator,conversation_id,sender_did,conversation_message_id)
  WHERE authorization_type='conversation';
CREATE FUNCTION hail_guard_conversation_descriptor_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.admission_until>=clock_timestamp()-interval '5 minutes'
    OR EXISTS(SELECT 1 FROM conversation_memberships WHERE creator_did=OLD.creator_did AND conversation_id=OLD.conversation_id)
    OR EXISTS(SELECT 1 FROM sent_envelopes WHERE conversation_creator=OLD.creator_did AND conversation_id=OLD.conversation_id)
    OR EXISTS(SELECT 1 FROM received_envelopes WHERE conversation_creator=OLD.creator_did AND conversation_id=OLD.conversation_id) THEN
    RAISE EXCEPTION 'Retained conversation descriptor cannot be deleted' USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER conversation_descriptor_delete BEFORE DELETE ON conversation_descriptors
  FOR EACH ROW EXECUTE FUNCTION hail_guard_conversation_descriptor_delete();
