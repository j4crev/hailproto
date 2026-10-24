CREATE TABLE provider_reserved_names (
  local_part text PRIMARY KEY
);
INSERT INTO provider_reserved_names (local_part)
VALUES ('ops'), ('alerts'), ('abuse'), ('security'), ('support'), ('admin');

-- An operator assigns an account ID before normal onboarding creates the account.
-- This is not an account, credential, DID or grant of administrative authority.
CREATE TABLE provider_role_claims (
  canonical_address text PRIMARY KEY CHECK (canonical_address = lower(canonical_address)),
  account_id uuid NOT NULL UNIQUE,
  owner_recovery_public_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION enforce_provider_role_address() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.canonical_address = OLD.canonical_address AND NEW.id = OLD.id THEN
      RETURN NEW;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM provider_reserved_names WHERE local_part = split_part(lower(NEW.canonical_address), '@', 1))
    AND NOT EXISTS (SELECT 1 FROM provider_role_claims
      WHERE canonical_address = NEW.canonical_address AND account_id = NEW.id) THEN
    RAISE EXCEPTION 'Address is reserved for the provider operator' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER provider_accounts_role_address
BEFORE INSERT OR UPDATE OF canonical_address, id ON provider_accounts
FOR EACH ROW EXECUTE FUNCTION enforce_provider_role_address();
