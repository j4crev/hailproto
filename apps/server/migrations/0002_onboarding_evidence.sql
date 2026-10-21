ALTER TABLE provider_accounts
  ADD COLUMN state_version integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT provider_accounts_state_version CHECK (state_version > 0);

ALTER TABLE account_keys
  ADD COLUMN encryption_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN kek_id text NOT NULL DEFAULT 'poc-v1',
  ADD CONSTRAINT account_keys_encryption_version CHECK (encryption_version = 1),
  ADD CONSTRAINT account_keys_nonce_size CHECK (octet_length(encryption_nonce) = 12),
  ADD CONSTRAINT account_keys_ciphertext_size CHECK (octet_length(encrypted_private_key) >= 17),
  ADD CONSTRAINT account_keys_nonce_unique UNIQUE (kek_id, encryption_nonce);

ALTER TABLE plc_operation_evidence
  ADD COLUMN signed_operation_bytes bytea,
  ADD COLUMN expected_state jsonb,
  ADD COLUMN submission_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN last_submission_at timestamptz,
  ADD CONSTRAINT plc_operation_evidence_attempts CHECK (submission_attempts >= 0);

CREATE UNIQUE INDEX plc_operation_evidence_genesis_account_idx
  ON plc_operation_evidence (account_id)
  WHERE previous_cid IS NULL;
