CREATE TABLE provider_retired_import_history (
  transfer_id uuid PRIMARY KEY,
  did text NOT NULL,
  account_id uuid NOT NULL,
  serving_generation bigint NOT NULL,
  import_record jsonb NOT NULL,
  invitation_record jsonb,
  reservation_record jsonb,
  prepared_public_record jsonb,
  archived_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION hail_archive_retired_imports() RETURNS trigger AS $$
BEGIN
  IF NEW.state='retired' THEN
    INSERT INTO provider_retired_import_history
      (transfer_id,did,account_id,serving_generation,import_record,invitation_record,reservation_record,prepared_public_record)
      SELECT i.transfer_id,i.did,NEW.account_id,g.generation,to_jsonb(i),to_jsonb(invitation),to_jsonb(reservation),
        to_jsonb(prepared)-'rotation_private_ciphertext'-'rotation_nonce'-'messaging_private_ciphertext'-'messaging_nonce'
      FROM pending_migration_imports i
      JOIN account_serving_generations g ON g.account_id=NEW.account_id
      LEFT JOIN received_transfer_invitations invitation USING(transfer_id)
      LEFT JOIN transfer_address_reservations reservation USING(transfer_id)
      LEFT JOIN prepared_migration_target_keys prepared USING(transfer_id)
      WHERE i.did=NEW.did AND i.state='active'
      ON CONFLICT(transfer_id) DO NOTHING;
    IF EXISTS(
      SELECT 1 FROM pending_migration_imports i JOIN provider_retired_import_history h USING(transfer_id)
      JOIN account_serving_generations g ON g.account_id=NEW.account_id
      LEFT JOIN received_transfer_invitations invitation USING(transfer_id)
      LEFT JOIN transfer_address_reservations reservation USING(transfer_id)
      LEFT JOIN prepared_migration_target_keys prepared USING(transfer_id)
      WHERE i.did=NEW.did AND i.state='active' AND
        (h.account_id<>NEW.account_id OR h.serving_generation<>g.generation OR h.import_record IS DISTINCT FROM to_jsonb(i) OR
          h.invitation_record IS DISTINCT FROM to_jsonb(invitation) OR h.reservation_record IS DISTINCT FROM to_jsonb(reservation) OR
          h.prepared_public_record IS DISTINCT FROM
            (to_jsonb(prepared)-'rotation_private_ciphertext'-'rotation_nonce'-'messaging_private_ciphertext'-'messaging_nonce'))
    ) THEN RAISE EXCEPTION 'Retired import conflicts with immutable history' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hail_retired_import_history AFTER INSERT OR UPDATE ON provider_migration_fences
  FOR EACH ROW EXECUTE FUNCTION hail_archive_retired_imports();
UPDATE provider_migration_fences SET state=state WHERE state='retired';
CREATE TRIGGER hail_retired_import_immutable BEFORE UPDATE OR DELETE ON provider_retired_import_history
  FOR EACH ROW EXECUTE FUNCTION hail_immutable_retirement_history();
CREATE TRIGGER hail_retired_import_no_truncate BEFORE TRUNCATE ON provider_retired_import_history
  FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_retirement_history();
