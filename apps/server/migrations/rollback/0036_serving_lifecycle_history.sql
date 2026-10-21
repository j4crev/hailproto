-- Schema rollback is allowed only while every new archive remains redundant
-- with its unchanged legacy records and no later migration depends on it.
BEGIN;
LOCK TABLE provider_accounts, provider_migration_fences, provider_migration_exports,
  provider_transfer_authorizations, account_serving_generations, provider_retired_transfer_history IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 36 AND name = 'serving-lifecycle-history') THEN
    RAISE EXCEPTION 'Migration 36 ledger does not match the rollback' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version > 36) OR
    EXISTS (SELECT 1 FROM account_serving_generations WHERE generation <> 1) THEN
    RAISE EXCEPTION 'Later lifecycle state prevents migration 36 rollback' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM provider_retired_transfer_history h
    LEFT JOIN provider_migration_fences f ON f.transfer_id = h.transfer_id
    LEFT JOIN provider_migration_exports e ON e.transfer_id = h.transfer_id
    LEFT JOIN provider_transfer_authorizations a ON a.did = h.did AND a.consumed_transfer_id = h.transfer_id
    WHERE h.fence_record IS DISTINCT FROM to_jsonb(f) OR h.export_record IS DISTINCT FROM to_jsonb(e)
      OR h.authorization_record IS DISTINCT FROM to_jsonb(a)
  ) THEN
    RAISE EXCEPTION 'Legacy records do not preserve the archived history; rollback refused' USING ERRCODE = '55000';
  END IF;
END;
$$;
DROP TRIGGER hail_retirement_history ON provider_migration_fences;
DROP FUNCTION hail_retain_retirement_history();
DROP FUNCTION hail_archive_retired_transfer(provider_migration_fences);
DROP TABLE provider_retired_transfer_history;
DROP FUNCTION hail_immutable_retirement_history();
DROP TRIGGER hail_serving_generation ON provider_accounts;
DROP FUNCTION hail_initialize_serving_generation();
DROP TABLE account_serving_generations;
DELETE FROM schema_migrations WHERE version = 36;
COMMIT;
