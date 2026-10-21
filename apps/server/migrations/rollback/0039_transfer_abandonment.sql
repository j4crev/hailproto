BEGIN;
LOCK TABLE provider_transfer_abandonments,provider_transfer_authorizations,provider_retired_observation_history,portable_cutover_observations IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=39 AND name='transfer-abandonment') OR
    EXISTS(SELECT 1 FROM schema_migrations WHERE version>39) OR EXISTS(SELECT 1 FROM provider_transfer_abandonments) THEN
    RAISE EXCEPTION 'Accepted abandonment or later state prevents rollback' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM provider_retired_observation_history h LEFT JOIN portable_cutover_observations o USING(transfer_id)
    WHERE h.record IS DISTINCT FROM to_jsonb(o)) THEN
    RAISE EXCEPTION 'Retired observation history is not redundant; rollback refused' USING ERRCODE='55000';
  END IF;
END;
$$;
DROP TRIGGER hail_abandoned_nonce ON provider_transfer_authorizations;
DROP FUNCTION hail_reject_abandoned_nonce();
DROP TRIGGER hail_retired_observation ON provider_migration_fences;
DROP FUNCTION hail_retain_retired_observation();
DROP TABLE provider_retired_observation_history;
DROP TABLE provider_transfer_abandonments;
DROP FUNCTION hail_retain_abandonment();
DELETE FROM schema_migrations WHERE version=39;
COMMIT;
