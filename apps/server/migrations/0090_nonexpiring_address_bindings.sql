-- Binding v2 uses cooperative publication withdrawal, not a validity deadline.
-- Keep historical expiry metadata on old signed artifacts for audit only.
ALTER TABLE address_bindings DROP CONSTRAINT address_bindings_lifetime;
ALTER TABLE address_bindings ALTER COLUMN expires_at DROP NOT NULL;

-- A publication tombstone survives provider return and preserves signed audit bytes.
CREATE TABLE address_binding_withdrawals (
  binding_id uuid PRIMARY KEY,
  withdrawn_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason text NOT NULL CHECK (reason IN ('migration','account-deletion','replacement'))
);
-- Already retired accounts must not expose old immutable binding URLs after upgrade.
INSERT INTO address_binding_withdrawals(binding_id,reason)
 SELECT b.id,'migration' FROM address_bindings b JOIN provider_migration_fences f ON f.account_id=b.account_id
 WHERE f.state='retired' ON CONFLICT DO NOTHING;
