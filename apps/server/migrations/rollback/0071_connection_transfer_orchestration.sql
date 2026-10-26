BEGIN;
LOCK TABLE connection_transfer_commands,connection_transfer_aborts,pending_migration_imports,connection_import_handovers IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM schema_migrations WHERE version>71) OR EXISTS(SELECT 1 FROM connection_transfer_commands) OR
    EXISTS(SELECT 1 FROM connection_transfer_aborts) OR EXISTS(SELECT 1 FROM pending_migration_imports WHERE connection_cancellation_payload IS NOT NULL) OR
    EXISTS(SELECT 1 FROM connection_import_handovers WHERE state='released') OR
    EXISTS(SELECT 1 FROM pending_migration_imports WHERE convert_from(manifest_bytes,'UTF8')::jsonb->'connections'->>'version'='3') OR
    EXISTS(SELECT 1 FROM provider_migration_exports WHERE convert_from(manifest_bytes,'UTF8')::jsonb->'connections'->>'version'='3') THEN
    RAISE EXCEPTION 'Retained connection orchestration prevents schema rollback';
  END IF;
END $$;
DROP TRIGGER connection_cancellation_preserve ON pending_migration_imports;
DROP FUNCTION hail_preserve_connection_cancellation();
DROP TRIGGER connection_handover_barriers_fence ON connection_handover_barriers;
CREATE TRIGGER connection_handover_barriers_fence BEFORE INSERT OR UPDATE OR DELETE ON connection_handover_barriers FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account','account_id');
DROP FUNCTION hail_guard_connection_abort_record();
ALTER TABLE pending_migration_imports DROP COLUMN connection_cancellation_payload,DROP COLUMN connection_cancellation_signature,DROP COLUMN connection_cancellation_slots;
ALTER TABLE connection_import_handovers DROP CONSTRAINT connection_import_phase,DROP CONSTRAINT connection_import_commit_shape,
  DROP CONSTRAINT connection_import_completion_shape,DROP CONSTRAINT connection_import_release_shape,DROP CONSTRAINT connection_import_receipt_limits;
ALTER TABLE connection_import_handovers DROP COLUMN release_payload,DROP COLUMN release_source_signature,DROP COLUMN release_source_authority,
  DROP COLUMN release_destination_signature,DROP COLUMN release_peer_signature,DROP COLUMN release_peer_key,DROP COLUMN release_peer_authority;
ALTER TABLE connection_import_handovers ADD CONSTRAINT connection_import_handovers_state_check CHECK(state IN('frozen','committed','completed')),
  ADD CONSTRAINT connection_import_handovers_check CHECK((state='frozen' AND commit_payload IS NULL AND commit_signature IS NULL AND commit_moving_authority IS NULL AND peer_commit_payload IS NULL AND peer_commit_signature IS NULL AND peer_commit_key IS NULL AND peer_commit_authority IS NULL) OR
    (state IN('committed','completed') AND commit_payload IS NOT NULL AND octet_length(commit_payload) BETWEEN 1 AND 4096 AND commit_signature IS NOT NULL AND octet_length(commit_signature)=64
      AND peer_commit_payload IS NOT NULL AND octet_length(peer_commit_payload) BETWEEN 1 AND 65536 AND peer_commit_signature IS NOT NULL AND octet_length(peer_commit_signature)=64 AND peer_commit_key IS NOT NULL AND peer_commit_authority IS NOT NULL AND commit_moving_authority IS NOT NULL)),
  ADD CONSTRAINT connection_import_handovers_check1 CHECK((state<>'completed' AND completion_payload IS NULL AND completion_signature IS NULL AND activation_payload IS NULL AND activation_signature IS NULL AND peer_completion_payload IS NULL AND peer_completion_signature IS NULL AND peer_completion_key IS NULL AND peer_completion_authority IS NULL) OR
    (state='completed' AND completion_payload IS NOT NULL AND octet_length(completion_payload) BETWEEN 1 AND 4096 AND completion_signature IS NOT NULL AND octet_length(completion_signature)=64
      AND activation_payload IS NOT NULL AND octet_length(activation_payload) BETWEEN 1 AND 16384 AND activation_signature IS NOT NULL AND octet_length(activation_signature)=64
      AND peer_completion_payload IS NOT NULL AND octet_length(peer_completion_payload) BETWEEN 1 AND 65536 AND peer_completion_signature IS NOT NULL AND octet_length(peer_completion_signature)=64 AND peer_completion_key IS NOT NULL AND peer_completion_authority IS NOT NULL));
DROP INDEX connection_import_one_active;
CREATE UNIQUE INDEX connection_import_one_active ON connection_import_handovers(account_id,peer_did) WHERE state<>'completed';
CREATE OR REPLACE FUNCTION hail_guard_handover_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE accepted received_envelopes%ROWTYPE;
BEGIN
  SELECT * INTO accepted FROM received_envelopes WHERE sender_did=NEW.sender_did AND message_id=NEW.message_id AND recipient_did=NEW.recipient_did;
  IF accepted.authorization_type='connection' THEN
    PERFORM hail_connection_message_permission(NEW.recipient_did,NEW.sender_did,accepted.connection_id,accepted.connection_epoch,true);
    IF hail_connection_handover_blocked(NEW.recipient_did,NEW.sender_did) THEN
      RAISE EXCEPTION 'Connection delivery is paused for account handover' USING ERRCODE='55000';
    END IF;
  END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION hail_connection_preview_cutover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM provider_accounts WHERE id=NEW.account_id FOR UPDATE;
  IF TG_TABLE_NAME='account_serving_generations' THEN
    IF NEW.generation=hail_connection_import_target(NEW.account_id) THEN RETURN NEW; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM connection_invitations WHERE account_id=NEW.account_id) OR EXISTS(SELECT 1 FROM account_connections WHERE NEW.account_id IN(account_a,account_b)
    AND (state IN('active','disconnected') OR state='pending' AND pending_until>clock_timestamp())) THEN
    RAISE EXCEPTION 'Retained connection preview consent is not portable: export support is required before cutover' USING ERRCODE='55000';
  END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION hail_federated_connection_cutover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM provider_accounts WHERE id=NEW.account_id FOR UPDATE;
  IF TG_TABLE_NAME='account_serving_generations' THEN
    IF NEW.generation=hail_connection_import_target(NEW.account_id) THEN RETURN NEW; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM federated_connection_attempts WHERE account_id=NEW.account_id) OR EXISTS(SELECT 1 FROM federated_connection_tombstones WHERE account_id=NEW.account_id) THEN
    RAISE EXCEPTION 'Federated connection consent is not portable: export support is required before cutover' USING ERRCODE='55000';
  END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION hail_finish_peer_handover_before_cutover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM provider_accounts WHERE id=NEW.account_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM connection_handover_barriers WHERE account_id=NEW.account_id AND state IN('frozen','committed')) THEN
    RAISE EXCEPTION 'Resolve the peer connection handover before moving this account' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM connection_handover_barriers WHERE account_id=NEW.account_id) THEN
    RAISE EXCEPTION 'Retained peer handover history requires portable preservation before account cutover' USING ERRCODE='55000';
  END IF;RETURN NEW;
END $$;
DROP FUNCTION hail_assert_connection_source_drained(uuid);
DROP FUNCTION hail_connection_source_fence_authorized(uuid,uuid);
DROP TABLE connection_transfer_commands;
DROP TABLE connection_transfer_aborts;
DROP TRIGGER connection_cancelled_grant ON provider_transfer_authorizations;
DROP FUNCTION hail_reject_cancelled_connection_transfer_grant();
DELETE FROM schema_migrations WHERE version=71;
COMMIT;
