-- The same consent request has an outbound and admitted copy when both accounts
-- are hosted here. Request identity is account-scoped, not provider-scoped.
ALTER TABLE federated_connection_attempts DROP CONSTRAINT federated_connection_attempts_pkey;
ALTER TABLE federated_connection_attempts ADD PRIMARY KEY(account_id,id);

-- Keep obsolete signed history intact, but fail old writers closed. No native
-- row is converted, deleted or treated as consent for the unified model.
CREATE FUNCTION hail_retire_native_connection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Obsolete local connection records require explicitly scoped pre-launch cleanup' USING ERRCODE='55000';
END $$;
CREATE TRIGGER connection_native_retired BEFORE INSERT OR UPDATE ON account_connections
  FOR EACH ROW EXECUTE FUNCTION hail_retire_native_connection();
CREATE FUNCTION hail_reject_native_pair_reuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM account_connections WHERE (did_a=NEW.local_did AND did_b=NEW.peer_did) OR (did_b=NEW.local_did AND did_a=NEW.peer_did)) THEN
    RAISE EXCEPTION 'Obsolete local connection history blocks this pair until explicitly scoped cleanup' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connection_unified_history BEFORE INSERT OR UPDATE ON federated_connection_pairs
  FOR EACH ROW EXECUTE FUNCTION hail_reject_native_pair_reuse();

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
      PERFORM hail_assert_unfenced_account(member);
    END LOOP;
  END IF;
  RETURN EXISTS(SELECT 1 FROM federated_connection_pairs p JOIN account_serving_generations g ON g.account_id=p.account_id
    WHERE p.account_id=owner_id AND p.local_did=owner_did AND p.peer_did=other_did AND p.connection_id=connection AND p.epoch=expected_epoch
      AND p.state='active' AND p.serving_generation=g.generation
      AND NOT EXISTS(SELECT 1 FROM federated_connection_tombstones t WHERE t.pair_id=p.id AND t.connection_id=connection)
      AND NOT EXISTS(SELECT 1 FROM provider_migration_fences f WHERE f.account_id=p.account_id))
    AND NOT EXISTS(SELECT 1 FROM account_connections WHERE (did_a=owner_did AND did_b=other_did) OR (did_b=owner_did AND did_a=other_did))
    -- A local peer's immediate disconnect/fence wins before worker replication.
    -- Retired local accounts no longer represent the peer at this provider.
    AND (peer_id IS NULL OR EXISTS(SELECT 1 FROM provider_migration_fences WHERE account_id=peer_id AND state='retired') OR
      EXISTS(SELECT 1 FROM federated_connection_pairs p JOIN account_serving_generations g ON g.account_id=p.account_id
        JOIN provider_accounts a ON a.id=p.account_id
        WHERE p.account_id=peer_id AND p.peer_did=owner_did AND p.local_did=other_did AND p.connection_id=connection AND p.epoch=expected_epoch
          AND a.onboarding_state='active' AND a.activation_verification_mode='public' AND p.state='active' AND p.serving_generation=g.generation
          AND NOT EXISTS(SELECT 1 FROM federated_connection_tombstones t WHERE t.pair_id=p.id AND t.connection_id=connection)
          AND NOT EXISTS(SELECT 1 FROM provider_migration_fences f WHERE f.account_id=peer_id)));
END $$;
