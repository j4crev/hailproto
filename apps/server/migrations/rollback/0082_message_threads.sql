-- Roll back only before v3 traffic is admitted; old codecs cannot read v3.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM sent_envelopes WHERE parent_message_id IS NOT NULL)
    OR EXISTS(SELECT 1 FROM received_envelopes WHERE parent_message_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Retained threaded envelopes require version 3 readers';
  END IF;
END $$;
DROP INDEX sent_parent_lookup;
DROP INDEX received_parent_lookup;
ALTER TABLE sent_envelopes DROP COLUMN parent_sender, DROP COLUMN parent_message_id;
ALTER TABLE received_envelopes DROP COLUMN parent_sender, DROP COLUMN parent_message_id;
