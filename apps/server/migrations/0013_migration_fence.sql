CREATE TABLE provider_migration_fences (
  did text PRIMARY KEY CHECK (did ~ '^did:plc:[a-z2-7]{24}$'),
  account_id uuid NOT NULL UNIQUE REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  transfer_id uuid NOT NULL UNIQUE,
  destination_service_base text NOT NULL,
  state text NOT NULL CHECK (state IN ('fenced', 'exported', 'retired')),
  snapshot_digest bytea CHECK (snapshot_digest IS NULL OR octet_length(snapshot_digest) = 32),
  fenced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state = 'fenced') = (snapshot_digest IS NULL))
);

-- The account row is the serialization point for every DID-owned writer.
-- A write holding that row lock commits before a concurrent fence can commit;
-- a writer acquiring it after a committed fence is rejected.
CREATE FUNCTION hail_assert_unfenced_account(owner uuid) RETURNS void AS $$
DECLARE
  owner_did text;
BEGIN
  IF owner IS NULL THEN RETURN; END IF;
  SELECT did INTO owner_did FROM provider_accounts WHERE id = owner FOR UPDATE;
  IF owner_did IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM provider_migration_fences WHERE did = owner_did) THEN
    RAISE EXCEPTION 'Hail DID is migration-fenced' USING ERRCODE = '55000';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION hail_assert_unfenced_did(owner text) RETURNS void AS $$
DECLARE
  owner_id uuid;
BEGIN
  IF owner IS NULL THEN RETURN; END IF;
  SELECT id INTO owner_id FROM provider_accounts WHERE did = owner FOR UPDATE;
  PERFORM hail_assert_unfenced_account(owner_id);
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION hail_guard_did_write() RETURNS trigger AS $$
DECLARE
  record_new jsonb;
  record_old jsonb;
  owner text;
  prior_owner text;
  account_owner uuid;
BEGIN
  IF TG_OP <> 'DELETE' THEN record_new := to_jsonb(NEW); END IF;
  IF TG_OP <> 'INSERT' THEN record_old := to_jsonb(OLD); END IF;
  owner := record_new ->> TG_ARGV[1];
  prior_owner := record_old ->> TG_ARGV[1];
  IF TG_ARGV[0] = 'account' THEN
    PERFORM hail_assert_unfenced_account(owner::uuid);
    IF prior_owner IS DISTINCT FROM owner THEN PERFORM hail_assert_unfenced_account(prior_owner::uuid); END IF;
  ELSIF TG_ARGV[0] = 'did' THEN
    PERFORM hail_assert_unfenced_did(owner);
    IF prior_owner IS DISTINCT FROM owner THEN PERFORM hail_assert_unfenced_did(prior_owner); END IF;
  ELSIF TG_ARGV[0] = 'grant' THEN
    SELECT local_account_id INTO account_owner FROM grant_lineages WHERE grant_id = owner::uuid;
    PERFORM hail_assert_unfenced_account(account_owner);
    IF prior_owner IS DISTINCT FROM owner THEN
      SELECT local_account_id INTO account_owner FROM grant_lineages WHERE grant_id = prior_owner::uuid;
      PERFORM hail_assert_unfenced_account(account_owner);
    END IF;
  ELSIF TG_ARGV[0] = 'received' THEN
    SELECT local_account_id INTO account_owner FROM received_envelopes
      WHERE sender_did = owner AND message_id = (record_new ->> TG_ARGV[2])::uuid;
    PERFORM hail_assert_unfenced_account(account_owner);
    IF prior_owner IS DISTINCT FROM owner OR TG_OP = 'DELETE' THEN
      SELECT local_account_id INTO account_owner FROM received_envelopes
        WHERE sender_did = prior_owner AND message_id = (record_old ->> TG_ARGV[2])::uuid;
      PERFORM hail_assert_unfenced_account(account_owner);
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hail_fence_accounts BEFORE INSERT OR UPDATE OR DELETE ON provider_accounts
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('did', 'did');
CREATE TRIGGER hail_fence_keys BEFORE INSERT OR UPDATE OR DELETE ON account_keys
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account', 'account_id');
CREATE TRIGGER hail_fence_plc_evidence BEFORE INSERT OR UPDATE OR DELETE ON plc_operation_evidence
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account', 'account_id');
CREATE TRIGGER hail_fence_bindings BEFORE INSERT OR UPDATE OR DELETE ON address_bindings
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account', 'account_id');
CREATE TRIGGER hail_fence_profiles BEFORE INSERT OR UPDATE OR DELETE ON sender_profiles
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account', 'account_id');
CREATE TRIGGER hail_fence_grants BEFORE INSERT OR UPDATE OR DELETE ON grant_lineages
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account', 'local_account_id');
CREATE TRIGGER hail_fence_grant_revisions BEFORE INSERT OR UPDATE OR DELETE ON grant_revisions
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('grant', 'grant_id');
CREATE TRIGGER hail_fence_grant_consent BEFORE INSERT OR UPDATE OR DELETE ON grant_consent_evidence
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('grant', 'grant_id');
CREATE TRIGGER hail_fence_grant_publications BEFORE INSERT OR UPDATE OR DELETE ON grant_publications
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('grant', 'grant_id');
CREATE TRIGGER hail_fence_bodies BEFORE INSERT OR UPDATE OR DELETE ON detached_bodies
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account', 'sender_account_id');
CREATE TRIGGER hail_fence_body_auth BEFORE INSERT OR UPDATE OR DELETE ON body_authorizations
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account', 'sender_account_id');
CREATE TRIGGER hail_fence_sent BEFORE INSERT OR UPDATE OR DELETE ON sent_envelopes
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account', 'sender_account_id');
CREATE TRIGGER hail_fence_received BEFORE INSERT OR UPDATE OR DELETE ON received_envelopes
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account', 'local_account_id');
CREATE TRIGGER hail_fence_replies BEFORE INSERT OR UPDATE OR DELETE ON reply_capabilities
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('did', 'original_sender_did');
CREATE TRIGGER hail_fence_delivery_work BEFORE INSERT OR UPDATE OR DELETE ON delivery_work
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('received', 'sender_did', 'message_id');
CREATE TRIGGER hail_fence_verified_bodies BEFORE INSERT OR UPDATE OR DELETE ON verified_body_provenance
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('did', 'recipient_did');
CREATE TRIGGER hail_fence_delivered BEFORE INSERT OR UPDATE OR DELETE ON delivered_messages
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('did', 'recipient_did');
CREATE TRIGGER hail_fence_status_payloads BEFORE INSERT OR UPDATE OR DELETE ON delivery_status_payloads
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('received', 'sender_did', 'message_id');
CREATE TRIGGER hail_fence_status_wrappers BEFORE INSERT OR UPDATE OR DELETE ON delivery_status_wrappers
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('received', 'sender_did', 'message_id');
CREATE TRIGGER hail_fence_terminal_outbox BEFORE INSERT OR UPDATE OR DELETE ON terminal_status_publications
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('received', 'sender_did', 'message_id');
CREATE TRIGGER hail_fence_sent_status BEFORE INSERT OR UPDATE OR DELETE ON sent_delivery_status
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('did', 'sender_did');
