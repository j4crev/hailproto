LOCK TABLE account_api_credentials,account_access_challenges,grant_publications,delivery_work,terminal_status_publications IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE account_serving_generations DROP CONSTRAINT account_serving_generations_generation_check;
ALTER TABLE account_serving_generations ADD CHECK (generation BETWEEN 1 AND 2147483647);
ALTER TABLE provider_retired_transfer_history DROP CONSTRAINT provider_retired_transfer_history_serving_generation_check;
ALTER TABLE provider_retired_transfer_history ADD CHECK (serving_generation BETWEEN 1 AND 2147483647);

CREATE TABLE account_credential_generations (
  credential_id uuid PRIMARY KEY REFERENCES account_api_credentials(id) ON DELETE CASCADE,
  generation bigint NOT NULL CHECK (generation > 0)
);
INSERT INTO account_credential_generations SELECT c.id,g.generation FROM account_api_credentials c
  JOIN account_serving_generations g ON g.account_id=c.account_id;
CREATE TABLE account_challenge_generations (
  challenge_id uuid PRIMARY KEY REFERENCES account_access_challenges(id) ON DELETE CASCADE,
  generation bigint NOT NULL CHECK (generation > 0)
);
INSERT INTO account_challenge_generations SELECT c.id,COALESCE(g.generation,1) FROM account_access_challenges c
  LEFT JOIN account_serving_generations g ON g.account_id=(c.payload->>'accountId')::uuid;

CREATE FUNCTION hail_bind_credential_generation() RETURNS trigger AS $$
BEGIN
  PERFORM hail_assert_unfenced_account(NEW.account_id);
  INSERT INTO account_credential_generations SELECT NEW.id,generation FROM account_serving_generations WHERE account_id=NEW.account_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hail_credential_generation AFTER INSERT ON account_api_credentials
  FOR EACH ROW EXECUTE FUNCTION hail_bind_credential_generation();
CREATE FUNCTION hail_bind_challenge_generation() RETURNS trigger AS $$
BEGIN
  INSERT INTO account_challenge_generations (challenge_id,generation)
    SELECT NEW.id,COALESCE((SELECT generation FROM account_serving_generations WHERE account_id=(NEW.payload->>'accountId')::uuid),1);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hail_challenge_generation AFTER INSERT ON account_access_challenges
  FOR EACH ROW EXECUTE FUNCTION hail_bind_challenge_generation();
CREATE TRIGGER hail_credential_generation_immutable BEFORE UPDATE ON account_credential_generations
  FOR EACH ROW EXECUTE FUNCTION hail_immutable_retirement_history();
CREATE TRIGGER hail_challenge_generation_immutable BEFORE UPDATE ON account_challenge_generations
  FOR EACH ROW EXECUTE FUNCTION hail_immutable_retirement_history();

CREATE FUNCTION hail_check_generation_snapshot() RETURNS void AS $$
DECLARE snapshot jsonb;
BEGIN
  snapshot:=NULLIF(current_setting('hail.admitted_generations',true),'')::jsonb;
  IF snapshot IS NOT NULL AND EXISTS (
    SELECT 1 FROM jsonb_each_text(snapshot) admitted
    LEFT JOIN account_serving_generations g ON g.account_id=admitted.key::uuid
    WHERE g.generation IS DISTINCT FROM admitted.value::bigint
  ) THEN RAISE EXCEPTION 'Serving generation admission is stale' USING ERRCODE='55000'; END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hail_assert_unfenced_account(owner uuid) RETURNS void AS $$
DECLARE owner_did text; serving bigint; expected bigint; snapshot jsonb;
BEGIN
  IF owner IS NULL THEN RETURN; END IF;
  SELECT did INTO owner_did FROM provider_accounts WHERE id=owner FOR UPDATE;
  IF owner_did IS NULL THEN RETURN; END IF;
  SELECT generation INTO serving FROM account_serving_generations WHERE account_id=owner;
  snapshot:=NULLIF(current_setting('hail.admitted_generations',true),'')::jsonb;
  expected:=(snapshot->>owner::text)::bigint;
  IF (expected IS NOT NULL AND expected IS DISTINCT FROM serving) OR (serving>1 AND expected IS NULL) THEN
    RAISE EXCEPTION 'Serving generation admission is stale or missing' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM provider_migration_fences WHERE did=owner_did) THEN
    RAISE EXCEPTION 'Hail DID is migration-fenced' USING ERRCODE='55000';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Advancing generation is an ownership commit, never a credential-management operation.
CREATE FUNCTION hail_guard_generation_advance() RETURNS trigger AS $$
BEGIN
  IF NEW.account_id<>OLD.account_id OR NEW.generation<>OLD.generation THEN
    IF NEW.account_id<>OLD.account_id OR NEW.generation<>OLD.generation+1 OR
      current_setting('hail.returning_account',true) IS DISTINCT FROM OLD.account_id::text THEN
      RAISE EXCEPTION 'Serving generation needs a reviewed returning materialization' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hail_generation_advance BEFORE UPDATE ON account_serving_generations
  FOR EACH ROW EXECUTE FUNCTION hail_guard_generation_advance();

CREATE TABLE serving_worker_leases (
  lease_token uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  generation bigint NOT NULL CHECK (generation > 0)
);
CREATE TRIGGER hail_worker_generation_immutable BEFORE UPDATE ON serving_worker_leases
  FOR EACH ROW EXECUTE FUNCTION hail_immutable_retirement_history();
INSERT INTO serving_worker_leases SELECT p.lease_token,l.local_account_id,g.generation FROM grant_publications p
  JOIN grant_lineages l USING(grant_id) JOIN account_serving_generations g ON g.account_id=l.local_account_id WHERE p.lease_token IS NOT NULL;
INSERT INTO serving_worker_leases SELECT w.lease_token,r.local_account_id,g.generation FROM delivery_work w
  JOIN received_envelopes r USING(sender_did,message_id) JOIN account_serving_generations g ON g.account_id=r.local_account_id WHERE w.lease_token IS NOT NULL;
INSERT INTO serving_worker_leases SELECT p.lease_token,r.local_account_id,g.generation FROM terminal_status_publications p
  JOIN received_envelopes r USING(sender_did,message_id) JOIN account_serving_generations g ON g.account_id=r.local_account_id WHERE p.lease_token IS NOT NULL;
CREATE FUNCTION hail_bind_worker_lease() RETURNS trigger AS $$
DECLARE owner uuid; serving bigint;
BEGIN
  IF TG_TABLE_NAME='grant_publications' THEN SELECT local_account_id INTO owner FROM grant_lineages WHERE grant_id=NEW.grant_id;
  ELSE SELECT local_account_id INTO owner FROM received_envelopes WHERE sender_did=NEW.sender_did AND message_id=NEW.message_id; END IF;
  PERFORM hail_assert_unfenced_account(owner);
  SELECT generation INTO serving FROM account_serving_generations WHERE account_id=owner;
  IF TG_OP='UPDATE' AND OLD.lease_token IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM serving_worker_leases WHERE lease_token=OLD.lease_token AND account_id=owner AND generation=serving) THEN
      RAISE EXCEPTION 'Worker lease belongs to another serving generation' USING ERRCODE='55000';
    END IF;
    IF OLD.lease_token IS DISTINCT FROM NEW.lease_token THEN DELETE FROM serving_worker_leases WHERE lease_token=OLD.lease_token; END IF;
  END IF;
  IF NEW.lease_token IS NOT NULL AND (TG_OP='INSERT' OR NEW.lease_token IS DISTINCT FROM OLD.lease_token) THEN
    INSERT INTO serving_worker_leases VALUES(NEW.lease_token,owner,serving);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hail_worker_lease BEFORE INSERT OR UPDATE ON grant_publications FOR EACH ROW EXECUTE FUNCTION hail_bind_worker_lease();
CREATE TRIGGER hail_worker_lease BEFORE INSERT OR UPDATE ON delivery_work FOR EACH ROW EXECUTE FUNCTION hail_bind_worker_lease();
CREATE TRIGGER hail_worker_lease BEFORE INSERT OR UPDATE ON terminal_status_publications FOR EACH ROW EXECUTE FUNCTION hail_bind_worker_lease();
