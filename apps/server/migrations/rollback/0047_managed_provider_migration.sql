DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM prepared_migration_target_keys WHERE custody_profile='managed') OR
     EXISTS (SELECT 1 FROM provider_transfer_authorizations WHERE custody_profile='managed') OR
     EXISTS (SELECT 1 FROM provider_migration_fences WHERE source_custody_profile='managed') OR
     EXISTS (SELECT 1 FROM provider_migration_exports WHERE custody_profile='managed') OR
     EXISTS (SELECT 1 FROM pending_migration_imports WHERE custody_profile='managed') THEN
    RAISE EXCEPTION 'Migration 47 rollback refused: managed provider migration evidence exists';
  END IF;
END $$;

ALTER TABLE pending_migration_imports
  DROP CONSTRAINT pending_migration_import_custody_shape,
  DROP COLUMN destination_identity_public_key,
  DROP COLUMN source_identity_public_key,
  DROP COLUMN owner_recovery_public_key,
  DROP COLUMN custody_profile;
ALTER TABLE provider_migration_exports DROP COLUMN custody_profile;
ALTER TABLE provider_migration_fences
  DROP CONSTRAINT provider_migration_fence_custody_shape,
  DROP COLUMN destination_identity_public_key,
  DROP COLUMN source_identity_public_key,
  DROP COLUMN owner_recovery_public_key,
  DROP COLUMN source_custody_profile;
ALTER TABLE provider_transfer_authorizations
  DROP CONSTRAINT provider_transfer_authority_custody_shape,
  DROP COLUMN owner_recovery_public_key,
  DROP COLUMN custody_profile;
ALTER TABLE prepared_migration_target_keys
  DROP CONSTRAINT prepared_migration_identity_shape,
  DROP COLUMN identity_nonce,
  DROP COLUMN identity_private_ciphertext,
  DROP COLUMN identity_public_key,
  DROP COLUMN custody_profile;

DELETE FROM schema_migrations WHERE version=47;
