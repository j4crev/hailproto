-- Breaking pre-launch client rename. Pending browser logins must be restarted.
-- Keep migration 56 immutable so existing databases pass checksum verification.
DELETE FROM account_browser_authorizations;
ALTER TABLE account_browser_authorizations
  DROP CONSTRAINT account_browser_authorizations_client_id_check;
ALTER TABLE account_browser_authorizations
  ADD CONSTRAINT account_browser_authorizations_client_id_check
  CHECK (client_id = 'racr-cli-v1');
