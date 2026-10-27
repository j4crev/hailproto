BEGIN;
LOCK TABLE custody_transition_preparations IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM schema_migrations WHERE version>75) OR EXISTS(
    SELECT 1 FROM custody_transition_preparations c WHERE c.state<>'complete' AND (
      EXISTS(SELECT 1 FROM connection_invitations WHERE account_id=c.account_id) OR
      EXISTS(SELECT 1 FROM federated_connection_pairs WHERE account_id=c.account_id) OR
      EXISTS(SELECT 1 FROM connection_history_archives WHERE account_id=c.account_id) OR
      EXISTS(SELECT 1 FROM connection_handover_barriers WHERE account_id=c.account_id))) THEN
    RAISE EXCEPTION 'Connection custody rollback refused: finish pending transitions first';
  END IF;
END $$;
DROP TRIGGER connection_custody_guard ON custody_transition_preparations;
DROP FUNCTION hail_guard_connection_custody();
CREATE TRIGGER connection_preview_custody BEFORE INSERT ON custody_transition_preparations
  FOR EACH ROW EXECUTE FUNCTION hail_connection_preview_cutover();
CREATE TRIGGER federated_connection_custody BEFORE INSERT ON custody_transition_preparations
  FOR EACH ROW EXECUTE FUNCTION hail_federated_connection_cutover();
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

CREATE OR REPLACE FUNCTION hail_preserve_federated_connection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pin_commit boolean=false; importing boolean=false;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Federated connection history cannot be deleted'; END IF;
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='federated_connection_pairs' THEN
      importing=hail_connection_import_context(NEW.account_id);
      SELECT EXISTS(SELECT 1 FROM connection_handover_barriers h WHERE h.account_id=NEW.account_id AND h.moving_did=NEW.peer_did
        AND encode(h.plan_digest,'hex')=current_setting('hail.connection_handover_commit',true) AND h.state='committed'
        AND NEW.peer_address=h.destination_address
        AND NEW.peer_service_base=h.destination_service_base
        AND NEW.coordinator_service_base=CASE WHEN NEW.local_did<NEW.peer_did THEN h.peer_service_base ELSE h.destination_service_base END
        AND (to_jsonb(NEW)-ARRAY['peer_address','peer_service_base','coordinator_service_base','updated_at']) IS NOT DISTINCT FROM
          (to_jsonb(OLD)-ARRAY['peer_address','peer_service_base','coordinator_service_base','updated_at'])) INTO pin_commit;
      IF ROW(NEW.id,NEW.account_id,NEW.local_did,NEW.peer_did,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.account_id,OLD.local_did,OLD.peer_did,OLD.created_at)
        OR NEW.serving_generation IS DISTINCT FROM OLD.serving_generation AND NOT importing
        OR ROW(NEW.peer_address,NEW.peer_service_base,NEW.coordinator_service_base) IS DISTINCT FROM ROW(OLD.peer_address,OLD.peer_service_base,OLD.coordinator_service_base) AND NOT(pin_commit OR importing)
        OR NEW.epoch<OLD.epoch OR OLD.cutoff_at IS NOT NULL AND (NEW.cutoff_at IS NULL OR NEW.cutoff_at<OLD.cutoff_at) THEN
        RAISE EXCEPTION 'Federated pair identity and history cannot be replaced'; END IF;
      IF NEW.state='active' AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.epoch>OLD.epoch)
        AND EXISTS(SELECT 1 FROM federated_connection_tombstones WHERE pair_id=NEW.id AND connection_id=NEW.connection_id) THEN
        RAISE EXCEPTION 'A terminal connection epoch cannot be reopened'; END IF;
    ELSIF TG_TABLE_NAME='federated_connection_attempts' THEN
      IF (to_jsonb(NEW)-ARRAY['admission_cose','result_cose','state','next_attempt_at','attempts']) IS DISTINCT FROM
        (to_jsonb(OLD)-ARRAY['admission_cose','result_cose','state','next_attempt_at','attempts']) OR
        OLD.admission_cose IS NOT NULL AND NEW.admission_cose IS DISTINCT FROM OLD.admission_cose OR OLD.result_cose IS NOT NULL AND NEW.result_cose IS DISTINCT FROM OLD.result_cose OR
        OLD.state IN('active','expired','conflict') AND NEW.state IS DISTINCT FROM OLD.state THEN RAISE EXCEPTION 'Federated consent and terminal result cannot be replaced'; END IF;
    ELSIF TG_TABLE_NAME='federated_connection_disconnects' THEN
      IF (to_jsonb(NEW)-ARRAY['result_cose','next_attempt_at','attempts']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['result_cose','next_attempt_at','attempts']) OR
        OLD.result_cose IS NOT NULL AND NEW.result_cose IS DISTINCT FROM OLD.result_cose THEN RAISE EXCEPTION 'Disconnect intent cannot be replaced'; END IF;
    ELSIF TG_TABLE_NAME='federated_connection_outbox' THEN
      IF (to_jsonb(NEW)-ARRAY['ack_cose','next_attempt_at','attempts']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['ack_cose','next_attempt_at','attempts']) OR
        OLD.ack_cose IS NOT NULL AND NEW.ack_cose IS DISTINCT FROM OLD.ack_cose THEN RAISE EXCEPTION 'Connection delivery intent cannot be replaced'; END IF;
    ELSE RAISE EXCEPTION 'Federated connection proof cannot be replaced'; END IF;
  END IF;
  RETURN NEW;
END $$;


DROP FUNCTION hail_assert_connection_custody_complete(uuid,bigint,bigint);
DROP FUNCTION hail_connection_custody_context(uuid,bigint,bigint);
DELETE FROM schema_migrations WHERE version=75;
COMMIT;
