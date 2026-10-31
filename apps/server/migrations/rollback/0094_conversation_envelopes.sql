DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM sent_envelopes WHERE authorization_type='conversation') OR EXISTS(SELECT 1 FROM received_envelopes WHERE authorization_type='conversation') THEN
    RAISE EXCEPTION 'Retained conversation envelopes prevent rollback';
  END IF;
END $$;
DROP TRIGGER conversation_descriptor_delete ON conversation_descriptors;
DROP FUNCTION hail_guard_conversation_descriptor_delete();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['sent_envelopes','received_envelopes'] LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',t,t||'_authorization_shape');
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',t,t||'_conversation_shape');
    EXECUTE format('ALTER TABLE %I DROP COLUMN conversation_creator, DROP COLUMN conversation_id, DROP COLUMN conversation_descriptor_hash, DROP COLUMN conversation_message_id',t);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK(
      (authorization_type=''grant'' AND grant_id IS NOT NULL AND reply_to_message_id IS NULL AND connection_id IS NULL AND connection_epoch IS NULL) OR
      (authorization_type=''reply'' AND grant_id IS NULL AND reply_to_message_id IS NOT NULL AND connection_id IS NULL AND connection_epoch IS NULL) OR
      (authorization_type=''connection'' AND grant_id IS NULL AND reply_to_message_id IS NULL AND connection_id IS NOT NULL AND connection_epoch IS NOT NULL AND connection_epoch>0))',t,t||'_authorization_shape');
  END LOOP;
END $$;
