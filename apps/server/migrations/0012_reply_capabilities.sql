ALTER TABLE sent_envelopes
  ALTER COLUMN grant_id DROP NOT NULL,
  ADD COLUMN reply_to_message_id uuid,
  ADD COLUMN authorization_type text NOT NULL DEFAULT 'grant',
  ADD CONSTRAINT sent_envelopes_authorization_shape CHECK (
    (authorization_type = 'grant' AND grant_id IS NOT NULL AND reply_to_message_id IS NULL) OR
    (authorization_type = 'reply' AND grant_id IS NULL AND reply_to_message_id IS NOT NULL)
  ),
  ADD CONSTRAINT sent_envelopes_reply_reference
    FOREIGN KEY (recipient_did, reply_to_message_id)
    REFERENCES received_envelopes(sender_did, message_id) ON DELETE RESTRICT;

ALTER TABLE received_envelopes
  ALTER COLUMN grant_id DROP NOT NULL,
  ADD COLUMN reply_to_message_id uuid,
  ADD COLUMN authorization_type text NOT NULL DEFAULT 'grant',
  ADD CONSTRAINT received_envelopes_authorization_shape CHECK (
    (authorization_type = 'grant' AND grant_id IS NOT NULL AND reply_to_message_id IS NULL) OR
    (authorization_type = 'reply' AND grant_id IS NULL AND reply_to_message_id IS NOT NULL)
  ),
  ADD CONSTRAINT received_envelopes_reply_reference
    FOREIGN KEY (recipient_did, reply_to_message_id)
    REFERENCES sent_envelopes(sender_did, message_id) ON DELETE RESTRICT;

CREATE TABLE reply_capabilities (
  original_sender_did text NOT NULL,
  original_message_id uuid NOT NULL,
  permitted_recipient_did text NOT NULL,
  reply_until bigint NOT NULL CHECK (reply_until > 0),
  state text NOT NULL DEFAULT 'available'
    CHECK (state IN ('available', 'claimed', 'consumed')),
  claimed_sender_did text,
  claimed_message_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (original_sender_did, original_message_id),
  FOREIGN KEY (original_sender_did, original_message_id)
    REFERENCES sent_envelopes(sender_did, message_id) ON DELETE RESTRICT,
  CHECK ((state = 'available' AND claimed_sender_did IS NULL AND claimed_message_id IS NULL) OR
         (state IN ('claimed', 'consumed') AND claimed_sender_did IS NOT NULL AND claimed_message_id IS NOT NULL))
);

CREATE INDEX reply_capabilities_claim_idx
  ON reply_capabilities (claimed_sender_did, claimed_message_id)
  WHERE state IN ('claimed', 'consumed');
