BEGIN;
LOCK TABLE connection_import_handovers,connection_history_archives,connection_handover_barriers IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM schema_migrations WHERE version>69) OR EXISTS(SELECT 1 FROM connection_import_handovers) OR EXISTS(SELECT 1 FROM connection_history_archives)
    OR EXISTS(SELECT 1 FROM connection_handover_barriers WHERE state IN('committed','completed')) OR EXISTS(SELECT 1 FROM federated_connection_outbox WHERE request_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Retained connection reconstruction prevents schema rollback';
  END IF;
END $$;
DROP INDEX federated_connection_outbox_intent;
ALTER TABLE federated_connection_outbox DROP COLUMN request_id;
ALTER TABLE federated_connection_outbox ADD CONSTRAINT federated_connection_outbox_event_id_key UNIQUE(event_id);
DROP TRIGGER hail_fence_connection_invitations ON connection_invitations;
DROP FUNCTION hail_guard_connection_invitation_write();
CREATE TRIGGER hail_fence_connection_invitations BEFORE INSERT OR UPDATE OR DELETE ON connection_invitations FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account','account_id');
CREATE OR REPLACE FUNCTION hail_guard_generation_advance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id<>OLD.account_id OR NEW.generation<>OLD.generation THEN
    IF NEW.account_id<>OLD.account_id OR (NEW.generation<>OLD.generation+1 AND NOT(current_setting('hail.managed_migration',true)=OLD.account_id::text AND NEW.generation>OLD.generation)) OR
      (current_setting('hail.returning_account',true) IS DISTINCT FROM OLD.account_id::text AND current_setting('hail.custody_transition',true) IS DISTINCT FROM OLD.account_id::text AND current_setting('hail.managed_migration',true) IS DISTINCT FROM OLD.account_id::text) THEN
      RAISE EXCEPTION 'Serving generation needs a reviewed ownership transition' USING ERRCODE='55000';
    END IF;
  END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION hail_connection_preview_cutover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM provider_accounts WHERE id=NEW.account_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM connection_invitations WHERE account_id=NEW.account_id) OR EXISTS(SELECT 1 FROM account_connections WHERE NEW.account_id IN(account_a,account_b) AND (state IN('active','disconnected') OR state='pending' AND pending_until>clock_timestamp())) THEN
    RAISE EXCEPTION 'Retained connection preview consent is not portable: export support is required before cutover' USING ERRCODE='55000';
  END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION hail_federated_connection_cutover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM provider_accounts WHERE id=NEW.account_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM federated_connection_attempts WHERE account_id=NEW.account_id) OR EXISTS(SELECT 1 FROM federated_connection_tombstones WHERE account_id=NEW.account_id) THEN
    RAISE EXCEPTION 'Federated connection consent is not portable: export support is required before cutover' USING ERRCODE='55000';
  END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION hail_connection_handover_blocked(owner_did text,other_did text) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS(SELECT 1 FROM connection_handover_barriers h JOIN provider_accounts a ON a.id=h.account_id
    WHERE h.state IN('frozen','committed') AND ((a.did=owner_did AND h.moving_did=other_did) OR (a.did=other_did AND h.moving_did=owner_did)))
$$;
CREATE OR REPLACE FUNCTION hail_guard_connection_handover_activation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE own_did text; other_did text; member uuid;
BEGIN
  IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='account_connections' THEN
    IF NEW.state NOT IN('pending','active') THEN RETURN NEW; END IF;
    own_did=NEW.did_a;other_did=NEW.did_b;
    FOR member IN SELECT id FROM provider_accounts WHERE id IN(NEW.account_a,NEW.account_b) ORDER BY id LOOP PERFORM hail_assert_unfenced_account(member); END LOOP;
  ELSE
    IF NEW.state<>'active' OR TG_OP='UPDATE' AND ROW(NEW.state,NEW.connection_id,NEW.epoch) IS NOT DISTINCT FROM ROW(OLD.state,OLD.connection_id,OLD.epoch) THEN RETURN NEW; END IF;
    own_did=NEW.local_did;other_did=NEW.peer_did;PERFORM hail_assert_unfenced_account(NEW.account_id);
  END IF;
  IF hail_connection_handover_blocked(own_did,other_did) THEN RAISE EXCEPTION 'Connection activation is paused for account handover' USING ERRCODE='55000'; END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION hail_preserve_federated_connection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Federated connection history cannot be deleted'; END IF;
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='federated_connection_pairs' THEN
      IF ROW(NEW.id,NEW.account_id,NEW.serving_generation,NEW.local_did,NEW.peer_did,NEW.peer_address,NEW.peer_service_base,NEW.coordinator_service_base,NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id,OLD.account_id,OLD.serving_generation,OLD.local_did,OLD.peer_did,OLD.peer_address,OLD.peer_service_base,OLD.coordinator_service_base,OLD.created_at)
        OR NEW.epoch<OLD.epoch OR OLD.cutoff_at IS NOT NULL AND (NEW.cutoff_at IS NULL OR NEW.cutoff_at<OLD.cutoff_at) THEN RAISE EXCEPTION 'Federated pair identity and history cannot be replaced'; END IF;
      IF NEW.state='active' AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.epoch>OLD.epoch)
        AND EXISTS(SELECT 1 FROM federated_connection_tombstones WHERE pair_id=NEW.id AND connection_id=NEW.connection_id) THEN RAISE EXCEPTION 'A terminal connection epoch cannot be reopened'; END IF;
    ELSIF TG_TABLE_NAME='federated_connection_attempts' THEN
      IF (to_jsonb(NEW)-ARRAY['admission_cose','result_cose','state','next_attempt_at','attempts']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['admission_cose','result_cose','state','next_attempt_at','attempts']) OR
        OLD.admission_cose IS NOT NULL AND NEW.admission_cose IS DISTINCT FROM OLD.admission_cose OR OLD.result_cose IS NOT NULL AND NEW.result_cose IS DISTINCT FROM OLD.result_cose OR
        OLD.state IN('active','expired','conflict') AND NEW.state IS DISTINCT FROM OLD.state THEN RAISE EXCEPTION 'Federated consent and terminal result cannot be replaced'; END IF;
    ELSIF TG_TABLE_NAME='federated_connection_disconnects' THEN
      IF (to_jsonb(NEW)-ARRAY['result_cose','next_attempt_at','attempts']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['result_cose','next_attempt_at','attempts']) OR OLD.result_cose IS NOT NULL AND NEW.result_cose IS DISTINCT FROM OLD.result_cose THEN RAISE EXCEPTION 'Disconnect intent cannot be replaced'; END IF;
    ELSIF TG_TABLE_NAME='federated_connection_outbox' THEN
      IF (to_jsonb(NEW)-ARRAY['ack_cose','next_attempt_at','attempts']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['ack_cose','next_attempt_at','attempts']) OR OLD.ack_cose IS NOT NULL AND NEW.ack_cose IS DISTINCT FROM OLD.ack_cose THEN RAISE EXCEPTION 'Connection delivery intent cannot be replaced'; END IF;
    ELSE RAISE EXCEPTION 'Federated connection proof cannot be replaced'; END IF;
  END IF;RETURN NEW;
END $$;
DROP TABLE connection_import_handovers,connection_history_archives;
DROP FUNCTION hail_preserve_connection_import_handover();
DROP FUNCTION hail_guard_connection_import_owner();
DROP FUNCTION hail_connection_import_context(uuid);
DROP FUNCTION hail_connection_import_target(uuid);
DELETE FROM schema_migrations WHERE version=69;
COMMIT;
