-- Retain retired accounts/history for return moves without treating those rows
-- as currently serving peers. Still lock their rows so a concurrent return cannot
-- become local between the permission check and final message storage.
CREATE OR REPLACE FUNCTION hail_connection_message_permission(owner_did text,other_did text,connection uuid,expected_epoch bigint,lock_pair boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE member uuid; owner_id uuid; peer_id uuid;
BEGIN
  IF owner_did=other_did OR expected_epoch<1 THEN RETURN false; END IF;
  SELECT id INTO owner_id FROM provider_accounts WHERE did=owner_did AND onboarding_state='active' AND activation_verification_mode='public';
  IF owner_id IS NULL THEN RETURN false; END IF;
  SELECT id INTO peer_id FROM provider_accounts WHERE did=other_did;
  IF lock_pair THEN
    FOR member IN SELECT id FROM provider_accounts WHERE id IN(owner_id,peer_id) ORDER BY id LOOP
      IF member=owner_id THEN
        PERFORM hail_assert_unfenced_account(member);
      ELSE
        PERFORM 1 FROM provider_accounts WHERE id=member FOR UPDATE;
        IF NOT EXISTS(SELECT 1 FROM provider_migration_fences WHERE account_id=member AND state='retired') THEN
          PERFORM hail_assert_unfenced_account(member);
        END IF;
      END IF;
    END LOOP;
  END IF;
  RETURN EXISTS(SELECT 1 FROM federated_connection_pairs p JOIN account_serving_generations g ON g.account_id=p.account_id
    WHERE p.account_id=owner_id AND p.local_did=owner_did AND p.peer_did=other_did AND p.connection_id=connection AND p.epoch=expected_epoch
      AND p.state='active' AND p.serving_generation=g.generation
      AND NOT EXISTS(SELECT 1 FROM federated_connection_tombstones t WHERE t.pair_id=p.id AND t.connection_id=connection)
      AND NOT EXISTS(SELECT 1 FROM provider_migration_fences f WHERE f.account_id=p.account_id))
    AND NOT EXISTS(SELECT 1 FROM account_connections WHERE (did_a=owner_did AND did_b=other_did) OR (did_b=owner_did AND did_a=other_did))
    AND (peer_id IS NULL OR EXISTS(SELECT 1 FROM provider_migration_fences WHERE account_id=peer_id AND state='retired') OR
      EXISTS(SELECT 1 FROM federated_connection_pairs p JOIN account_serving_generations g ON g.account_id=p.account_id
        JOIN provider_accounts a ON a.id=p.account_id
        WHERE p.account_id=peer_id AND p.peer_did=owner_did AND p.local_did=other_did AND p.connection_id=connection AND p.epoch=expected_epoch
          AND a.onboarding_state='active' AND a.activation_verification_mode='public' AND p.state='active' AND p.serving_generation=g.generation
          AND NOT EXISTS(SELECT 1 FROM federated_connection_tombstones t WHERE t.pair_id=p.id AND t.connection_id=connection)
          AND NOT EXISTS(SELECT 1 FROM provider_migration_fences f WHERE f.account_id=peer_id)));
END $$;
