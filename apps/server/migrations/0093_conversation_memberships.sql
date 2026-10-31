CREATE TABLE conversation_descriptors (
  creator_did text NOT NULL,
  conversation_id uuid NOT NULL,
  descriptor_hash bytea NOT NULL CHECK(octet_length(descriptor_hash)=32),
  descriptor_cose bytea NOT NULL CHECK(octet_length(descriptor_cose) BETWEEN 1 AND 16384),
  participants text[] NOT NULL CHECK(cardinality(participants) BETWEEN 3 AND 101),
  created_at timestamptz NOT NULL,
  admission_until timestamptz NOT NULL,
  signing_key text NOT NULL,
  signing_evidence jsonb NOT NULL,
  PRIMARY KEY(creator_did,conversation_id)
);
CREATE TABLE conversation_memberships (
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  creator_did text NOT NULL,
  conversation_id uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('active','left')),
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 months',
  last_activity_at timestamptz,
  left_at timestamptz,
  PRIMARY KEY(account_id,creator_did,conversation_id),
  FOREIGN KEY(creator_did,conversation_id) REFERENCES conversation_descriptors(creator_did,conversation_id) ON DELETE RESTRICT,
  CHECK((state='left')=(left_at IS NOT NULL))
);
CREATE TABLE conversation_revival_receipts (
  account_id uuid NOT NULL,
  creator_did text NOT NULL,
  conversation_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_hash bytea NOT NULL CHECK(octet_length(request_hash)=32),
  expires_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('renewed','active','left','denied')),
  PRIMARY KEY(account_id,creator_did,request_id),
  FOREIGN KEY(account_id,creator_did,conversation_id) REFERENCES conversation_memberships(account_id,creator_did,conversation_id) ON DELETE RESTRICT
);
CREATE INDEX conversation_membership_expiry ON conversation_memberships(expires_at) WHERE state='active';
CREATE TRIGGER conversation_descriptor_immutable BEFORE UPDATE ON conversation_descriptors
  FOR EACH ROW EXECUTE FUNCTION hail_immutable_public_plc_authority();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['conversation_memberships','conversation_revival_receipts'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write(''account'',''account_id'')',t||'_fence',t);
  END LOOP;
END $$;
