-- Coordinated upgrade: stop old writers before applying. Old binaries cannot
-- safely distinguish an account's historical address from its current claim.
ALTER TABLE provider_accounts ADD COLUMN address_released_at timestamptz;
ALTER TABLE provider_accounts ADD COLUMN closed_at timestamptz;
ALTER TABLE provider_accounts ADD CHECK (closed_at IS NULL OR address_released_at IS NOT NULL);
ALTER TABLE provider_accounts DROP CONSTRAINT provider_accounts_canonical_address_key;
CREATE UNIQUE INDEX provider_accounts_current_address ON provider_accounts(canonical_address) WHERE address_released_at IS NULL;
ALTER TABLE account_custom_domains ADD COLUMN withdrawn_at timestamptz;
ALTER TABLE account_custom_domains DROP CONSTRAINT account_custom_domains_account_id_domain_key;
CREATE UNIQUE INDEX custom_domains_current_owner ON account_custom_domains(account_id,domain) WHERE withdrawn_at IS NULL;
DROP INDEX account_custom_domains_verified_domain;
CREATE UNIQUE INDEX account_custom_domains_verified_domain ON account_custom_domains(domain) WHERE verified_at IS NOT NULL AND withdrawn_at IS NULL;
ALTER TABLE custom_address_authorizations ADD COLUMN retired_at timestamptz;
ALTER TABLE custom_address_authorizations DROP CONSTRAINT custom_address_authorizations_canonical_address_key;
CREATE UNIQUE INDEX custom_authorizations_current_address ON custom_address_authorizations(canonical_address) WHERE retired_at IS NULL;
ALTER TABLE address_binding_withdrawals DROP CONSTRAINT address_binding_withdrawals_reason_check;
ALTER TABLE address_binding_withdrawals ADD CHECK (reason IN ('migration','account-deletion','replacement','domain-withdrawal'));

CREATE FUNCTION hail_guard_address_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.address_released_at IS NOT NULL AND (NEW.address_released_at IS DISTINCT FROM OLD.address_released_at OR NEW.canonical_address<>OLD.canonical_address) OR
      OLD.closed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Released account identity cannot be reassigned or reopened' USING ERRCODE='55000';
    END IF;
    IF NEW.canonical_address=OLD.canonical_address THEN RETURN NEW; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.canonical_address,91));
  IF NEW.address_released_at IS NULL AND EXISTS(SELECT 1 FROM provider_accounts
    WHERE canonical_address=NEW.canonical_address AND address_released_at>clock_timestamp()-interval '3630 seconds') THEN
    RAISE EXCEPTION 'Address withdrawal cache quarantine is still active' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hail_address_claim BEFORE INSERT OR UPDATE ON provider_accounts FOR EACH ROW EXECUTE FUNCTION hail_guard_address_claim();

CREATE FUNCTION hail_guard_domain_reclaim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.withdrawn_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Withdrawn registration must retain its evidence' USING ERRCODE='55000';
  END IF;
  IF NEW.verified_at IS NOT NULL AND NEW.withdrawn_at IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.domain,92));
    IF EXISTS(SELECT 1 FROM account_custom_domains WHERE domain=NEW.domain AND withdrawn_at IS NOT NULL
      AND (withdrawn_at>clock_timestamp()-interval '3630 seconds' OR withdrawn_at>=NEW.challenge_created_at)) THEN
      RAISE EXCEPTION 'Domain reassignment requires fresh proof after cache quarantine' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hail_domain_reclaim BEFORE INSERT OR UPDATE ON account_custom_domains FOR EACH ROW EXECUTE FUNCTION hail_guard_domain_reclaim();

CREATE FUNCTION hail_guard_released_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM provider_accounts WHERE id=NEW.account_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM provider_accounts WHERE id=NEW.account_id AND address_released_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Released addresses cannot publish bindings' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hail_released_binding BEFORE INSERT OR UPDATE ON address_bindings FOR EACH ROW EXECUTE FUNCTION hail_guard_released_binding();

ALTER FUNCTION hail_assert_unfenced_account(uuid) RENAME TO hail_assert_unfenced_account_before_closure;
CREATE FUNCTION hail_assert_unfenced_account(owner uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM provider_accounts WHERE id=owner FOR UPDATE;
  IF EXISTS(SELECT 1 FROM provider_accounts WHERE id=owner AND closed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Account is closed' USING ERRCODE='55000';
  END IF;
  PERFORM hail_assert_unfenced_account_before_closure(owner);
END $$;

ALTER FUNCTION hail_connection_message_allowed(text,text,uuid,bigint,boolean) RENAME TO hail_connection_message_allowed_before_closure;
CREATE FUNCTION hail_connection_message_allowed(owner_did text,other_did text,connection uuid,expected_epoch bigint,lock_pair boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM provider_accounts WHERE did IN(owner_did,other_did) AND closed_at IS NOT NULL) THEN RETURN false; END IF;
 RETURN hail_connection_message_allowed_before_closure(owner_did,other_did,connection,expected_epoch,lock_pair);
END $$;
