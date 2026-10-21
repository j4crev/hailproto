-- Origin-confirmed response is now an inactive Transfer Offer. The final
-- request is a separate authenticated target-to-source push after selection.
ALTER TABLE provider_transfer_authorizations
  ADD COLUMN final_request_bytes bytea,
  ADD COLUMN final_request_signature bytea,
  ADD COLUMN selection_bytes bytea,
  ADD COLUMN selection_signature bytea,
  ADD COLUMN reservation_bytes bytea,
  ADD COLUMN reservation_signature bytea,
  ADD CONSTRAINT hail_final_transfer_complete CHECK (
    (final_request_bytes IS NULL AND final_request_signature IS NULL AND
     selection_bytes IS NULL AND selection_signature IS NULL AND
     reservation_bytes IS NULL AND reservation_signature IS NULL)
    OR (final_request_bytes IS NOT NULL AND final_request_signature IS NOT NULL AND
        selection_bytes IS NOT NULL AND selection_signature IS NOT NULL AND
        reservation_bytes IS NOT NULL AND reservation_signature IS NOT NULL)
  );

-- The prior request columns retain the exact origin-confirmed Offer bytes.
CREATE TABLE transfer_address_reservations (
  transfer_id uuid PRIMARY KEY REFERENCES prepared_migration_target_keys(transfer_id) ON DELETE RESTRICT,
  did text NOT NULL UNIQUE CHECK (did ~ '^did:plc:[a-z2-7]{24}$'),
  canonical_address text NOT NULL UNIQUE,
  reserved_account_id uuid UNIQUE REFERENCES provider_accounts(id) ON DELETE SET NULL,
  selection_bytes bytea NOT NULL,
  selection_signature bytea NOT NULL,
  receipt_bytes bytea NOT NULL,
  receipt_signature bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'selected' CHECK (state IN ('selected', 'submitted', 'active')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE received_transfer_invitations
  ADD COLUMN final_request_bytes bytea,
  ADD COLUMN final_request_signature bytea,
  ADD COLUMN final_submitted_at timestamptz,
  ADD CONSTRAINT hail_target_final_request_complete CHECK (
    (final_request_bytes IS NULL AND final_request_signature IS NULL AND final_submitted_at IS NULL)
    OR (final_request_bytes IS NOT NULL AND final_request_signature IS NOT NULL AND final_submitted_at IS NOT NULL)
  );
