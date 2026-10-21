ALTER TABLE pending_migration_imports
  ADD COLUMN signed_plc_operation_bytes bytea,
  ADD COLUMN signed_plc_operation_digest bytea,
  ADD CONSTRAINT pending_migration_plc_operation_shape CHECK (
    (signed_plc_operation_bytes IS NULL AND signed_plc_operation_digest IS NULL) OR
    (octet_length(signed_plc_operation_bytes) BETWEEN 1 AND 16000 AND
     octet_length(signed_plc_operation_digest) = 32)
  );
