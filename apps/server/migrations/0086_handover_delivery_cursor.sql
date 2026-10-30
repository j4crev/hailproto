-- assign_delivery_sequence runs before the handover guard on INSERT. A new
-- destination cursor is not part of the authenticated historical delivery.
-- Keep every other staged field exact, including read/trash state, and keep
-- the authenticated import context and frozen-delivery checks unchanged.
CREATE OR REPLACE FUNCTION hail_guard_handover_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE accepted received_envelopes%ROWTYPE;
BEGIN
  SELECT * INTO accepted FROM received_envelopes WHERE sender_did=NEW.sender_did AND message_id=NEW.message_id AND recipient_did=NEW.recipient_did;
  IF accepted.authorization_type='connection' THEN
    IF hail_connection_import_context(accepted.local_account_id) AND EXISTS(
      SELECT 1 FROM pending_migration_imports p,
        jsonb_array_elements((convert_from(p.manifest_bytes,'UTF8')::jsonb)->'tables'->'delivered_messages') r
      WHERE p.transfer_id::text=current_setting('hail.connection_import_transfer',true) AND p.state='staged'
        AND (to_jsonb(jsonb_populate_record(NULL::delivered_messages,r)) - 'delivery_sequence')
          IS NOT DISTINCT FROM (to_jsonb(NEW) - 'delivery_sequence')) THEN RETURN NEW; END IF;
    PERFORM hail_connection_message_permission(NEW.recipient_did,NEW.sender_did,accepted.connection_id,accepted.connection_epoch,true);
    IF hail_connection_handover_blocked(NEW.recipient_did,NEW.sender_did) THEN
      RAISE EXCEPTION 'Connection delivery is paused for account handover' USING ERRCODE='55000';
    END IF;
  END IF;RETURN NEW;
END $$;
