-- Preserve deployed grants-v1 connections; allow new identity-signed joint consent.
ALTER TABLE connection_approvals
  ADD COLUMN owner_payload bytea,
  ADD COLUMN token_ciphertext bytea,
  ADD COLUMN token_nonce bytea,
  ADD CONSTRAINT connection_owner_proposal_size CHECK(owner_payload IS NULL OR octet_length(owner_payload) BETWEEN 1 AND 16384),
  ADD CONSTRAINT connection_owner_pending_token CHECK(
    (token_ciphertext IS NULL AND token_nonce IS NULL) OR
    (owner_payload IS NOT NULL AND octet_length(token_ciphertext)=48 AND octet_length(token_nonce)=12));

ALTER TABLE account_connections ADD COLUMN consent_format text NOT NULL DEFAULT 'grants-v1'
  CHECK(consent_format IN ('grants-v1','joint-v1'));
DO $$ DECLARE constraint_name text; BEGIN
  SELECT conname INTO STRICT constraint_name FROM pg_constraint
    WHERE conrelid='account_connections'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%grant_a_cose%';
  EXECUTE format('ALTER TABLE account_connections DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE account_connections ADD CONSTRAINT connection_active_consent CHECK(state<>'active' OR (
  activated_at IS NOT NULL AND invitation_cose IS NOT NULL AND confirmation_cose IS NOT NULL AND
  ((consent_format='grants-v1' AND grant_a_cose IS NOT NULL AND grant_b_cose IS NOT NULL) OR
   (consent_format='joint-v1' AND grant_a_cose IS NULL AND grant_b_cose IS NULL AND evidence_a IS NOT NULL AND evidence_b IS NOT NULL))));

-- Existing immutable-intent guard already includes newly added approval columns.
CREATE FUNCTION hail_preserve_connection_format() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.consent_format IS DISTINCT FROM OLD.consent_format THEN
    RAISE EXCEPTION 'Connection consent format cannot be replaced';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connection_format_immutable BEFORE UPDATE ON account_connections
  FOR EACH ROW EXECUTE FUNCTION hail_preserve_connection_format();
