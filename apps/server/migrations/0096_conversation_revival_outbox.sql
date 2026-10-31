CREATE TABLE conversation_revival_batches (
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  creator_did text NOT NULL,
  conversation_id uuid NOT NULL,
  serving_generation bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,id)
);
CREATE TABLE conversation_revival_targets (
  account_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  recipient_did text NOT NULL,
  request_id uuid NOT NULL,
  request_cose bytea NOT NULL,
  connection_id uuid,
  connection_epoch bigint,
  outcome text NOT NULL CHECK(outcome IN ('pending','renewed','active','left','denied','expired')),
  expires_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY(account_id,batch_id,recipient_did),
  UNIQUE(account_id,request_id),
  FOREIGN KEY(account_id,batch_id) REFERENCES conversation_revival_batches(account_id,id) ON DELETE RESTRICT
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['conversation_revival_batches','conversation_revival_targets'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write(''account'',''account_id'')',t||'_fence',t);
  END LOOP;
END $$;

CREATE FUNCTION hail_conversation_revival_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['outcome','attempts','next_attempt_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['outcome','attempts','next_attempt_at']) OR (OLD.outcome<>'pending' AND NEW.outcome<>OLD.outcome) THEN
    RAISE EXCEPTION 'Revival intent and terminal outcome are immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER conversation_revival_target_immutable BEFORE UPDATE OR DELETE ON conversation_revival_targets
  FOR EACH ROW EXECUTE FUNCTION hail_conversation_revival_immutable();
CREATE TRIGGER conversation_revival_batch_immutable BEFORE UPDATE OR DELETE ON conversation_revival_batches
  FOR EACH ROW EXECUTE FUNCTION hail_immutable_public_plc_authority();
CREATE FUNCTION hail_conversation_cutover_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM provider_accounts WHERE id=NEW.account_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM conversation_revival_targets WHERE account_id=NEW.account_id AND outcome='pending') THEN
    RAISE EXCEPTION 'Finish pending conversation revival before cutover' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER conversation_revival_before_fence BEFORE INSERT ON provider_migration_fences
  FOR EACH ROW EXECUTE FUNCTION hail_conversation_cutover_guard();
CREATE TRIGGER conversation_revival_before_generation BEFORE UPDATE OF generation ON account_serving_generations
  FOR EACH ROW WHEN (NEW.generation IS DISTINCT FROM OLD.generation) EXECUTE FUNCTION hail_conversation_cutover_guard();
