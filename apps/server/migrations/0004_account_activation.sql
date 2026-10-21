ALTER TABLE provider_accounts
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN activation_binding_digest bytea,
  ADD CONSTRAINT provider_accounts_activation_digest_size
    CHECK (
      activation_binding_digest IS NULL OR
      octet_length(activation_binding_digest) = 32
    );
