-- A small durable RPC outbox, not a second connection model. Successful commands
-- are also retained in the immutable handover journal; interrupted commands must
-- be replayed byte-for-byte before choosing another intent.
CREATE TABLE connection_transfer_commands (
  account_id uuid NOT NULL,
  transfer_id uuid NOT NULL,
  peer_did text NOT NULL CHECK(peer_did ~ '^did:plc:[a-z2-7]{24}$'),
  action text NOT NULL CHECK(action IN('freeze','commit','complete','abort')),
  payload bytea NOT NULL CHECK(octet_length(payload) BETWEEN 1 AND 65536),
  signature bytea NOT NULL CHECK(octet_length(signature)=64),
  PRIMARY KEY(transfer_id,peer_did,action)
);
ALTER TABLE pending_migration_imports ADD COLUMN connection_cancellation_payload bytea,ADD COLUMN connection_cancellation_signature bytea,ADD COLUMN connection_cancellation_slots jsonb;
ALTER TABLE connection_import_handovers DROP CONSTRAINT connection_import_handovers_state_check,
  DROP CONSTRAINT connection_import_handovers_check, DROP CONSTRAINT connection_import_handovers_check1;
ALTER TABLE connection_import_handovers ADD COLUMN release_payload bytea,ADD COLUMN release_source_signature bytea,ADD COLUMN release_source_authority jsonb,
  ADD COLUMN release_destination_signature bytea,ADD COLUMN release_peer_signature bytea,ADD COLUMN release_peer_key text,ADD COLUMN release_peer_authority jsonb;
ALTER TABLE connection_import_handovers ADD CONSTRAINT connection_import_phase CHECK(state IN('frozen','committed','completed','released')),
  ADD CONSTRAINT connection_import_commit_shape CHECK((state IN('frozen','released') AND commit_payload IS NULL AND commit_signature IS NULL AND commit_moving_authority IS NULL AND peer_commit_payload IS NULL AND peer_commit_signature IS NULL AND peer_commit_key IS NULL AND peer_commit_authority IS NULL) OR
    (state IN('committed','completed') AND commit_payload IS NOT NULL AND octet_length(commit_signature)=64 AND commit_signature IS NOT NULL AND commit_moving_authority IS NOT NULL AND peer_commit_payload IS NOT NULL AND peer_commit_signature IS NOT NULL AND octet_length(peer_commit_signature)=64 AND peer_commit_key IS NOT NULL AND peer_commit_authority IS NOT NULL)),
  ADD CONSTRAINT connection_import_completion_shape CHECK((state<>'completed' AND completion_payload IS NULL AND completion_signature IS NULL AND activation_payload IS NULL AND activation_signature IS NULL AND peer_completion_payload IS NULL AND peer_completion_signature IS NULL AND peer_completion_key IS NULL AND peer_completion_authority IS NULL) OR
    (state='completed' AND completion_payload IS NOT NULL AND completion_signature IS NOT NULL AND octet_length(completion_signature)=64 AND activation_payload IS NOT NULL AND activation_signature IS NOT NULL AND octet_length(activation_signature)=64 AND peer_completion_payload IS NOT NULL AND peer_completion_signature IS NOT NULL AND octet_length(peer_completion_signature)=64 AND peer_completion_key IS NOT NULL AND peer_completion_authority IS NOT NULL)),
  ADD CONSTRAINT connection_import_release_shape CHECK((state<>'released' AND release_payload IS NULL AND release_source_signature IS NULL AND release_source_authority IS NULL AND release_destination_signature IS NULL AND release_peer_signature IS NULL AND release_peer_key IS NULL AND release_peer_authority IS NULL) OR
    (state='released' AND release_payload IS NOT NULL AND release_source_signature IS NOT NULL AND octet_length(release_source_signature)=64 AND release_source_authority IS NOT NULL AND release_destination_signature IS NOT NULL AND octet_length(release_destination_signature)=64 AND release_peer_signature IS NOT NULL AND octet_length(release_peer_signature)=64 AND release_peer_key IS NOT NULL AND release_peer_authority IS NOT NULL));
ALTER TABLE connection_import_handovers ADD CONSTRAINT connection_import_receipt_limits CHECK(
  (commit_payload IS NULL OR octet_length(commit_payload) BETWEEN 1 AND 4096) AND (peer_commit_payload IS NULL OR octet_length(peer_commit_payload) BETWEEN 1 AND 65536) AND
  (completion_payload IS NULL OR octet_length(completion_payload) BETWEEN 1 AND 4096) AND (activation_payload IS NULL OR octet_length(activation_payload) BETWEEN 1 AND 16384) AND
  (peer_completion_payload IS NULL OR octet_length(peer_completion_payload) BETWEEN 1 AND 65536) AND (release_payload IS NULL OR octet_length(release_payload) BETWEEN 1 AND 4096));
DROP INDEX connection_import_one_active;
CREATE UNIQUE INDEX connection_import_one_active ON connection_import_handovers(account_id,peer_did) WHERE state IN('frozen','committed');
CREATE OR REPLACE FUNCTION hail_preserve_connection_import_handover() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutable text[]=ARRAY['state','commit_payload','commit_signature','commit_moving_authority','peer_commit_payload','peer_commit_signature','peer_commit_key','peer_commit_authority',
  'completion_payload','completion_signature','activation_payload','activation_signature','peer_completion_payload','peer_completion_signature','peer_completion_key','peer_completion_authority',
  'release_payload','release_source_signature','release_source_authority','release_destination_signature','release_peer_signature','release_peer_key','release_peer_authority']; field text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Connection import handover history cannot be deleted'; END IF;
  IF (to_jsonb(NEW)-mutable) IS DISTINCT FROM (to_jsonb(OLD)-mutable) OR OLD.state IN('completed','released') AND NEW IS DISTINCT FROM OLD OR
    OLD.state='committed' AND NEW.state NOT IN('committed','completed') THEN RAISE EXCEPTION 'Connection import handover intent cannot be replaced'; END IF;
  FOREACH field IN ARRAY mutable LOOP
    IF field<>'state' AND to_jsonb(OLD)->field<>'null'::jsonb AND (to_jsonb(NEW)->field) IS DISTINCT FROM (to_jsonb(OLD)->field) THEN RAISE EXCEPTION 'Connection import handover receipt cannot be replaced'; END IF;
  END LOOP;RETURN NEW;
END $$;
CREATE TABLE connection_transfer_aborts (
  account_id uuid NOT NULL,transfer_id uuid NOT NULL,cancellation_payload bytea NOT NULL,cancellation_signature bytea NOT NULL,
  destination_signature bytea NOT NULL,owner_key text NOT NULL,managed_owner boolean NOT NULL,source_authority jsonb NOT NULL,
  archive jsonb NOT NULL CHECK(jsonb_typeof(archive)='object'),PRIMARY KEY(account_id,transfer_id),
  CHECK(octet_length(cancellation_payload) BETWEEN 1 AND 4096 AND octet_length(cancellation_signature)=64 AND octet_length(destination_signature)=64)
);
CREATE TRIGGER connection_transfer_abort_preserve BEFORE UPDATE OR DELETE ON connection_transfer_aborts FOR EACH ROW EXECUTE FUNCTION hail_immutable_public_plc_authority();
CREATE TRIGGER connection_transfer_abort_truncate BEFORE TRUNCATE ON connection_transfer_aborts FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_public_plc_authority();
CREATE FUNCTION hail_reject_cancelled_connection_transfer_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM connection_transfer_aborts WHERE archive->'authorization'->>'did'=NEW.did AND archive->'authorization'->>'nonce'=NEW.nonce::text) THEN
    RAISE EXCEPTION 'This transfer grant was cancelled'; END IF;RETURN NEW;
END $$;
CREATE TRIGGER connection_cancelled_grant BEFORE INSERT OR UPDATE ON provider_transfer_authorizations FOR EACH ROW EXECUTE FUNCTION hail_reject_cancelled_connection_transfer_grant();
CREATE FUNCTION hail_guard_connection_abort_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'DELETE' AND NEW.state='released' AND encode(NEW.plan_digest,'hex')=current_setting('hail.connection_abort_record',true) THEN
    PERFORM 1 FROM provider_accounts WHERE id=NEW.account_id FOR UPDATE;
    IF EXISTS(SELECT 1 FROM account_serving_generations WHERE account_id=NEW.account_id AND generation=NEW.serving_generation) THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP='DELETE' THEN PERFORM hail_assert_unfenced_account(OLD.account_id);RETURN OLD; END IF;
  PERFORM hail_assert_unfenced_account(NEW.account_id);RETURN NEW;
END $$;
DROP TRIGGER connection_handover_barriers_fence ON connection_handover_barriers;
CREATE TRIGGER connection_handover_barriers_fence BEFORE INSERT OR UPDATE OR DELETE ON connection_handover_barriers FOR EACH ROW EXECUTE FUNCTION hail_guard_connection_abort_record();

CREATE FUNCTION hail_preserve_connection_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.connection_cancellation_payload IS NOT NULL AND (NEW.connection_cancellation_payload IS DISTINCT FROM OLD.connection_cancellation_payload OR
    NEW.connection_cancellation_signature IS DISTINCT FROM OLD.connection_cancellation_signature OR NEW.state NOT IN('staged','invalidated')) THEN
    RAISE EXCEPTION 'A cancelled connection transfer cannot resume'; END IF;
  IF OLD.connection_cancellation_slots IS NOT NULL AND NEW.connection_cancellation_slots IS DISTINCT FROM OLD.connection_cancellation_slots THEN
    RAISE EXCEPTION 'Cancelled transfer slot history cannot be replaced'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connection_cancellation_preserve BEFORE UPDATE ON pending_migration_imports FOR EACH ROW EXECUTE FUNCTION hail_preserve_connection_cancellation();
CREATE OR REPLACE FUNCTION hail_connection_handover_blocked(owner_did text,other_did text) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS(SELECT 1 FROM connection_handover_barriers h JOIN provider_accounts a ON a.id=h.account_id
    WHERE h.state IN('frozen','committed') AND ((a.did=owner_did AND h.moving_did=other_did) OR (a.did=other_did AND h.moving_did=owner_did)))
    OR EXISTS(SELECT 1 FROM connection_import_handovers h JOIN provider_accounts a ON a.id=h.account_id
      WHERE h.state IN('frozen','committed') AND ((a.did=owner_did AND h.peer_did=other_did) OR (a.did=other_did AND h.peer_did=owner_did)))
$$;
CREATE OR REPLACE FUNCTION hail_guard_connection_import_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN('completed','released') AND hail_connection_import_context(NEW.account_id) THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM pending_migration_imports p WHERE p.transfer_id=NEW.transfer_id AND p.state IN('staged','active')
    AND ((convert_from(p.manifest_bytes,'UTF8')::jsonb)->>'accountId')=NEW.account_id::text) THEN RAISE EXCEPTION 'Connection handover import has no authenticated account owner'; END IF;
  RETURN NEW;
END $$;

-- Restoring an exact historical delivery is not delivering a new body through
-- the freeze. The exception is confined to the authenticated staged snapshot.
CREATE OR REPLACE FUNCTION hail_guard_handover_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE accepted received_envelopes%ROWTYPE;
BEGIN
  SELECT * INTO accepted FROM received_envelopes WHERE sender_did=NEW.sender_did AND message_id=NEW.message_id AND recipient_did=NEW.recipient_did;
  IF accepted.authorization_type='connection' THEN
    IF hail_connection_import_context(accepted.local_account_id) AND EXISTS(
      SELECT 1 FROM pending_migration_imports p,
        jsonb_array_elements((convert_from(p.manifest_bytes,'UTF8')::jsonb)->'tables'->'delivered_messages') r
      WHERE p.transfer_id::text=current_setting('hail.connection_import_transfer',true) AND p.state='staged'
        AND jsonb_populate_record(NULL::delivered_messages,r) IS NOT DISTINCT FROM NEW) THEN RETURN NEW; END IF;
    PERFORM hail_connection_message_permission(NEW.recipient_did,NEW.sender_did,accepted.connection_id,accepted.connection_epoch,true);
    IF hail_connection_handover_blocked(NEW.recipient_did,NEW.sender_did) THEN
      RAISE EXCEPTION 'Connection delivery is paused for account handover' USING ERRCODE='55000';
    END IF;
  END IF;RETURN NEW;
END $$;

CREATE FUNCTION hail_connection_source_fence_authorized(owner uuid,transfer uuid) RETURNS boolean LANGUAGE sql AS $$
  SELECT current_setting('hail.connection_source_fence',true)=transfer::text AND EXISTS(
    SELECT 1 FROM provider_transfer_authorizations a JOIN provider_accounts p ON p.did=a.did
      WHERE p.id=owner AND a.consumed_transfer_id=transfer AND a.final_request_bytes IS NOT NULL AND a.final_request_signature IS NOT NULL
        AND a.origin_confirmed_at IS NOT NULL AND a.cancelled_at IS NULL)
$$;
CREATE FUNCTION hail_assert_connection_source_drained(owner uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM account_connections WHERE owner IN(account_a,account_b)) OR
    EXISTS(SELECT 1 FROM connection_approvals WHERE account_id=owner AND result IS NULL AND expires_at>clock_timestamp()) OR
    EXISTS(SELECT 1 FROM federated_connection_attempts a WHERE a.account_id=owner AND (a.state='pending' OR a.direction='admitted' AND a.result_cose IS NULL
      AND NOT EXISTS(SELECT 1 FROM federated_connection_results r WHERE r.account_id=owner AND r.id=a.id))) OR
    EXISTS(SELECT 1 FROM federated_connection_disconnects WHERE account_id=owner AND result_cose IS NULL) OR
    EXISTS(SELECT 1 FROM federated_connection_outbox WHERE account_id=owner AND ack_cose IS NULL) OR
    EXISTS(SELECT 1 FROM connection_message_targets WHERE account_id=owner AND state='pending') OR
    EXISTS(SELECT 1 FROM connection_handover_barriers WHERE account_id=owner AND state IN('frozen','committed')) OR
    EXISTS(SELECT 1 FROM connection_import_handovers WHERE account_id=owner AND state IN('frozen','committed')) THEN
    RAISE EXCEPTION 'Finish supported connection work before source fencing' USING ERRCODE='55000';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION hail_connection_preview_cutover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM provider_accounts WHERE id=NEW.account_id FOR UPDATE;
  IF TG_TABLE_NAME='account_serving_generations' THEN
    IF NEW.generation=hail_connection_import_target(NEW.account_id) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='provider_migration_fences' THEN
    IF hail_connection_source_fence_authorized(NEW.account_id,NEW.transfer_id) THEN
      PERFORM hail_assert_connection_source_drained(NEW.account_id);RETURN NEW;
    END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM connection_invitations WHERE account_id=NEW.account_id) OR EXISTS(SELECT 1 FROM account_connections WHERE NEW.account_id IN(account_a,account_b)) THEN
    RAISE EXCEPTION 'Retained connection preview consent is not portable without authenticated source orchestration' USING ERRCODE='55000';
  END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION hail_federated_connection_cutover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM provider_accounts WHERE id=NEW.account_id FOR UPDATE;
  IF TG_TABLE_NAME='account_serving_generations' THEN
    IF NEW.generation=hail_connection_import_target(NEW.account_id) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='provider_migration_fences' THEN
    IF hail_connection_source_fence_authorized(NEW.account_id,NEW.transfer_id) THEN
      PERFORM hail_assert_connection_source_drained(NEW.account_id);RETURN NEW;
    END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM federated_connection_attempts WHERE account_id=NEW.account_id) OR EXISTS(SELECT 1 FROM federated_connection_tombstones WHERE account_id=NEW.account_id) THEN
    RAISE EXCEPTION 'Federated connection consent is not portable without authenticated source orchestration' USING ERRCODE='55000';
  END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION hail_finish_peer_handover_before_cutover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM provider_accounts WHERE id=NEW.account_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM connection_handover_barriers WHERE account_id=NEW.account_id AND state IN('frozen','committed')) THEN
    RAISE EXCEPTION 'Resolve the peer connection handover before moving this account' USING ERRCODE='55000';
  END IF;
  IF TG_TABLE_NAME='account_serving_generations' THEN
    IF NEW.generation=hail_connection_import_target(NEW.account_id) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='provider_migration_fences' THEN
    IF hail_connection_source_fence_authorized(NEW.account_id,NEW.transfer_id) THEN RETURN NEW; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM connection_handover_barriers WHERE account_id=NEW.account_id) THEN
    RAISE EXCEPTION 'Retained peer handover history requires portable preservation before account cutover' USING ERRCODE='55000';
  END IF;RETURN NEW;
END $$;
