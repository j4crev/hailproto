-- The address-selection endpoint must revalidate the original user grant and
-- source invitation against *current* PLC identity/service keys.
ALTER TABLE received_transfer_invitations
  ADD COLUMN grant_bytes bytea,
  ADD COLUMN grant_signature bytea,
  ADD COLUMN invitation_bytes bytea,
  ADD COLUMN invitation_signature bytea;
