DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pending_migration_imports WHERE custody_profile='managed' AND state='active') OR
    EXISTS (SELECT 1 FROM provider_retired_import_history WHERE prepared_public_record->>'custody_profile'='managed') THEN
    RAISE EXCEPTION 'cannot roll back managed materialization while active imports exist';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION hail_guard_generation_advance() RETURNS trigger AS $$
BEGIN
  IF NEW.account_id<>OLD.account_id OR NEW.generation<>OLD.generation THEN
    IF NEW.account_id<>OLD.account_id OR NEW.generation<>OLD.generation+1 OR
      (current_setting('hail.returning_account',true) IS DISTINCT FROM OLD.account_id::text AND
       current_setting('hail.custody_transition',true) IS DISTINCT FROM OLD.account_id::text) THEN
      RAISE EXCEPTION 'Serving generation needs a reviewed ownership transition' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hail_archive_retired_imports() RETURNS trigger AS $$
BEGIN
  IF NEW.state='retired' THEN
    INSERT INTO provider_retired_import_history
      (transfer_id,did,account_id,serving_generation,import_record,invitation_record,reservation_record,prepared_public_record)
      SELECT i.transfer_id,i.did,NEW.account_id,g.generation,to_jsonb(i),to_jsonb(invitation),to_jsonb(reservation),
        to_jsonb(prepared)-'rotation_private_ciphertext'-'rotation_nonce'-'messaging_private_ciphertext'-'messaging_nonce'
      FROM pending_migration_imports i JOIN account_serving_generations g ON g.account_id=NEW.account_id
      LEFT JOIN received_transfer_invitations invitation USING(transfer_id)
      LEFT JOIN transfer_address_reservations reservation USING(transfer_id)
      LEFT JOIN prepared_migration_target_keys prepared USING(transfer_id)
      WHERE i.did=NEW.did AND i.state='active' ON CONFLICT(transfer_id) DO NOTHING;
    IF EXISTS(SELECT 1 FROM pending_migration_imports i JOIN provider_retired_import_history h USING(transfer_id)
      JOIN account_serving_generations g ON g.account_id=NEW.account_id
      LEFT JOIN received_transfer_invitations invitation USING(transfer_id)
      LEFT JOIN transfer_address_reservations reservation USING(transfer_id)
      LEFT JOIN prepared_migration_target_keys prepared USING(transfer_id)
      WHERE i.did=NEW.did AND i.state='active' AND (h.account_id<>NEW.account_id OR h.serving_generation<>g.generation OR
        h.import_record IS DISTINCT FROM to_jsonb(i) OR h.invitation_record IS DISTINCT FROM to_jsonb(invitation) OR
        h.reservation_record IS DISTINCT FROM to_jsonb(reservation) OR h.prepared_public_record IS DISTINCT FROM
          (to_jsonb(prepared)-'rotation_private_ciphertext'-'rotation_nonce'-'messaging_private_ciphertext'-'messaging_nonce')))
    THEN RAISE EXCEPTION 'Retired import conflicts with immutable history' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DELETE FROM schema_migrations WHERE version=49;
