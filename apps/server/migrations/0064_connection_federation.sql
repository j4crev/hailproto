CREATE TABLE federated_connection_pairs (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  serving_generation bigint NOT NULL CHECK(serving_generation>0),
  local_did text NOT NULL CHECK(local_did ~ '^did:plc:[a-z2-7]{24}$'),
  peer_did text NOT NULL CHECK(peer_did ~ '^did:plc:[a-z2-7]{24}$' AND peer_did<>local_did),
  peer_address text NOT NULL,
  peer_service_base text NOT NULL,
  coordinator_service_base text NOT NULL,
  epoch bigint NOT NULL DEFAULT 0 CHECK(epoch>=0),
  state text NOT NULL DEFAULT 'empty' CHECK(state IN ('empty','active','disconnected')),
  connection_id uuid,
  cutoff_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(account_id,peer_did),
  UNIQUE(id,account_id),
  CHECK((state='empty' AND connection_id IS NULL AND epoch=0) OR (state<>'empty' AND connection_id IS NOT NULL AND epoch>0))
);
CREATE TABLE federated_connection_attempts (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  pair_id uuid NOT NULL REFERENCES federated_connection_pairs(id) ON DELETE RESTRICT,
  direction text NOT NULL CHECK(direction IN ('outbound','admitted')),
  bundle bytea NOT NULL CHECK(octet_length(bundle) BETWEEN 1 AND 100000),
  proof_digest bytea NOT NULL CHECK(octet_length(proof_digest)=32),
  token_ciphertext bytea,
  token_nonce bytea,
  admission_cose bytea,
  result_cose bytea,
  state text NOT NULL CHECK(state IN ('pending','admitted','active','expired','conflict')),
  expires_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((direction='admitted' AND token_ciphertext IS NULL AND token_nonce IS NULL) OR
    (direction='outbound' AND octet_length(token_ciphertext)=48 AND octet_length(token_nonce)=12))
);
CREATE TABLE federated_connection_events (
  -- One immutable coordinator event per pair epoch.
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  pair_id uuid NOT NULL REFERENCES federated_connection_pairs(id) ON DELETE RESTRICT,
  epoch bigint NOT NULL CHECK(epoch>0),
  state text NOT NULL CHECK(state IN ('active','disconnected')),
  connection_id uuid NOT NULL,
  request_id uuid NOT NULL,
  proof_digest bytea NOT NULL CHECK(octet_length(proof_digest)=32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(pair_id,epoch),
  UNIQUE(id,account_id)
);
CREATE UNIQUE INDEX federated_connection_one_pending ON federated_connection_attempts(pair_id) WHERE direction='outbound' AND state='pending';
CREATE TABLE federated_connection_results (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  pair_id uuid NOT NULL REFERENCES federated_connection_pairs(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK(action IN ('connect','disconnect')),
  request_cose bytea NOT NULL CHECK(octet_length(request_cose) BETWEEN 1 AND 16384),
  proof_digest bytea NOT NULL CHECK(octet_length(proof_digest)=32),
  event_id uuid NOT NULL REFERENCES federated_connection_events(id) ON DELETE RESTRICT
);
CREATE TABLE federated_connection_tombstones (
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  pair_id uuid NOT NULL REFERENCES federated_connection_pairs(id) ON DELETE RESTRICT,
  connection_id uuid NOT NULL,
  epoch bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(pair_id,connection_id)
);
CREATE TABLE federated_connection_disconnects (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  pair_id uuid NOT NULL REFERENCES federated_connection_pairs(id) ON DELETE RESTRICT,
  connection_id uuid NOT NULL,
  epoch bigint NOT NULL,
  result_cose bytea,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0
);
CREATE TABLE federated_connection_outbox (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  event_id uuid NOT NULL UNIQUE REFERENCES federated_connection_events(id) ON DELETE RESTRICT,
  ack_cose bytea,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0
);
CREATE TABLE federated_connection_signatures (
  digest bytea PRIMARY KEY CHECK(octet_length(digest)=32),
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  cose bytea NOT NULL CHECK(octet_length(cose) BETWEEN 1 AND 16384),
  authority jsonb NOT NULL
);
ALTER TABLE connection_approvals ADD COLUMN federated_pair_id uuid REFERENCES federated_connection_pairs(id) ON DELETE RESTRICT,
  ADD COLUMN remote_bundle bytea,ADD COLUMN remote_token_ciphertext bytea,ADD COLUMN remote_token_nonce bytea,
  ADD CONSTRAINT connection_remote_intent CHECK((remote_bundle IS NULL AND remote_token_ciphertext IS NULL AND remote_token_nonce IS NULL) OR
    (federated_pair_id IS NOT NULL AND octet_length(remote_bundle) BETWEEN 1 AND 100000 AND octet_length(remote_token_ciphertext)=48 AND octet_length(remote_token_nonce)=12));
ALTER TABLE connection_approvals ADD CONSTRAINT connection_remote_owner FOREIGN KEY(federated_pair_id,account_id)
  REFERENCES federated_connection_pairs(id,account_id) ON DELETE RESTRICT;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['federated_connection_attempts','federated_connection_events','federated_connection_results',
    'federated_connection_tombstones','federated_connection_disconnects'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY(pair_id,account_id) REFERENCES federated_connection_pairs(id,account_id) ON DELETE RESTRICT',t,t||'_owner');
  END LOOP;
END $$;
ALTER TABLE federated_connection_outbox ADD CONSTRAINT federated_outbox_owner FOREIGN KEY(event_id,account_id)
  REFERENCES federated_connection_events(id,account_id) ON DELETE RESTRICT;
ALTER TABLE federated_connection_results ADD CONSTRAINT federated_result_owner FOREIGN KEY(event_id,account_id)
  REFERENCES federated_connection_events(id,account_id) ON DELETE RESTRICT;

CREATE FUNCTION hail_preserve_federated_connection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Federated connection history cannot be deleted'; END IF;
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='federated_connection_pairs' THEN
      IF ROW(NEW.id,NEW.account_id,NEW.serving_generation,NEW.local_did,NEW.peer_did,NEW.peer_address,NEW.peer_service_base,NEW.coordinator_service_base,NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id,OLD.account_id,OLD.serving_generation,OLD.local_did,OLD.peer_did,OLD.peer_address,OLD.peer_service_base,OLD.coordinator_service_base,OLD.created_at)
        OR NEW.epoch<OLD.epoch OR OLD.cutoff_at IS NOT NULL AND (NEW.cutoff_at IS NULL OR NEW.cutoff_at<OLD.cutoff_at) THEN
        RAISE EXCEPTION 'Federated pair identity and history cannot be replaced'; END IF;
      IF NEW.state='active' AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.epoch>OLD.epoch)
        AND EXISTS(SELECT 1 FROM federated_connection_tombstones WHERE pair_id=NEW.id AND connection_id=NEW.connection_id) THEN
        RAISE EXCEPTION 'A terminal connection epoch cannot be reopened'; END IF;
    ELSIF TG_TABLE_NAME='federated_connection_attempts' THEN
      IF (to_jsonb(NEW)-ARRAY['admission_cose','result_cose','state','next_attempt_at','attempts']) IS DISTINCT FROM
        (to_jsonb(OLD)-ARRAY['admission_cose','result_cose','state','next_attempt_at','attempts']) OR
        OLD.admission_cose IS NOT NULL AND NEW.admission_cose IS DISTINCT FROM OLD.admission_cose OR
        OLD.result_cose IS NOT NULL AND NEW.result_cose IS DISTINCT FROM OLD.result_cose OR
        OLD.state IN ('active','expired','conflict') AND NEW.state IS DISTINCT FROM OLD.state THEN
        RAISE EXCEPTION 'Federated consent and terminal result cannot be replaced'; END IF;
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
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['federated_connection_pairs','federated_connection_attempts','federated_connection_events','federated_connection_results',
    'federated_connection_tombstones','federated_connection_disconnects','federated_connection_outbox','federated_connection_signatures'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write(''account'',''account_id'')',t||'_fence',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION hail_preserve_federated_connection()',t||'_preserve',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_public_plc_authority()',t||'_truncate',t);
  END LOOP;
END $$;
CREATE FUNCTION hail_federated_connection_cutover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM provider_accounts WHERE id=NEW.account_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM federated_connection_attempts WHERE account_id=NEW.account_id) OR
    EXISTS(SELECT 1 FROM federated_connection_tombstones WHERE account_id=NEW.account_id) THEN
    RAISE EXCEPTION 'Federated connection consent is not portable: export support is required before cutover' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER federated_connection_fence BEFORE INSERT ON provider_migration_fences FOR EACH ROW EXECUTE FUNCTION hail_federated_connection_cutover();
CREATE TRIGGER federated_connection_generation BEFORE UPDATE OF generation ON account_serving_generations
  FOR EACH ROW WHEN(NEW.generation IS DISTINCT FROM OLD.generation) EXECUTE FUNCTION hail_federated_connection_cutover();
CREATE TRIGGER federated_connection_custody BEFORE INSERT ON custody_transition_preparations FOR EACH ROW EXECUTE FUNCTION hail_federated_connection_cutover();
