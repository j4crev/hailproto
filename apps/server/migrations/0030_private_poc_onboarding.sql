-- A private-PLC POC identity starts with user-held top recovery and identity
-- keys. No user private key or encrypted user key is stored by the provider.
CREATE TABLE private_poc_onboarding_preparations (
  account_id uuid PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  user_recovery_public_key text NOT NULL,
  user_identity_public_key text NOT NULL,
  provider_rotation_public_key text NOT NULL,
  provider_messaging_public_key text NOT NULL,
  monitor_public_key text NOT NULL,
  backup_checked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (user_recovery_public_key <> provider_rotation_public_key),
  CHECK (user_identity_public_key <> provider_messaging_public_key)
);
