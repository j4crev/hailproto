BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM schema_migrations WHERE version>64) OR EXISTS(SELECT 1 FROM federated_connection_pairs) OR
    EXISTS(SELECT 1 FROM federated_connection_signatures) OR EXISTS(SELECT 1 FROM connection_approvals WHERE federated_pair_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Retained federated connection history prevents rollback; retain tables for code rollback';
  END IF;
END $$;
DROP TRIGGER federated_connection_fence ON provider_migration_fences;
DROP TRIGGER federated_connection_generation ON account_serving_generations;
DROP TRIGGER federated_connection_custody ON custody_transition_preparations;
DROP FUNCTION hail_federated_connection_cutover();
ALTER TABLE connection_approvals DROP COLUMN federated_pair_id,DROP COLUMN remote_bundle,DROP COLUMN remote_token_ciphertext,DROP COLUMN remote_token_nonce;
DROP TABLE federated_connection_outbox,federated_connection_disconnects,federated_connection_tombstones,federated_connection_results,
  federated_connection_events,federated_connection_attempts,federated_connection_signatures,federated_connection_pairs;
DROP FUNCTION hail_preserve_federated_connection();
DELETE FROM schema_migrations WHERE version=64;
COMMIT;
