-- Durable work survives provider restarts. A lease prevents two provider
-- processes from attempting the same invitation/final request at once.
ALTER TABLE provider_transfer_authorizations
  ADD COLUMN next_invitation_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN invitation_attempts integer NOT NULL DEFAULT 0 CHECK (invitation_attempts >= 0),
  ADD COLUMN invitation_lease_token uuid,
  ADD COLUMN invitation_lease_expires_at timestamptz,
  ADD CONSTRAINT hail_invitation_lease_complete CHECK (
    (invitation_lease_token IS NULL) = (invitation_lease_expires_at IS NULL)
  );
CREATE INDEX hail_due_transfer_invitations ON provider_transfer_authorizations (next_invitation_attempt_at)
  WHERE origin_confirmed_at IS NULL AND consumed_transfer_id IS NULL;

ALTER TABLE received_transfer_invitations
  ADD COLUMN next_final_attempt_at timestamptz,
  ADD COLUMN final_attempts integer NOT NULL DEFAULT 0 CHECK (final_attempts >= 0),
  ADD COLUMN final_lease_token uuid,
  ADD COLUMN final_lease_expires_at timestamptz,
  ADD COLUMN final_acknowledged_at timestamptz,
  ADD CONSTRAINT hail_final_lease_complete CHECK (
    (final_lease_token IS NULL) = (final_lease_expires_at IS NULL)
  );
CREATE INDEX hail_due_final_requests ON received_transfer_invitations (next_final_attempt_at)
  WHERE final_request_bytes IS NOT NULL AND final_acknowledged_at IS NULL;
