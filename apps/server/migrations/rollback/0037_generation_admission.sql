-- Return to migration 36 only before any generation advancement/detachment.
BEGIN;
LOCK TABLE provider_accounts,account_serving_generations,account_api_credentials,account_access_challenges,
  grant_publications,delivery_work,terminal_status_publications,provider_retired_transfer_history,provider_retired_import_history,
  pending_migration_imports,received_transfer_invitations,transfer_address_reservations,prepared_migration_target_keys IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=37 AND name='generation-admission') OR
    NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=38 AND name='retired-import-history') OR
    EXISTS(SELECT 1 FROM schema_migrations WHERE version>38) OR
    EXISTS(SELECT 1 FROM account_serving_generations WHERE generation<>1) OR
    EXISTS(SELECT 1 FROM provider_retired_transfer_history WHERE serving_generation<>1) OR
    EXISTS(SELECT 1 FROM provider_retired_import_history WHERE serving_generation<>1) THEN
    RAISE EXCEPTION 'Generation advancement or later migrations prevent rollback' USING ERRCODE='55000';
  END IF;
  IF EXISTS(
    SELECT 1 FROM provider_retired_import_history h
    LEFT JOIN pending_migration_imports i USING(transfer_id)
    LEFT JOIN received_transfer_invitations invitation USING(transfer_id)
    LEFT JOIN transfer_address_reservations reservation USING(transfer_id)
    LEFT JOIN prepared_migration_target_keys prepared USING(transfer_id)
    WHERE h.import_record IS DISTINCT FROM to_jsonb(i) OR h.invitation_record IS DISTINCT FROM to_jsonb(invitation) OR
      h.reservation_record IS DISTINCT FROM to_jsonb(reservation) OR h.prepared_public_record IS DISTINCT FROM
        (to_jsonb(prepared)-'rotation_private_ciphertext'-'rotation_nonce'-'messaging_private_ciphertext'-'messaging_nonce')
  ) THEN RAISE EXCEPTION 'Retired import history is not redundant; rollback refused' USING ERRCODE='55000'; END IF;
END;
$$;
DROP TRIGGER hail_retired_import_history ON provider_migration_fences;
DROP FUNCTION hail_archive_retired_imports();
DROP TABLE provider_retired_import_history;
DROP TRIGGER hail_worker_lease ON grant_publications;
DROP TRIGGER hail_worker_lease ON delivery_work;
DROP TRIGGER hail_worker_lease ON terminal_status_publications;
DROP FUNCTION hail_bind_worker_lease();
DROP TABLE serving_worker_leases;
DROP TRIGGER hail_credential_generation ON account_api_credentials;
DROP TRIGGER hail_challenge_generation ON account_access_challenges;
DROP FUNCTION hail_bind_credential_generation();
DROP FUNCTION hail_bind_challenge_generation();
DROP TABLE account_credential_generations;
DROP TABLE account_challenge_generations;
DROP TRIGGER hail_generation_advance ON account_serving_generations;
DROP FUNCTION hail_guard_generation_advance();
DROP FUNCTION hail_check_generation_snapshot();
CREATE OR REPLACE FUNCTION hail_assert_unfenced_account(owner uuid) RETURNS void AS $$
DECLARE owner_did text;
BEGIN
  IF owner IS NULL THEN RETURN; END IF;
  SELECT did INTO owner_did FROM provider_accounts WHERE id=owner FOR UPDATE;
  IF owner_did IS NULL THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM provider_migration_fences WHERE did=owner_did) THEN
    RAISE EXCEPTION 'Hail DID is migration-fenced' USING ERRCODE='55000';
  END IF;
END;
$$ LANGUAGE plpgsql;
ALTER TABLE account_serving_generations DROP CONSTRAINT account_serving_generations_generation_check;
ALTER TABLE account_serving_generations ADD CHECK(generation=1);
ALTER TABLE provider_retired_transfer_history DROP CONSTRAINT provider_retired_transfer_history_serving_generation_check;
ALTER TABLE provider_retired_transfer_history ADD CHECK(serving_generation=1);
DELETE FROM schema_migrations WHERE version IN (37,38);
COMMIT;
