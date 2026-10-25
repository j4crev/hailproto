-- Every accepted connect request gets its own proof-bound replication result,
-- including crossed requests which converge on the same canonical event.
ALTER TABLE federated_connection_outbox DROP CONSTRAINT federated_connection_outbox_event_id_key;
ALTER TABLE federated_connection_outbox ADD COLUMN request_id uuid;
CREATE UNIQUE INDEX federated_connection_outbox_intent ON federated_connection_outbox(event_id,COALESCE(request_id,'00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE connection_import_handovers (
  -- Transfer IDs are historical references: the existing return machinery
  -- archives pending imports before clearing their reusable live slots.
  transfer_id uuid NOT NULL,
  account_id uuid NOT NULL,
  peer_did text NOT NULL,
  plan_digest bytea NOT NULL CHECK(octet_length(plan_digest)=32),
  plan_bytes bytea NOT NULL CHECK(octet_length(plan_bytes) BETWEEN 1 AND 65536),
  source_signature bytea NOT NULL CHECK(octet_length(source_signature)=64),
  destination_signature bytea NOT NULL CHECK(octet_length(destination_signature)=64),
  destination_binding bytea NOT NULL CHECK(octet_length(destination_binding) BETWEEN 1 AND 16384),
  source_messaging_key text NOT NULL,
  source_authority jsonb NOT NULL,
  peer_freeze_signature bytea NOT NULL CHECK(octet_length(peer_freeze_signature)=64),
  peer_freeze_key text NOT NULL,
  peer_freeze_authority jsonb NOT NULL,
  state text NOT NULL CHECK(state IN('frozen','committed','completed')),
  commit_payload bytea,
  commit_signature bytea,
  commit_moving_authority jsonb,
  peer_commit_payload bytea,
  peer_commit_signature bytea,
  peer_commit_key text,
  peer_commit_authority jsonb,
  completion_payload bytea,
  completion_signature bytea,
  activation_payload bytea,
  activation_signature bytea,
  peer_completion_payload bytea,
  peer_completion_signature bytea,
  peer_completion_key text,
  peer_completion_authority jsonb,
  PRIMARY KEY(account_id,transfer_id,peer_did),
  CHECK((state='frozen' AND commit_payload IS NULL AND commit_signature IS NULL AND commit_moving_authority IS NULL AND peer_commit_payload IS NULL AND peer_commit_signature IS NULL AND peer_commit_key IS NULL AND peer_commit_authority IS NULL) OR
    (state IN('committed','completed') AND commit_payload IS NOT NULL AND octet_length(commit_payload) BETWEEN 1 AND 4096 AND commit_signature IS NOT NULL AND octet_length(commit_signature)=64
      AND peer_commit_payload IS NOT NULL AND octet_length(peer_commit_payload) BETWEEN 1 AND 65536 AND peer_commit_signature IS NOT NULL AND octet_length(peer_commit_signature)=64 AND peer_commit_key IS NOT NULL AND peer_commit_authority IS NOT NULL AND commit_moving_authority IS NOT NULL)),
  CHECK((state<>'completed' AND completion_payload IS NULL AND completion_signature IS NULL AND activation_payload IS NULL AND activation_signature IS NULL AND peer_completion_payload IS NULL AND peer_completion_signature IS NULL AND peer_completion_key IS NULL AND peer_completion_authority IS NULL) OR
    (state='completed' AND completion_payload IS NOT NULL AND octet_length(completion_payload) BETWEEN 1 AND 4096 AND completion_signature IS NOT NULL AND octet_length(completion_signature)=64
      AND activation_payload IS NOT NULL AND octet_length(activation_payload) BETWEEN 1 AND 16384 AND activation_signature IS NOT NULL AND octet_length(activation_signature)=64
      AND peer_completion_payload IS NOT NULL AND octet_length(peer_completion_payload) BETWEEN 1 AND 65536 AND peer_completion_signature IS NOT NULL AND octet_length(peer_completion_signature)=64 AND peer_completion_key IS NOT NULL AND peer_completion_authority IS NOT NULL))
);
CREATE UNIQUE INDEX connection_import_one_active ON connection_import_handovers(account_id,peer_did) WHERE state<>'completed';
CREATE FUNCTION hail_preserve_connection_import_handover() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutable text[]=ARRAY['state','commit_payload','commit_signature','commit_moving_authority','peer_commit_payload','peer_commit_signature','peer_commit_key','peer_commit_authority',
  'completion_payload','completion_signature','activation_payload','activation_signature','peer_completion_payload','peer_completion_signature','peer_completion_key','peer_completion_authority']; field text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Connection import handover history cannot be deleted'; END IF;
  IF (to_jsonb(NEW)-mutable) IS DISTINCT FROM (to_jsonb(OLD)-mutable) OR OLD.state='completed' AND NEW IS DISTINCT FROM OLD OR OLD.state='committed' AND NEW.state='frozen' THEN
    RAISE EXCEPTION 'Connection import handover intent cannot be replaced'; END IF;
  FOREACH field IN ARRAY mutable LOOP
    IF field<>'state' AND to_jsonb(OLD)->field<>'null'::jsonb AND (to_jsonb(NEW)->field) IS DISTINCT FROM (to_jsonb(OLD)->field) THEN
      RAISE EXCEPTION 'Connection import handover receipt cannot be replaced'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER connection_import_handover_preserve BEFORE UPDATE OR DELETE ON connection_import_handovers FOR EACH ROW EXECUTE FUNCTION hail_preserve_connection_import_handover();
CREATE TRIGGER connection_import_handover_truncate BEFORE TRUNCATE ON connection_import_handovers FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_public_plc_authority();

CREATE TABLE connection_history_archives (
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  transfer_id uuid NOT NULL,
  history_bytes bytea NOT NULL CHECK(octet_length(history_bytes) BETWEEN 1 AND 67108864),
  history_digest bytea NOT NULL CHECK(octet_length(history_digest)=32),
  PRIMARY KEY(account_id,transfer_id)
);
CREATE TRIGGER connection_history_archive_preserve BEFORE UPDATE OR DELETE ON connection_history_archives FOR EACH ROW EXECUTE FUNCTION hail_immutable_public_plc_authority();
CREATE TRIGGER connection_history_archive_truncate BEFORE TRUNCATE ON connection_history_archives FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_public_plc_authority();

CREATE FUNCTION hail_connection_import_target(account uuid) RETURNS bigint LANGUAGE sql AS $$
  SELECT CASE WHEN p.custody_profile='managed' THEN (((convert_from(p.manifest_bytes,'UTF8')::jsonb)->>'sourceGeneration')::bigint+1)
    ELSE NULLIF(current_setting('hail.connection_import_generation',true),'')::bigint END FROM pending_migration_imports p
    WHERE p.transfer_id::text=current_setting('hail.connection_import_transfer',true) AND p.state='staged'
      AND ((convert_from(p.manifest_bytes,'UTF8')::jsonb)->>'accountId')=account::text
      AND ((convert_from(p.manifest_bytes,'UTF8')::jsonb)->>'sourceGeneration')::bigint BETWEEN 1 AND 9007199254740990
$$;
CREATE FUNCTION hail_connection_import_context(account uuid) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS(SELECT 1 FROM account_serving_generations g WHERE g.account_id=account AND g.generation=hail_connection_import_target(account))
$$;
CREATE OR REPLACE FUNCTION hail_guard_generation_advance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id=OLD.account_id AND NEW.generation>OLD.generation AND NEW.generation=hail_connection_import_target(OLD.account_id) THEN RETURN NEW; END IF;
  IF NEW.account_id<>OLD.account_id OR NEW.generation<>OLD.generation THEN
    IF NEW.account_id<>OLD.account_id OR (NEW.generation<>OLD.generation+1 AND NOT(current_setting('hail.managed_migration',true)=OLD.account_id::text AND NEW.generation>OLD.generation)) OR
      (current_setting('hail.returning_account',true) IS DISTINCT FROM OLD.account_id::text AND current_setting('hail.custody_transition',true) IS DISTINCT FROM OLD.account_id::text
        AND current_setting('hail.managed_migration',true) IS DISTINCT FROM OLD.account_id::text) THEN
      RAISE EXCEPTION 'Serving generation needs a reviewed ownership transition' USING ERRCODE='55000';
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
CREATE FUNCTION hail_guard_connection_import_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='completed' AND hail_connection_import_context(NEW.account_id) THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM pending_migration_imports p WHERE p.transfer_id=NEW.transfer_id AND p.state IN('staged','active')
    AND ((convert_from(p.manifest_bytes,'UTF8')::jsonb)->>'accountId')=NEW.account_id::text) THEN
    RAISE EXCEPTION 'Connection handover import has no authenticated account owner';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connection_import_owner BEFORE INSERT ON connection_import_handovers FOR EACH ROW EXECUTE FUNCTION hail_guard_connection_import_owner();

-- Destination state stays held until all final peer receipts and their terminal
-- overlays have been applied, even after the base account is materialized.
CREATE OR REPLACE FUNCTION hail_connection_handover_blocked(owner_did text,other_did text) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS(SELECT 1 FROM connection_handover_barriers h JOIN provider_accounts a ON a.id=h.account_id
    WHERE h.state IN('frozen','committed') AND ((a.did=owner_did AND h.moving_did=other_did) OR (a.did=other_did AND h.moving_did=owner_did)))
    OR EXISTS(SELECT 1 FROM connection_import_handovers h JOIN provider_accounts a ON a.id=h.account_id
      WHERE h.state<>'completed' AND ((a.did=owner_did AND h.peer_did=other_did) OR (a.did=other_did AND h.peer_did=owner_did)))
$$;

-- Preserve all identity/consent/epoch invariants. Only a verified, exact peer
-- commit may change service pins, and only scoped materialization changes gen.
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
    own_did=NEW.local_did;other_did=NEW.peer_did;
    PERFORM hail_assert_unfenced_account(NEW.account_id);
    IF hail_connection_import_context(NEW.account_id) THEN RETURN NEW; END IF;
  END IF;
  IF hail_connection_handover_blocked(own_did,other_did) THEN RAISE EXCEPTION 'Connection activation is paused for account handover' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;

-- A retirement may revoke codes, never change their signed intent or recover
-- their tokens. Ordinary writes still use the same account/generation fence.
CREATE FUNCTION hail_guard_connection_invitation_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner uuid;
BEGIN
  IF TG_OP='UPDATE' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND (to_jsonb(NEW)-'revoked_at') IS NOT DISTINCT FROM (to_jsonb(OLD)-'revoked_at') THEN
    PERFORM 1 FROM provider_accounts WHERE id=NEW.account_id FOR UPDATE;
    IF EXISTS(SELECT 1 FROM provider_migration_fences f WHERE f.account_id=NEW.account_id AND f.transfer_id::text=current_setting('hail.connection_code_retirement',true)
      AND f.state IN('exported','retired') AND NEW.revoked_at>=f.fenced_at) THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP<>'DELETE' THEN owner=NEW.account_id; ELSE owner=OLD.account_id; END IF;
  PERFORM hail_assert_unfenced_account(owner);
  IF TG_OP='UPDATE' AND OLD.account_id IS DISTINCT FROM NEW.account_id THEN PERFORM hail_assert_unfenced_account(OLD.account_id); END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
DROP TRIGGER hail_fence_connection_invitations ON connection_invitations;
CREATE TRIGGER hail_fence_connection_invitations BEFORE INSERT OR UPDATE OR DELETE ON connection_invitations FOR EACH ROW EXECUTE FUNCTION hail_guard_connection_invitation_write();
