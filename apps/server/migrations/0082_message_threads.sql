-- Derived lookup columns; the signed envelope remains the source of truth.
-- No parent foreign key: messages remain readable after a parent is removed.
ALTER TABLE sent_envelopes ADD COLUMN parent_sender text, ADD COLUMN parent_message_id uuid,
  ADD CONSTRAINT sent_parent_shape CHECK ((parent_sender IS NULL) = (parent_message_id IS NULL));
ALTER TABLE received_envelopes ADD COLUMN parent_sender text, ADD COLUMN parent_message_id uuid,
  ADD CONSTRAINT received_parent_shape CHECK ((parent_sender IS NULL) = (parent_message_id IS NULL));
CREATE INDEX sent_parent_lookup ON sent_envelopes
  (sender_account_id, (COALESCE(parent_sender, CASE WHEN authorization_type='reply' THEN recipient_did END)),
   (COALESCE(parent_message_id, reply_to_message_id)));
CREATE INDEX received_parent_lookup ON received_envelopes
  (local_account_id, (COALESCE(parent_sender, CASE WHEN authorization_type='reply' THEN recipient_did END)),
   (COALESCE(parent_message_id, reply_to_message_id)));
