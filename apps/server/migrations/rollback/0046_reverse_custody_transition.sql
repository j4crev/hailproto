DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM custody_transition_preparations WHERE direction='managed-to-owner') THEN
    RAISE EXCEPTION 'Migration 46 rollback refused: reverse custody transition evidence exists';
  END IF;
END $$;

ALTER TABLE custody_transition_preparations
  DROP CONSTRAINT custody_transition_preparations_identity_material_check,
  DROP CONSTRAINT custody_transition_preparations_direction_check,
  ALTER COLUMN encrypted_identity_private_key SET NOT NULL,
  ALTER COLUMN identity_encryption_nonce SET NOT NULL,
  ALTER COLUMN identity_encryption_version SET NOT NULL,
  ALTER COLUMN identity_kek_id SET NOT NULL,
  ADD CONSTRAINT custody_transition_preparations_direction_check
    CHECK (direction='owner-to-managed');
DELETE FROM schema_migrations WHERE version=46;
