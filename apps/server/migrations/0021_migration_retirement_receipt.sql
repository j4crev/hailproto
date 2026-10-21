ALTER TABLE provider_migration_fences
  ADD COLUMN retirement_receipt_bytes bytea,
  ADD COLUMN retired_at timestamptz,
  ADD CONSTRAINT provider_migration_retirement_shape CHECK (
    (state <> 'retired' AND retirement_receipt_bytes IS NULL AND retired_at IS NULL) OR
    (state = 'retired' AND octet_length(retirement_receipt_bytes) BETWEEN 1 AND 16384
      AND retired_at IS NOT NULL)
  );
