ALTER TABLE pending_migration_imports
  DROP CONSTRAINT pending_migration_imports_state_check,
  ADD CONSTRAINT pending_migration_imports_state_check
    CHECK (state IN ('staged', 'invalidated', 'active')),
  ADD COLUMN activated_at timestamptz;

ALTER TABLE prepared_migration_target_keys
  DROP CONSTRAINT prepared_migration_target_keys_state_check,
  ADD CONSTRAINT prepared_migration_target_keys_state_check
    CHECK (state IN ('prepared', 'staged', 'invalidated', 'active'));
