ALTER TABLE provider_accounts
  DROP CONSTRAINT provider_accounts_onboarding_state;

ALTER TABLE provider_accounts
  ADD CONSTRAINT provider_accounts_onboarding_state
    CHECK (onboarding_state IN (
      'reserved',
      'prepared',
      'submission-unknown',
      'did-registered',
      'address-staged',
      'activating',
      'active'
    )),
  ADD COLUMN activation_attempt_id uuid,
  ADD COLUMN activation_verification_mode text,
  ADD CONSTRAINT provider_accounts_activation_mode
    CHECK (activation_verification_mode IS NULL OR activation_verification_mode IN ('local', 'public'));

UPDATE provider_accounts
SET activation_verification_mode = 'local'
WHERE onboarding_state = 'active' AND activation_verification_mode IS NULL;

ALTER TABLE provider_accounts
  ADD CONSTRAINT provider_accounts_activation_evidence
    CHECK (
      (
        onboarding_state = 'active' AND
        activated_at IS NOT NULL AND
        activation_binding_digest IS NOT NULL AND
        activation_verification_mode IS NOT NULL AND
        activation_attempt_id IS NULL
      ) OR
      (
        onboarding_state = 'activating' AND
        activated_at IS NULL AND
        activation_binding_digest IS NULL AND
        activation_verification_mode IS NULL AND
        activation_attempt_id IS NOT NULL
      ) OR
      (
        onboarding_state NOT IN ('active', 'activating') AND
        activated_at IS NULL AND
        activation_binding_digest IS NULL AND
        activation_verification_mode IS NULL AND
        activation_attempt_id IS NULL
      )
    );

ALTER TABLE address_bindings
  ADD COLUMN hosted_at timestamptz,
  ADD COLUMN selected_at timestamptz;

UPDATE address_bindings
SET hosted_at = created_at,
    selected_at = published_at
WHERE hosted_at IS NULL;

ALTER TABLE address_bindings
  ALTER COLUMN hosted_at SET NOT NULL;
