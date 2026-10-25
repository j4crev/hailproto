-- Existing envelopes/body retrieval/delivery are retained; only authorization is extended.
ALTER TABLE sent_envelopes ADD COLUMN connection_id uuid,ADD COLUMN connection_epoch bigint;
ALTER TABLE received_envelopes ADD COLUMN connection_id uuid,ADD COLUMN connection_epoch bigint;
ALTER TABLE sent_envelopes DROP CONSTRAINT sent_envelopes_authorization_shape;
ALTER TABLE received_envelopes DROP CONSTRAINT received_envelopes_authorization_shape;
ALTER TABLE sent_envelopes ADD CONSTRAINT sent_envelopes_authorization_shape CHECK(
  (authorization_type='grant' AND grant_id IS NOT NULL AND reply_to_message_id IS NULL AND connection_id IS NULL AND connection_epoch IS NULL) OR
  (authorization_type='reply' AND grant_id IS NULL AND reply_to_message_id IS NOT NULL AND connection_id IS NULL AND connection_epoch IS NULL) OR
  (authorization_type='connection' AND grant_id IS NULL AND reply_to_message_id IS NULL AND connection_id IS NOT NULL AND connection_epoch IS NOT NULL AND connection_epoch>0));
ALTER TABLE received_envelopes ADD CONSTRAINT received_envelopes_authorization_shape CHECK(
  (authorization_type='grant' AND grant_id IS NOT NULL AND reply_to_message_id IS NULL AND connection_id IS NULL AND connection_epoch IS NULL) OR
  (authorization_type='reply' AND grant_id IS NULL AND reply_to_message_id IS NOT NULL AND connection_id IS NULL AND connection_epoch IS NULL) OR
  (authorization_type='connection' AND grant_id IS NULL AND reply_to_message_id IS NULL AND connection_id IS NOT NULL AND connection_epoch IS NOT NULL AND connection_epoch>0));

-- One shared local permission predicate, including a transactional disconnect barrier.
CREATE FUNCTION hail_connection_message_allowed(owner_did text,other_did text,connection uuid,expected_epoch bigint,lock_pair boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE member uuid; owner_id uuid;
BEGIN
  IF owner_did=other_did OR expected_epoch<1 THEN RETURN false; END IF;
  SELECT a.id INTO owner_id FROM provider_accounts a JOIN account_serving_generations g ON g.account_id=a.id
    WHERE a.did=owner_did AND a.onboarding_state='active' AND a.activation_verification_mode='public';
  IF owner_id IS NULL THEN RETURN false; END IF;
  IF lock_pair THEN
    FOR member IN SELECT a.id FROM provider_accounts a WHERE a.id=owner_id OR a.id IN (
      SELECT c.account_a FROM account_connections c WHERE c.id=connection AND owner_did IN(c.did_a,c.did_b) AND other_did IN(c.did_a,c.did_b)
      UNION SELECT c.account_b FROM account_connections c WHERE c.id=connection AND owner_did IN(c.did_a,c.did_b) AND other_did IN(c.did_a,c.did_b)
    ) ORDER BY a.id LOOP PERFORM hail_assert_unfenced_account(member); END LOOP;
  END IF;
  RETURN EXISTS(SELECT 1 FROM account_connections c
    JOIN provider_accounts a ON a.id=c.account_a JOIN provider_accounts b ON b.id=c.account_b
    JOIN account_serving_generations ga ON ga.account_id=a.id JOIN account_serving_generations gb ON gb.account_id=b.id
    WHERE c.id=connection AND expected_epoch=1 AND c.state='active' AND owner_did IN(c.did_a,c.did_b) AND other_did IN(c.did_a,c.did_b)
      AND a.did=c.did_a AND b.did=c.did_b AND a.onboarding_state='active' AND b.onboarding_state='active'
      AND a.activation_verification_mode='public' AND b.activation_verification_mode='public'
      AND ga.generation=c.generation_a AND gb.generation=c.generation_b
      AND NOT EXISTS(SELECT 1 FROM provider_migration_fences f WHERE f.account_id IN(a.id,b.id)))
    OR EXISTS(SELECT 1 FROM federated_connection_pairs p JOIN account_serving_generations g ON g.account_id=p.account_id
      WHERE p.account_id=owner_id AND p.local_did=owner_did AND p.peer_did=other_did AND p.connection_id=connection AND p.epoch=expected_epoch
        AND p.state='active' AND p.serving_generation=g.generation
        AND NOT EXISTS(SELECT 1 FROM federated_connection_tombstones t WHERE t.pair_id=p.id AND t.connection_id=connection)
        AND NOT EXISTS(SELECT 1 FROM provider_migration_fences f WHERE f.account_id=p.account_id));
END $$;

-- Separate intent rows keep old publication workers safe during code rollback.
-- They are processed by the same bounded publication/outbound worker and send pipeline.
CREATE TABLE connection_message_batches (
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  sender_did text NOT NULL,
  serving_generation bigint NOT NULL CHECK(serving_generation>0),
  body_bytes bytea NOT NULL CHECK(octet_length(body_bytes) BETWEEN 1 AND 262144),
  manifest bytea NOT NULL CHECK(octet_length(manifest) BETWEEN 1 AND 65536),
  request_digest bytea NOT NULL CHECK(octet_length(request_digest)=32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
  cancelled_at timestamptz,
  sealed boolean NOT NULL DEFAULT false,
  PRIMARY KEY(account_id,id)
);
CREATE TABLE connection_message_targets (
  account_id uuid NOT NULL,
  publication_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  connection_epoch bigint NOT NULL CHECK(connection_epoch>0),
  recipient_did text NOT NULL,
  message_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','submitted','blocked','cancelled','expired','indeterminate')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,publication_id,recipient_did),
  UNIQUE(account_id,message_id),
  FOREIGN KEY(account_id,publication_id) REFERENCES connection_message_batches(account_id,id) ON DELETE RESTRICT
);
CREATE INDEX connection_message_pending ON connection_message_targets(next_attempt_at) WHERE state='pending';
CREATE FUNCTION hail_preserve_connection_message_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Retained connection message intent cannot be deleted'; END IF;
  IF TG_TABLE_NAME='connection_message_batches' THEN
    IF (to_jsonb(NEW)-'cancelled_at'-'sealed') IS DISTINCT FROM (to_jsonb(OLD)-'cancelled_at'-'sealed') OR
      OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR OLD.sealed AND NOT NEW.sealed THEN
      RAISE EXCEPTION 'Connection message intent cannot be replaced'; END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['state','attempts','next_attempt_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','attempts','next_attempt_at']) OR
      OLD.state<>'pending' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Connection message audience and terminal outcomes cannot be replaced'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION hail_admit_connection_message_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT sealed FROM connection_message_batches WHERE account_id=NEW.account_id AND id=NEW.publication_id FOR UPDATE) THEN
    RAISE EXCEPTION 'Connection message audience is already sealed'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connection_message_admission BEFORE INSERT ON connection_message_targets FOR EACH ROW EXECUTE FUNCTION hail_admit_connection_message_target();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['connection_message_batches','connection_message_targets'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write(''account'',''account_id'')',t||'_fence',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION hail_preserve_connection_message_intent()',t||'_preserve',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_public_plc_authority()',t||'_truncate',t);
  END LOOP;
END $$;
CREATE FUNCTION hail_finish_connection_messages_before_cutover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM provider_accounts WHERE id=NEW.account_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM connection_message_targets WHERE account_id=NEW.account_id AND state='pending') THEN
    RAISE EXCEPTION 'Finish or cancel pending connection messages before account cutover' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connection_messages_before_fence BEFORE INSERT ON provider_migration_fences FOR EACH ROW EXECUTE FUNCTION hail_finish_connection_messages_before_cutover();
CREATE TRIGGER connection_messages_before_generation BEFORE UPDATE OF generation ON account_serving_generations
  FOR EACH ROW WHEN(NEW.generation IS DISTINCT FROM OLD.generation) EXECUTE FUNCTION hail_finish_connection_messages_before_cutover();
