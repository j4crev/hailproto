-- Extend the durable custody-transition journal to the reverse MC-11 direction.
-- Client-held identity material is never stored by the provider.
ALTER TABLE custody_transition_preparations
  DROP CONSTRAINT custody_transition_preparations_direction_check,
  ALTER COLUMN encrypted_identity_private_key DROP NOT NULL,
  ALTER COLUMN identity_encryption_nonce DROP NOT NULL,
  ALTER COLUMN identity_encryption_version DROP NOT NULL,
  ALTER COLUMN identity_kek_id DROP NOT NULL,
  ADD CONSTRAINT custody_transition_preparations_direction_check
    CHECK (direction IN ('owner-to-managed','managed-to-owner')),
  ADD CONSTRAINT custody_transition_preparations_identity_material_check CHECK (
    (direction='owner-to-managed' AND encrypted_identity_private_key IS NOT NULL AND
      identity_encryption_nonce IS NOT NULL AND identity_encryption_version=1 AND identity_kek_id IS NOT NULL) OR
    (direction='managed-to-owner' AND encrypted_identity_private_key IS NULL AND
      identity_encryption_nonce IS NULL AND identity_encryption_version IS NULL AND identity_kek_id IS NULL)
  );
