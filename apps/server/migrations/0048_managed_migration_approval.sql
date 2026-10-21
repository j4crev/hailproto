-- Portable consent is identity-signed. Managed migration approval is instead
-- signed by the independent top owner-recovery key retained in the managed
-- custody columns added by migration 47.
ALTER TABLE pending_migration_imports
  DROP CONSTRAINT pending_migration_consent_shape,
  ADD CONSTRAINT pending_migration_consent_shape CHECK (
    (user_consent_payload IS NULL AND user_consent_signature IS NULL AND user_identity_public_key IS NULL)
    OR (custody_profile='portable' AND user_consent_payload IS NOT NULL AND
      octet_length(user_consent_payload) BETWEEN 1 AND 16384 AND
      octet_length(user_consent_signature)=64 AND user_identity_public_key IS NOT NULL)
    OR (custody_profile='managed' AND user_consent_payload IS NOT NULL AND
      octet_length(user_consent_payload) BETWEEN 1 AND 16384 AND
      octet_length(user_consent_signature)=64 AND user_identity_public_key IS NULL)
  );
