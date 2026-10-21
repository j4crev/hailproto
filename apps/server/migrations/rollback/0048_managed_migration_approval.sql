DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pending_migration_imports WHERE custody_profile='managed'
    AND user_consent_payload IS NOT NULL) THEN
    RAISE EXCEPTION 'Migration 48 rollback refused: managed owner approval evidence exists';
  END IF;
END $$;

ALTER TABLE pending_migration_imports
  DROP CONSTRAINT pending_migration_consent_shape,
  ADD CONSTRAINT pending_migration_consent_shape CHECK (
    (user_consent_payload IS NULL AND user_consent_signature IS NULL AND user_identity_public_key IS NULL) OR
    (octet_length(user_consent_payload) BETWEEN 1 AND 16384 AND
     octet_length(user_consent_signature) = 64 AND user_identity_public_key IS NOT NULL)
  );
DELETE FROM schema_migrations WHERE version=48;
