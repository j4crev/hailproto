-- Expand the portable transfer journal for the narrow native managed A -> B
-- profile. Existing rows remain portable; no managed traffic is enabled merely
-- by applying this migration.
ALTER TABLE prepared_migration_target_keys
  ADD COLUMN custody_profile text NOT NULL DEFAULT 'portable'
    CHECK (custody_profile IN ('portable','managed')),
  ADD COLUMN identity_public_key text,
  ADD COLUMN identity_private_ciphertext bytea,
  ADD COLUMN identity_nonce bytea,
  ADD CONSTRAINT prepared_migration_identity_shape CHECK (
    (custody_profile='portable' AND identity_public_key IS NULL AND identity_private_ciphertext IS NULL AND identity_nonce IS NULL) OR
    (custody_profile='managed' AND identity_public_key IS NOT NULL AND identity_private_ciphertext IS NOT NULL AND
      octet_length(identity_private_ciphertext)>=17 AND octet_length(identity_nonce)=12 AND
      identity_public_key<>rotation_public_key AND identity_public_key<>messaging_public_key)
  );

ALTER TABLE provider_transfer_authorizations
  ADD COLUMN custody_profile text NOT NULL DEFAULT 'portable'
    CHECK (custody_profile IN ('portable','managed')),
  ADD COLUMN owner_recovery_public_key text,
  ADD CONSTRAINT provider_transfer_authority_custody_shape CHECK (
    (custody_profile='portable' AND owner_recovery_public_key IS NULL) OR
    (custody_profile='managed' AND owner_recovery_public_key IS NOT NULL)
  );

ALTER TABLE provider_migration_fences
  ADD COLUMN source_custody_profile text NOT NULL DEFAULT 'portable'
    CHECK (source_custody_profile IN ('portable','managed')),
  ADD COLUMN owner_recovery_public_key text,
  ADD COLUMN source_identity_public_key text,
  ADD COLUMN destination_identity_public_key text,
  ADD CONSTRAINT provider_migration_fence_custody_shape CHECK (
    (source_custody_profile='portable' AND owner_recovery_public_key IS NULL AND destination_identity_public_key IS NULL) OR
    (source_custody_profile='managed' AND owner_recovery_public_key IS NOT NULL AND source_identity_public_key IS NOT NULL AND
      destination_identity_public_key IS NOT NULL AND source_identity_public_key<>destination_identity_public_key)
  );

ALTER TABLE provider_migration_exports
  ADD COLUMN custody_profile text NOT NULL DEFAULT 'portable'
    CHECK (custody_profile IN ('portable','managed'));

ALTER TABLE pending_migration_imports
  ADD COLUMN custody_profile text NOT NULL DEFAULT 'portable'
    CHECK (custody_profile IN ('portable','managed')),
  ADD COLUMN owner_recovery_public_key text,
  ADD COLUMN source_identity_public_key text,
  ADD COLUMN destination_identity_public_key text,
  ADD CONSTRAINT pending_migration_import_custody_shape CHECK (
    (custody_profile='portable' AND owner_recovery_public_key IS NULL AND destination_identity_public_key IS NULL) OR
    (custody_profile='managed' AND owner_recovery_public_key IS NOT NULL AND source_identity_public_key IS NOT NULL AND
      destination_identity_public_key IS NOT NULL AND source_identity_public_key<>destination_identity_public_key)
  );
