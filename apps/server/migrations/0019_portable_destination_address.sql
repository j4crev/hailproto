ALTER TABLE pending_migration_imports
  ADD COLUMN destination_address text,
  ADD COLUMN destination_binding_cose bytea,
  ADD COLUMN destination_binding_digest bytea,
  ADD CONSTRAINT pending_migration_binding_shape CHECK (
    (destination_address IS NULL AND destination_binding_cose IS NULL AND destination_binding_digest IS NULL) OR
    (destination_address = lower(destination_address) AND
     octet_length(destination_binding_cose) BETWEEN 1 AND 16384 AND
     octet_length(destination_binding_digest) = 32)
  );
