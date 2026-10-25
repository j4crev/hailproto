-- A peer-side freeze is durable, not a timed lease. Expiry of a transport
-- approval never silently restores messaging or permits another activation.
CREATE TABLE connection_handover_barriers (
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  serving_generation bigint NOT NULL CHECK(serving_generation>0),
  moving_did text NOT NULL CHECK(moving_did ~ '^did:plc:[a-z2-7]{24}$'),
  transfer_id uuid NOT NULL,
  plan_digest bytea NOT NULL CHECK(octet_length(plan_digest)=32),
  plan_bytes bytea NOT NULL CHECK(octet_length(plan_bytes) BETWEEN 1 AND 65536),
  source_signature bytea NOT NULL CHECK(octet_length(source_signature)=64),
  destination_signature bytea NOT NULL CHECK(octet_length(destination_signature)=64),
  source_messaging_key text NOT NULL,
  source_authority jsonb NOT NULL,
  source_service_base text NOT NULL,
  destination_service_base text NOT NULL,
  peer_service_base text NOT NULL,
  peer_signature bytea NOT NULL CHECK(octet_length(peer_signature)=64),
  peer_messaging_key text NOT NULL,
  peer_authority jsonb NOT NULL,
  state text NOT NULL DEFAULT 'frozen' CHECK(state IN('frozen','committed','completed','released')),
  destination_binding bytea,
  destination_address text,
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
  release_payload bytea,
  release_source_signature bytea,
  release_source_authority jsonb,
  release_destination_signature bytea,
  release_peer_signature bytea,
  release_peer_key text,
  release_peer_authority jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,plan_digest),
  CHECK((state IN('frozen','committed','completed') AND release_payload IS NULL AND release_source_signature IS NULL AND release_source_authority IS NULL AND release_destination_signature IS NULL
    AND release_peer_signature IS NULL AND release_peer_key IS NULL AND release_peer_authority IS NULL) OR
    (state='released' AND release_payload IS NOT NULL AND octet_length(release_payload) BETWEEN 1 AND 4096 AND release_source_signature IS NOT NULL
    AND octet_length(release_source_signature)=64 AND release_source_authority IS NOT NULL AND release_destination_signature IS NOT NULL AND octet_length(release_destination_signature)=64
    AND release_peer_signature IS NOT NULL AND octet_length(release_peer_signature)=64 AND release_peer_key IS NOT NULL AND release_peer_authority IS NOT NULL)),
  CHECK((state IN('frozen','released') AND destination_binding IS NULL AND destination_address IS NULL AND commit_payload IS NULL AND commit_signature IS NULL
    AND commit_moving_authority IS NULL AND peer_commit_payload IS NULL AND peer_commit_signature IS NULL AND peer_commit_key IS NULL AND peer_commit_authority IS NULL) OR
    (state IN('committed','completed') AND destination_binding IS NOT NULL AND octet_length(destination_binding) BETWEEN 1 AND 16384 AND destination_address IS NOT NULL
    AND commit_payload IS NOT NULL AND octet_length(commit_payload) BETWEEN 1 AND 4096 AND commit_signature IS NOT NULL AND octet_length(commit_signature)=64
    AND peer_commit_payload IS NOT NULL AND octet_length(peer_commit_payload) BETWEEN 1 AND 65536 AND peer_commit_signature IS NOT NULL AND octet_length(peer_commit_signature)=64
    AND peer_commit_key IS NOT NULL AND peer_commit_authority IS NOT NULL AND commit_moving_authority IS NOT NULL)),
  CHECK((state<>'completed' AND completion_payload IS NULL AND completion_signature IS NULL AND activation_payload IS NULL AND activation_signature IS NULL AND peer_completion_payload IS NULL AND peer_completion_signature IS NULL
    AND peer_completion_key IS NULL AND peer_completion_authority IS NULL) OR
    (state='completed' AND completion_payload IS NOT NULL AND octet_length(completion_payload) BETWEEN 1 AND 4096 AND completion_signature IS NOT NULL AND octet_length(completion_signature)=64
    AND activation_payload IS NOT NULL AND octet_length(activation_payload) BETWEEN 1 AND 16384 AND activation_signature IS NOT NULL AND octet_length(activation_signature)=64
    AND peer_completion_payload IS NOT NULL AND octet_length(peer_completion_payload) BETWEEN 1 AND 65536 AND peer_completion_signature IS NOT NULL AND octet_length(peer_completion_signature)=64
    AND peer_completion_key IS NOT NULL AND peer_completion_authority IS NOT NULL))
);
CREATE UNIQUE INDEX connection_handover_one_frozen ON connection_handover_barriers(account_id,moving_did) WHERE state IN('frozen','committed');
CREATE TRIGGER connection_handover_barriers_fence BEFORE INSERT OR UPDATE OR DELETE ON connection_handover_barriers
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account','account_id');
CREATE TRIGGER connection_handover_barriers_no_truncate BEFORE TRUNCATE ON connection_handover_barriers
  FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_public_plc_authority();
CREATE FUNCTION hail_preserve_connection_handover_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutable text[]=ARRAY['state','release_payload','release_source_signature','release_source_authority','release_destination_signature','release_peer_signature','release_peer_key','release_peer_authority',
  'destination_binding','destination_address','commit_payload','commit_signature','commit_moving_authority','peer_commit_payload','peer_commit_signature','peer_commit_key','peer_commit_authority',
  'completion_payload','completion_signature','activation_payload','activation_signature','peer_completion_payload','peer_completion_signature','peer_completion_key','peer_completion_authority']; field text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Connection handover barriers cannot be deleted'; END IF;
  IF (to_jsonb(NEW)-mutable) IS DISTINCT FROM (to_jsonb(OLD)-mutable)
    OR OLD.state IN('released','completed') AND NEW IS DISTINCT FROM OLD
    OR OLD.state='committed' AND NEW.state NOT IN('committed','completed') THEN
    RAISE EXCEPTION 'Connection handover intent and terminal release cannot be replaced';
  END IF;
  FOREACH field IN ARRAY mutable LOOP
    IF field<>'state' AND to_jsonb(OLD)->field<>'null'::jsonb AND (to_jsonb(NEW)->field) IS DISTINCT FROM (to_jsonb(OLD)->field) THEN
      RAISE EXCEPTION 'Connection handover receipts cannot be replaced';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER connection_handover_barriers_preserve BEFORE UPDATE OR DELETE ON connection_handover_barriers
  FOR EACH ROW EXECUTE FUNCTION hail_preserve_connection_handover_barrier();

CREATE FUNCTION hail_connection_handover_blocked(owner_did text,other_did text) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS(SELECT 1 FROM connection_handover_barriers h JOIN provider_accounts a ON a.id=h.account_id
    WHERE h.state IN('frozen','committed') AND ((a.did=owner_did AND h.moving_did=other_did) OR (a.did=other_did AND h.moving_did=owner_did)))
$$;

-- Reuse the permission predicate. Keep pause distinct from permanent rejection
-- so authenticated envelopes can be accepted durably but delivery stays on hold.
ALTER FUNCTION hail_connection_message_allowed(text,text,uuid,bigint,boolean) RENAME TO hail_connection_message_permission;
CREATE FUNCTION hail_connection_message_allowed(owner_did text,other_did text,connection uuid,expected_epoch bigint,lock_pair boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  IF NOT hail_connection_message_permission(owner_did,other_did,connection,expected_epoch,lock_pair) THEN RETURN false; END IF;
  RETURN NOT hail_connection_handover_blocked(owner_did,other_did);
END $$;

-- Final storage barrier also covers callers with an already-prepared permission
-- query. Historical imports need not be currently connected, so this trigger
-- enforces the pause only; normal delivery still checks standing permission.
CREATE FUNCTION hail_guard_handover_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE accepted received_envelopes%ROWTYPE;
BEGIN
  SELECT * INTO accepted FROM received_envelopes WHERE sender_did=NEW.sender_did AND message_id=NEW.message_id AND recipient_did=NEW.recipient_did;
  IF accepted.authorization_type='connection' THEN
    PERFORM hail_connection_message_permission(NEW.recipient_did,NEW.sender_did,accepted.connection_id,accepted.connection_epoch,true);
    IF hail_connection_handover_blocked(NEW.recipient_did,NEW.sender_did) THEN
      RAISE EXCEPTION 'Connection delivery is paused for account handover' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connection_handover_final_delivery BEFORE INSERT ON delivered_messages FOR EACH ROW EXECUTE FUNCTION hail_guard_handover_delivery();

CREATE FUNCTION hail_guard_connection_handover_activation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE own_did text; other_did text; member uuid;
BEGIN
  IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='account_connections' THEN
    IF NEW.state NOT IN('pending','active') THEN RETURN NEW; END IF;
    own_did=NEW.did_a;other_did=NEW.did_b;
    FOR member IN SELECT id FROM provider_accounts WHERE id IN(NEW.account_a,NEW.account_b) ORDER BY id LOOP
      PERFORM hail_assert_unfenced_account(member);
    END LOOP;
  ELSE
    IF NEW.state<>'active' OR TG_OP='UPDATE' AND ROW(NEW.state,NEW.connection_id,NEW.epoch) IS NOT DISTINCT FROM ROW(OLD.state,OLD.connection_id,OLD.epoch) THEN RETURN NEW; END IF;
    own_did=NEW.local_did;other_did=NEW.peer_did;
    PERFORM hail_assert_unfenced_account(NEW.account_id);
  END IF;
  IF hail_connection_handover_blocked(own_did,other_did) THEN
    RAISE EXCEPTION 'Connection activation is paused for account handover' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connection_native_handover_activation BEFORE INSERT OR UPDATE ON account_connections
  FOR EACH ROW EXECUTE FUNCTION hail_guard_connection_handover_activation();
CREATE TRIGGER connection_federated_handover_activation BEFORE INSERT OR UPDATE ON federated_connection_pairs
  FOR EACH ROW EXECUTE FUNCTION hail_guard_connection_handover_activation();

CREATE FUNCTION hail_finish_peer_handover_before_cutover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM provider_accounts WHERE id=NEW.account_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM connection_handover_barriers WHERE account_id=NEW.account_id AND state IN('frozen','committed')) THEN
    RAISE EXCEPTION 'Resolve the peer connection handover before moving this account' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM connection_handover_barriers WHERE account_id=NEW.account_id) THEN
    RAISE EXCEPTION 'Retained peer handover history requires portable preservation before account cutover' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connection_handover_before_fence BEFORE INSERT ON provider_migration_fences
  FOR EACH ROW EXECUTE FUNCTION hail_finish_peer_handover_before_cutover();
CREATE TRIGGER connection_handover_before_generation BEFORE UPDATE OF generation ON account_serving_generations
  FOR EACH ROW WHEN(NEW.generation IS DISTINCT FROM OLD.generation) EXECUTE FUNCTION hail_finish_peer_handover_before_cutover();
CREATE TRIGGER connection_handover_before_custody BEFORE INSERT ON custody_transition_preparations
  FOR EACH ROW EXECUTE FUNCTION hail_finish_peer_handover_before_cutover();
