BEGIN;
LOCK TABLE federated_connection_pairs,federated_connection_attempts,account_connections IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM schema_migrations WHERE version>70) OR
    EXISTS(SELECT 1 FROM federated_connection_pairs p JOIN provider_accounts a ON a.did=p.peer_did) OR
    EXISTS(SELECT id FROM federated_connection_attempts GROUP BY id HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Retained unified local connections prevent schema rollback';
  END IF;
END $$;
DROP TRIGGER connection_native_retired ON account_connections;
DROP TRIGGER connection_unified_history ON federated_connection_pairs;
DROP FUNCTION hail_retire_native_connection();
DROP FUNCTION hail_reject_native_pair_reuse();
ALTER TABLE federated_connection_attempts DROP CONSTRAINT federated_connection_attempts_pkey;
ALTER TABLE federated_connection_attempts ADD PRIMARY KEY(id);
CREATE OR REPLACE FUNCTION hail_connection_message_permission(owner_did text,other_did text,connection uuid,expected_epoch bigint,lock_pair boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE member uuid; owner_id uuid;
BEGIN
  IF owner_did=other_did OR expected_epoch<1 THEN RETURN false; END IF;
  SELECT a.id INTO owner_id FROM provider_accounts a JOIN account_serving_generations g ON g.account_id=a.id
    WHERE a.did=owner_did AND a.onboarding_state='active' AND a.activation_verification_mode='public';
  IF owner_id IS NULL THEN RETURN false; END IF;
  IF lock_pair THEN
    FOR member IN SELECT a.id FROM provider_accounts a WHERE a.id=owner_id OR a.id IN (
      SELECT c.account_a FROM account_connections c WHERE c.id=connection AND owner_did IN(c.did_a,c.did_b) AND other_did IN(c.did_a,c.did_b)
      UNION SELECT c.account_b FROM account_connections c WHERE c.id=connection AND owner_did IN(c.did_a,c.did_b) AND other_did IN(c.did_a,c.did_b)
    ) ORDER BY a.id LOOP PERFORM hail_assert_unfenced_account(member); END LOOP;
  END IF;
  RETURN EXISTS(SELECT 1 FROM account_connections c
    JOIN provider_accounts a ON a.id=c.account_a JOIN provider_accounts b ON b.id=c.account_b
    JOIN account_serving_generations ga ON ga.account_id=a.id JOIN account_serving_generations gb ON gb.account_id=b.id
    WHERE c.id=connection AND expected_epoch=1 AND c.state='active' AND owner_did IN(c.did_a,c.did_b) AND other_did IN(c.did_a,c.did_b)
      AND a.did=c.did_a AND b.did=c.did_b AND a.onboarding_state='active' AND b.onboarding_state='active'
      AND a.activation_verification_mode='public' AND b.activation_verification_mode='public'
      AND ga.generation=c.generation_a AND gb.generation=c.generation_b
      AND NOT EXISTS(SELECT 1 FROM provider_migration_fences f WHERE f.account_id IN(a.id,b.id)))
    OR EXISTS(SELECT 1 FROM federated_connection_pairs p JOIN account_serving_generations g ON g.account_id=p.account_id
      WHERE p.account_id=owner_id AND p.local_did=owner_did AND p.peer_did=other_did AND p.connection_id=connection AND p.epoch=expected_epoch
        AND p.state='active' AND p.serving_generation=g.generation
        AND NOT EXISTS(SELECT 1 FROM federated_connection_tombstones t WHERE t.pair_id=p.id AND t.connection_id=connection)
        AND NOT EXISTS(SELECT 1 FROM provider_migration_fences f WHERE f.account_id=p.account_id));
END $$;
DELETE FROM schema_migrations WHERE version=70;
COMMIT;
