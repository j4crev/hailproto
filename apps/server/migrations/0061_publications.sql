-- Provider-local publication intent. Protocol messages still use ordinary signed envelopes.
CREATE TABLE account_publications (
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  sender_did text NOT NULL,
  serving_generation bigint NOT NULL CHECK (serving_generation > 0),
  category text NOT NULL CHECK (category ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  body_bytes bytea NOT NULL CHECK (octet_length(body_bytes) BETWEEN 1 AND 262144),
  request_digest bytea NOT NULL CHECK (octet_length(request_digest)=32),
  reply_until bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
  cancelled_at timestamptz,
  sealed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (account_id,id)
);
CREATE TABLE publication_targets (
  account_id uuid NOT NULL,
  publication_id uuid NOT NULL,
  grant_id uuid NOT NULL REFERENCES grant_lineages(grant_id) ON DELETE RESTRICT,
  recipient_did text NOT NULL,
  message_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','submitted','blocked','cancelled','expired','indeterminate')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id,publication_id,recipient_did),
  UNIQUE (account_id,message_id),
  FOREIGN KEY (account_id,publication_id) REFERENCES account_publications(account_id,id) ON DELETE RESTRICT
);
CREATE INDEX publication_targets_pending ON publication_targets(next_attempt_at) WHERE state='pending';

CREATE TRIGGER hail_fence_publications BEFORE INSERT OR UPDATE OR DELETE ON account_publications
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account','account_id');
CREATE TRIGGER hail_fence_publication_targets BEFORE INSERT OR UPDATE OR DELETE ON publication_targets
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account','account_id');

CREATE FUNCTION hail_preserve_publication_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Retained publication intent cannot be deleted'; END IF;
  IF TG_TABLE_NAME='account_publications' THEN
    IF (to_jsonb(NEW)-'cancelled_at'-'sealed') IS DISTINCT FROM (to_jsonb(OLD)-'cancelled_at'-'sealed')
      OR OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
      OR OLD.sealed AND NOT NEW.sealed THEN
      RAISE EXCEPTION 'Publication intent cannot be replaced';
    END IF;
  ELSE
    IF ROW(NEW.account_id,NEW.publication_id,NEW.grant_id,NEW.recipient_did,NEW.message_id)
      IS DISTINCT FROM ROW(OLD.account_id,OLD.publication_id,OLD.grant_id,OLD.recipient_did,OLD.message_id)
      OR OLD.state<>'pending' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Publication audience and terminal outcomes cannot be replaced';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publication_intent_immutable BEFORE UPDATE OR DELETE ON account_publications
  FOR EACH ROW EXECUTE FUNCTION hail_preserve_publication_intent();
CREATE TRIGGER publication_target_immutable BEFORE UPDATE OR DELETE ON publication_targets
  FOR EACH ROW EXECUTE FUNCTION hail_preserve_publication_intent();

CREATE FUNCTION hail_admit_publication_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT sealed FROM account_publications WHERE account_id=NEW.account_id AND id=NEW.publication_id FOR UPDATE) THEN
    RAISE EXCEPTION 'Publication audience is already sealed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publication_target_admission BEFORE INSERT ON publication_targets
  FOR EACH ROW EXECUTE FUNCTION hail_admit_publication_target();

-- A transfer exports existing envelopes, not unmaterialized publication jobs.
-- Serialize with publication admission at the shared account-row lock.
CREATE FUNCTION hail_finish_publications_before_cutover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM provider_accounts WHERE id=NEW.account_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM publication_targets WHERE account_id=NEW.account_id AND state='pending') THEN
    RAISE EXCEPTION 'Finish or cancel pending publications before account cutover' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hail_publications_before_fence BEFORE INSERT ON provider_migration_fences
  FOR EACH ROW EXECUTE FUNCTION hail_finish_publications_before_cutover();
CREATE TRIGGER hail_publications_before_generation BEFORE UPDATE OF generation ON account_serving_generations
  FOR EACH ROW WHEN (NEW.generation IS DISTINCT FROM OLD.generation)
  EXECUTE FUNCTION hail_finish_publications_before_cutover();
