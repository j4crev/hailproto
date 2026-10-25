BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM schema_migrations WHERE version>63) OR
    EXISTS(SELECT 1 FROM account_connections WHERE consent_format='joint-v1') OR
    EXISTS(SELECT 1 FROM connection_approvals WHERE owner_payload IS NOT NULL) THEN
    RAISE EXCEPTION 'Retained owner connection consent prevents schema rollback; retain tables for code rollback';
  END IF;
END $$;
DROP TRIGGER connection_format_immutable ON account_connections;
DROP FUNCTION hail_preserve_connection_format();
ALTER TABLE account_connections DROP CONSTRAINT connection_active_consent;
ALTER TABLE account_connections DROP COLUMN consent_format;
ALTER TABLE account_connections ADD CONSTRAINT connection_active_consent CHECK(state<>'active' OR (
  activated_at IS NOT NULL AND invitation_cose IS NOT NULL AND confirmation_cose IS NOT NULL AND grant_a_cose IS NOT NULL AND grant_b_cose IS NOT NULL));
ALTER TABLE connection_approvals DROP COLUMN owner_payload,DROP COLUMN token_ciphertext,DROP COLUMN token_nonce;
DELETE FROM schema_migrations WHERE version=63;
COMMIT;
