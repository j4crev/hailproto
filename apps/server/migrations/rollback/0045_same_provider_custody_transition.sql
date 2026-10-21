DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM custody_transition_preparations) THEN
    RAISE EXCEPTION 'Migration 45 rollback refused: custody transition evidence exists';
  END IF;
END;
$$;
DROP TRIGGER hail_managed_custody_consistency ON managed_custody_evidence;
DROP FUNCTION hail_require_managed_custody_consistency();
DROP TRIGGER hail_custody_transition_grants_no_truncate ON custody_transition_grant_successors;
DROP TRIGGER hail_custody_transition_no_truncate ON custody_transition_preparations;
DROP TRIGGER hail_custody_transition_grants_immutable ON custody_transition_grant_successors;
DROP TRIGGER hail_custody_transition_evidence_immutable ON custody_transition_preparations;
DROP FUNCTION hail_guard_custody_transition_evidence();
DROP TABLE custody_transition_grant_successors;
DROP TABLE custody_transition_preparations;

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
CREATE OR REPLACE FUNCTION hail_guard_generation_advance() RETURNS trigger AS $$
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
CREATE OR REPLACE FUNCTION hail_require_portable_key_separation() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'portable_custody_evidence' THEN
    IF EXISTS (SELECT 1 FROM account_keys WHERE account_id = NEW.account_id AND role = 'hail-identity') THEN
      RAISE EXCEPTION 'Portable custody forbids provider identity private-key storage';
    END IF;
  ELSIF NEW.role = 'hail-identity' AND EXISTS (
    SELECT 1 FROM portable_custody_evidence WHERE account_id = NEW.account_id
  ) THEN RAISE EXCEPTION 'Portable custody forbids provider identity private-key storage'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DELETE FROM schema_migrations WHERE version=45;
