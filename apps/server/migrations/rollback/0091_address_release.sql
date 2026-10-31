DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM provider_accounts WHERE address_released_at IS NOT NULL OR closed_at IS NOT NULL)
 OR EXISTS(SELECT 1 FROM account_custom_domains WHERE withdrawn_at IS NOT NULL)
 OR EXISTS(SELECT 1 FROM custom_address_authorizations WHERE retired_at IS NOT NULL) THEN
 RAISE EXCEPTION 'Address release rollback refused: retained lifecycle evidence exists'; END IF;
END $$;
DROP FUNCTION hail_connection_message_allowed(text,text,uuid,bigint,boolean);
ALTER FUNCTION hail_connection_message_allowed_before_closure(text,text,uuid,bigint,boolean) RENAME TO hail_connection_message_allowed;
DROP FUNCTION hail_assert_unfenced_account(uuid);
ALTER FUNCTION hail_assert_unfenced_account_before_closure(uuid) RENAME TO hail_assert_unfenced_account;
DROP TRIGGER hail_released_binding ON address_bindings;
DROP FUNCTION hail_guard_released_binding();
DROP TRIGGER hail_domain_reclaim ON account_custom_domains;
DROP FUNCTION hail_guard_domain_reclaim();
DROP TRIGGER hail_address_claim ON provider_accounts;
DROP FUNCTION hail_guard_address_claim();
DROP INDEX provider_accounts_current_address;
ALTER TABLE provider_accounts DROP COLUMN closed_at, DROP COLUMN address_released_at;
ALTER TABLE provider_accounts ADD UNIQUE(canonical_address);
DROP INDEX custom_domains_current_owner;
DROP INDEX account_custom_domains_verified_domain;
ALTER TABLE account_custom_domains DROP COLUMN withdrawn_at;
ALTER TABLE account_custom_domains ADD UNIQUE(account_id,domain);
CREATE UNIQUE INDEX account_custom_domains_verified_domain ON account_custom_domains(domain) WHERE verified_at IS NOT NULL;
DROP INDEX custom_authorizations_current_address;
ALTER TABLE custom_address_authorizations DROP COLUMN retired_at;
ALTER TABLE custom_address_authorizations ADD UNIQUE(canonical_address);
ALTER TABLE address_binding_withdrawals DROP CONSTRAINT address_binding_withdrawals_reason_check;
ALTER TABLE address_binding_withdrawals ADD CHECK(reason IN ('migration','account-deletion','replacement'));
DELETE FROM schema_migrations WHERE version=91;
