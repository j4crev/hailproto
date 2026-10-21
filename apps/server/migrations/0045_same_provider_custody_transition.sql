-- Expand-only durable state for the owner-controlled -> managed MC-11 slice.
-- Prepared private key material is inert until an exact owner-approved PLC
-- operation, binding, Grant reconciliation set, and serving-generation change
-- commit atomically.
CREATE TABLE custody_transition_preparations (
  transition_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  did text NOT NULL CHECK (did ~ '^did:plc:[a-z2-7]{24}$'),
  direction text NOT NULL CHECK (direction = 'owner-to-managed'),
  state text NOT NULL CHECK (state IN ('prepared','submission-unknown','complete')),
  owner_recovery_public_key text NOT NULL,
  old_identity_public_key text NOT NULL,
  new_identity_public_key text NOT NULL,
  previous_operation_cid text NOT NULL,
  expected_state jsonb NOT NULL CHECK (jsonb_typeof(expected_state) = 'object'),
  history_checkpoint_digest bytea NOT NULL CHECK (octet_length(history_checkpoint_digest) = 32),
  binding_cose bytea NOT NULL CHECK (octet_length(binding_cose) BETWEEN 1 AND 16384),
  binding_digest bytea NOT NULL CHECK (octet_length(binding_digest) = 32),
  encrypted_identity_private_key bytea NOT NULL,
  identity_encryption_nonce bytea NOT NULL,
  identity_encryption_version integer NOT NULL CHECK (identity_encryption_version = 1),
  identity_kek_id text NOT NULL,
  signed_operation jsonb,
  signed_operation_bytes bytea,
  operation_dag_cbor bytea,
  operation_cid text,
  approval_payload bytea,
  approval_signature bytea,
  retired_custody_evidence jsonb,
  generation_from bigint NOT NULL CHECK (generation_from > 0),
  generation_to bigint NOT NULL CHECK (generation_to = generation_from + 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 hour'),
  completed_at timestamptz,
  CHECK ((signed_operation IS NULL) = (signed_operation_bytes IS NULL)),
  CHECK ((signed_operation IS NULL) = (operation_dag_cbor IS NULL)),
  CHECK ((signed_operation IS NULL) = (operation_cid IS NULL)),
  CHECK ((signed_operation IS NULL) = (approval_payload IS NULL)),
  CHECK ((signed_operation IS NULL) = (approval_signature IS NULL)),
  CHECK (approval_signature IS NULL OR octet_length(approval_signature) = 64),
  CHECK ((state = 'prepared' AND signed_operation IS NULL AND completed_at IS NULL AND retired_custody_evidence IS NULL) OR
         (state = 'submission-unknown' AND signed_operation IS NOT NULL AND completed_at IS NULL AND retired_custody_evidence IS NULL) OR
         (state = 'complete' AND signed_operation IS NOT NULL AND completed_at IS NOT NULL AND retired_custody_evidence IS NOT NULL))
);
CREATE UNIQUE INDEX custody_transition_one_open_account
  ON custody_transition_preparations(account_id) WHERE state <> 'complete';
CREATE INDEX custody_transition_account_history
  ON custody_transition_preparations(account_id, created_at);

CREATE TABLE custody_transition_grant_successors (
  transition_id uuid NOT NULL REFERENCES custody_transition_preparations(transition_id) ON DELETE RESTRICT,
  grant_id uuid NOT NULL,
  predecessor_revision integer NOT NULL CHECK (predecessor_revision > 0),
  predecessor_digest bytea NOT NULL CHECK (octet_length(predecessor_digest) = 32),
  successor_revision integer NOT NULL CHECK (successor_revision = predecessor_revision + 1),
  successor_cose bytea NOT NULL CHECK (octet_length(successor_cose) BETWEEN 1 AND 262144),
  successor_digest bytea NOT NULL CHECK (octet_length(successor_digest) = 32),
  destination_service_base text NOT NULL,
  PRIMARY KEY (transition_id, grant_id),
  UNIQUE (grant_id, successor_revision)
);

CREATE FUNCTION hail_guard_custody_transition_evidence() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.state = 'complete' OR
     NEW.transition_id IS DISTINCT FROM OLD.transition_id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR
     NEW.did IS DISTINCT FROM OLD.did OR NEW.direction IS DISTINCT FROM OLD.direction OR
     NEW.owner_recovery_public_key IS DISTINCT FROM OLD.owner_recovery_public_key OR
     NEW.old_identity_public_key IS DISTINCT FROM OLD.old_identity_public_key OR
     NEW.new_identity_public_key IS DISTINCT FROM OLD.new_identity_public_key OR
     NEW.previous_operation_cid IS DISTINCT FROM OLD.previous_operation_cid OR
     NEW.expected_state IS DISTINCT FROM OLD.expected_state OR
     NEW.history_checkpoint_digest IS DISTINCT FROM OLD.history_checkpoint_digest OR
     NEW.binding_cose IS DISTINCT FROM OLD.binding_cose OR NEW.binding_digest IS DISTINCT FROM OLD.binding_digest OR
     NEW.encrypted_identity_private_key IS DISTINCT FROM OLD.encrypted_identity_private_key OR
     NEW.identity_encryption_nonce IS DISTINCT FROM OLD.identity_encryption_nonce OR
     NEW.identity_encryption_version IS DISTINCT FROM OLD.identity_encryption_version OR
     NEW.identity_kek_id IS DISTINCT FROM OLD.identity_kek_id OR NEW.generation_from IS DISTINCT FROM OLD.generation_from OR
     NEW.generation_to IS DISTINCT FROM OLD.generation_to OR NEW.created_at IS DISTINCT FROM OLD.created_at OR
     NEW.expires_at IS DISTINCT FROM OLD.expires_at OR
     (OLD.signed_operation_bytes IS NOT NULL AND (
       NEW.signed_operation_bytes IS DISTINCT FROM OLD.signed_operation_bytes OR
       NEW.operation_cid IS DISTINCT FROM OLD.operation_cid OR
       NEW.approval_payload IS DISTINCT FROM OLD.approval_payload OR
       NEW.approval_signature IS DISTINCT FROM OLD.approval_signature)) THEN
    RAISE EXCEPTION 'Custody transition evidence is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hail_custody_transition_evidence_immutable
  BEFORE UPDATE OR DELETE ON custody_transition_preparations
  FOR EACH ROW EXECUTE FUNCTION hail_guard_custody_transition_evidence();
CREATE TRIGGER hail_custody_transition_grants_immutable
  BEFORE UPDATE OR DELETE ON custody_transition_grant_successors
  FOR EACH ROW EXECUTE FUNCTION hail_immutable_public_plc_authority();
CREATE TRIGGER hail_custody_transition_no_truncate
  BEFORE TRUNCATE ON custody_transition_preparations
  FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_public_plc_authority();
CREATE TRIGGER hail_custody_transition_grants_no_truncate
  BEFORE TRUNCATE ON custody_transition_grant_successors
  FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_public_plc_authority();

CREATE OR REPLACE FUNCTION hail_assert_unfenced_account(owner uuid) RETURNS void AS $$
DECLARE owner_did text; serving bigint; expected bigint; snapshot jsonb;
BEGIN
  IF owner IS NULL THEN RETURN; END IF;
  SELECT did INTO owner_did FROM provider_accounts WHERE id=owner FOR UPDATE;
  IF owner_did IS NULL THEN RETURN; END IF;
  SELECT generation INTO serving FROM account_serving_generations WHERE account_id=owner;
  snapshot:=NULLIF(current_setting('hail.admitted_generations',true),'')::jsonb;
  expected:=(snapshot->>owner::text)::bigint;
  IF (expected IS NOT NULL AND expected IS DISTINCT FROM serving) OR (serving>1 AND expected IS NULL) THEN
    RAISE EXCEPTION 'Serving generation admission is stale or missing' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM provider_migration_fences WHERE did=owner_did) THEN
    RAISE EXCEPTION 'Hail DID is migration-fenced' USING ERRCODE='55000';
  END IF;
  IF current_setting('hail.custody_transition',true) IS DISTINCT FROM owner::text AND EXISTS (
    SELECT 1 FROM custody_transition_preparations WHERE account_id=owner AND state<>'complete'
  ) THEN RAISE EXCEPTION 'Hail DID is custody-transition-fenced' USING ERRCODE='55000'; END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hail_guard_generation_advance() RETURNS trigger AS $$
BEGIN
  IF NEW.account_id<>OLD.account_id OR NEW.generation<>OLD.generation THEN
    IF NEW.account_id<>OLD.account_id OR NEW.generation<>OLD.generation+1 OR
      (current_setting('hail.returning_account',true) IS DISTINCT FROM OLD.account_id::text AND
       current_setting('hail.custody_transition',true) IS DISTINCT FROM OLD.account_id::text) THEN
      RAISE EXCEPTION 'Serving generation needs a reviewed ownership transition' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION hail_require_managed_custody_consistency() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM portable_custody_evidence WHERE account_id=NEW.account_id) OR NOT EXISTS (
    SELECT 1 FROM account_keys WHERE account_id=NEW.account_id AND role='hail-identity' AND public_key=NEW.provider_identity_public_key
  ) THEN RAISE EXCEPTION 'Managed custody requires one matching provider identity and no portable custody' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hail_managed_custody_consistency BEFORE INSERT OR UPDATE ON managed_custody_evidence
  FOR EACH ROW EXECUTE FUNCTION hail_require_managed_custody_consistency();

CREATE OR REPLACE FUNCTION hail_require_portable_key_separation() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'portable_custody_evidence' THEN
    IF EXISTS (SELECT 1 FROM account_keys WHERE account_id=NEW.account_id AND role='hail-identity') OR
       EXISTS (SELECT 1 FROM managed_custody_evidence WHERE account_id=NEW.account_id) THEN
      RAISE EXCEPTION 'Portable custody forbids provider identity storage or managed custody';
    END IF;
  ELSIF NEW.role = 'hail-identity' AND EXISTS (
    SELECT 1 FROM portable_custody_evidence WHERE account_id = NEW.account_id
  ) THEN RAISE EXCEPTION 'Portable custody forbids provider identity private-key storage'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
