CREATE TABLE provider_transfer_abandonments (
  transfer_id uuid PRIMARY KEY,
  did text NOT NULL CHECK (did ~ '^did:plc:[a-z2-7]{24}$'),
  side text NOT NULL CHECK (side IN ('source','target')),
  state text NOT NULL CHECK (state IN ('target-invalidated','target-released','source-resumed')),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((side='source')=(state='source-resumed'))
);
CREATE TABLE provider_retired_observation_history (
  transfer_id uuid PRIMARY KEY,
  record jsonb NOT NULL
);
INSERT INTO provider_retired_observation_history SELECT h.transfer_id,to_jsonb(o)
  FROM provider_retired_import_history h JOIN portable_cutover_observations o USING(transfer_id);
CREATE FUNCTION hail_retain_retired_observation() RETURNS trigger AS $$
BEGIN
  IF NEW.state='retired' THEN
    INSERT INTO provider_retired_observation_history SELECT i.transfer_id,to_jsonb(o)
      FROM pending_migration_imports i JOIN portable_cutover_observations o USING(transfer_id)
      WHERE i.did=NEW.did AND i.state='active' ON CONFLICT(transfer_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hail_retired_observation AFTER INSERT OR UPDATE ON provider_migration_fences
  FOR EACH ROW EXECUTE FUNCTION hail_retain_retired_observation();
CREATE TRIGGER hail_retired_observation_immutable BEFORE UPDATE OR DELETE ON provider_retired_observation_history
  FOR EACH ROW EXECUTE FUNCTION hail_immutable_retirement_history();
CREATE TRIGGER hail_retired_observation_no_truncate BEFORE TRUNCATE ON provider_retired_observation_history
  FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_retirement_history();
CREATE FUNCTION hail_retain_abandonment() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.state IN ('target-released','source-resumed') OR
    NEW.transfer_id<>OLD.transfer_id OR NEW.did<>OLD.did OR NEW.side<>OLD.side OR
    NEW.state<>'target-released' OR OLD.state<>'target-invalidated' OR
    NEW.evidence->'intent' IS DISTINCT FROM OLD.evidence->'intent' OR
    NEW.evidence->'invalidation' IS DISTINCT FROM OLD.evidence->'invalidation' THEN
    RAISE EXCEPTION 'Abandonment evidence is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hail_abandonment_history BEFORE UPDATE OR DELETE ON provider_transfer_abandonments
  FOR EACH ROW EXECUTE FUNCTION hail_retain_abandonment();
CREATE TRIGGER hail_abandonment_no_truncate BEFORE TRUNCATE ON provider_transfer_abandonments
  FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_retirement_history();
CREATE FUNCTION hail_reject_abandoned_nonce() RETURNS trigger AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM provider_transfer_abandonments WHERE did=NEW.did AND side='source'
    AND evidence->'authorization'->>'nonce'=NEW.nonce::text) THEN
    RAISE EXCEPTION 'An abandoned transfer nonce cannot be reused' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hail_abandoned_nonce BEFORE INSERT OR UPDATE ON provider_transfer_authorizations
  FOR EACH ROW EXECUTE FUNCTION hail_reject_abandoned_nonce();
