-- Expand only: generation 1 remains the sole executable generation. Keeping
-- metadata outside provider_accounts preserves v2 snapshot/import row shapes.
CREATE TABLE account_serving_generations (
  account_id uuid PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE CASCADE,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation = 1)
);
INSERT INTO account_serving_generations (account_id) SELECT id FROM provider_accounts;

CREATE FUNCTION hail_initialize_serving_generation() RETURNS trigger AS $$
BEGIN
  INSERT INTO account_serving_generations (account_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hail_serving_generation AFTER INSERT ON provider_accounts
  FOR EACH ROW EXECUTE FUNCTION hail_initialize_serving_generation();

CREATE TABLE provider_retired_transfer_history (
  transfer_id uuid PRIMARY KEY,
  -- Historical identifiers deliberately do not reference mutable working rows.
  account_id uuid NOT NULL,
  did text NOT NULL CHECK (did ~ '^did:plc:[a-z2-7]{24}$'),
  serving_generation bigint NOT NULL CHECK (serving_generation = 1),
  fence_record jsonb NOT NULL CHECK (jsonb_typeof(fence_record) = 'object'),
  export_record jsonb NOT NULL CHECK (jsonb_typeof(export_record) = 'object'),
  authorization_record jsonb CHECK (authorization_record IS NULL OR jsonb_typeof(authorization_record) = 'object'),
  archived_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (fence_record ->> 'state' = 'retired'),
  CHECK (fence_record ?& ARRAY['state','transfer_id','did','account_id','snapshot_digest','retirement_receipt_bytes']),
  CHECK (export_record ?& ARRAY['transfer_id','did','manifest_bytes','manifest_digest','signature','source_messaging_public_key']),
  CHECK (fence_record ->> 'transfer_id' = transfer_id::text AND export_record ->> 'transfer_id' = transfer_id::text),
  CHECK (fence_record ->> 'did' = did AND export_record ->> 'did' = did),
  CHECK (fence_record ->> 'account_id' = account_id::text)
);
CREATE INDEX provider_retired_transfer_history_did_idx ON provider_retired_transfer_history (did, archived_at);

-- to_jsonb preserves bytea as reversible PostgreSQL hex strings. It does not
-- decode/re-encode the signed manifest, signatures or retirement receipt.
-- ponytail: hex archives use ~2x bytea space; split raw bytea fields if snapshot volume matters.
CREATE FUNCTION hail_archive_retired_transfer(fence provider_migration_fences) RETURNS void AS $$
DECLARE
  exported jsonb;
  authorization_data jsonb;
  serving bigint;
  prior provider_retired_transfer_history;
BEGIN
  IF fence.state <> 'retired' THEN
    RAISE EXCEPTION 'Only a retired transfer can be archived' USING ERRCODE = '55000';
  END IF;
  SELECT to_jsonb(e) INTO exported FROM provider_migration_exports e
    WHERE e.transfer_id = fence.transfer_id AND e.did = fence.did AND e.manifest_digest = fence.snapshot_digest;
  IF exported IS NULL THEN
    RAISE EXCEPTION 'Retired transfer has no matching retained export' USING ERRCODE = '55000';
  END IF;
  SELECT to_jsonb(a) INTO authorization_data FROM provider_transfer_authorizations a
    WHERE a.did = fence.did AND a.consumed_transfer_id = fence.transfer_id;
  SELECT generation INTO serving FROM account_serving_generations WHERE account_id = fence.account_id;
  INSERT INTO provider_retired_transfer_history
    (transfer_id, account_id, did, serving_generation, fence_record, export_record, authorization_record)
    VALUES (fence.transfer_id, fence.account_id, fence.did, serving, to_jsonb(fence), exported, authorization_data)
    ON CONFLICT (transfer_id) DO NOTHING;
  SELECT * INTO prior FROM provider_retired_transfer_history WHERE transfer_id = fence.transfer_id;
  IF prior.account_id IS DISTINCT FROM fence.account_id OR prior.did IS DISTINCT FROM fence.did OR
    prior.serving_generation IS DISTINCT FROM serving OR prior.fence_record IS DISTINCT FROM to_jsonb(fence) OR
    prior.export_record IS DISTINCT FROM exported OR prior.authorization_record IS DISTINCT FROM authorization_data THEN
    RAISE EXCEPTION 'Retired transfer conflicts with immutable history' USING ERRCODE = '55000';
  END IF;
END;
$$ LANGUAGE plpgsql;

SELECT hail_archive_retired_transfer(f) FROM provider_migration_fences f WHERE f.state = 'retired';

CREATE FUNCTION hail_retain_retirement_history() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.state = 'retired' AND NEW.state <> 'retired' THEN
    RAISE EXCEPTION 'Retired generation cannot resume without a reviewed lifecycle transition' USING ERRCODE = '55000';
  END IF;
  IF NEW.state = 'retired' THEN PERFORM hail_archive_retired_transfer(NEW); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hail_retirement_history AFTER INSERT OR UPDATE ON provider_migration_fences
  FOR EACH ROW EXECUTE FUNCTION hail_retain_retirement_history();

CREATE FUNCTION hail_immutable_retirement_history() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Retired transfer history is immutable' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hail_retirement_history_immutable BEFORE UPDATE OR DELETE ON provider_retired_transfer_history
  FOR EACH ROW EXECUTE FUNCTION hail_immutable_retirement_history();
CREATE TRIGGER hail_retirement_history_no_truncate BEFORE TRUNCATE ON provider_retired_transfer_history
  FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_retirement_history();
