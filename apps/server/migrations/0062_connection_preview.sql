-- Opt-in, same-provider managed connection preview. Does not authorize v0 envelope delivery.
CREATE TABLE connection_invitations (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  serving_generation bigint NOT NULL CHECK(serving_generation>0),
  did text NOT NULL,
  personal boolean NOT NULL,
  label text NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
  request_id uuid NOT NULL,
  request_digest bytea NOT NULL CHECK(octet_length(request_digest)=32),
  token_hash bytea NOT NULL CHECK(octet_length(token_hash)=32),
  ciphertext bytea NOT NULL CHECK(octet_length(ciphertext)=48),
  nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
  cose bytea NOT NULL CHECK(octet_length(cose) BETWEEN 1 AND 16384),
  signing_key text NOT NULL,
  signing_evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at bigint,
  revoked_at timestamptz,
  UNIQUE(account_id,request_id),
  CHECK(NOT personal OR expires_at IS NULL)
);
CREATE UNIQUE INDEX connection_personal_live ON connection_invitations(account_id) WHERE personal AND revoked_at IS NULL;

CREATE TABLE account_connections (
  id uuid PRIMARY KEY,
  account_a uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  account_b uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  did_a text NOT NULL,
  did_b text NOT NULL CHECK(did_a<did_b),
  generation_a bigint NOT NULL,
  generation_b bigint NOT NULL,
  grant_id_a uuid NOT NULL UNIQUE,
  grant_id_b uuid NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','active','disconnected','expired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  pending_until timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes',
  activated_at timestamptz,
  ended_at timestamptz,
  ended_by uuid REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  invitation_cose bytea,
  confirmation_cose bytea,
  grant_a_cose bytea,
  grant_b_cose bytea,
  evidence_a jsonb,
  evidence_b jsonb,
  CHECK(account_a<>account_b),
  CHECK(state<>'active' OR (activated_at IS NOT NULL AND invitation_cose IS NOT NULL AND confirmation_cose IS NOT NULL AND grant_a_cose IS NOT NULL AND grant_b_cose IS NOT NULL)),
  CHECK(ended_by IS NULL OR ended_by=account_a OR ended_by=account_b)
);
CREATE UNIQUE INDEX connection_current_pair ON account_connections(did_a,did_b) WHERE state IN ('pending','active');

CREATE TABLE connection_approvals (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL REFERENCES account_passkey_sessions(id) ON DELETE RESTRICT,
  serving_generation bigint NOT NULL,
  action text NOT NULL CHECK(action IN ('create','replace','revoke','connect','disconnect')),
  connection_id uuid REFERENCES account_connections(id) ON DELETE RESTRICT,
  invitation_id uuid REFERENCES connection_invitations(id) ON DELETE RESTRICT,
  request_digest bytea NOT NULL CHECK(octet_length(request_digest)=32),
  intent_bytes bytea NOT NULL,
  actor_key text NOT NULL,
  peer_key text,
  actor_binding bytea,
  peer_binding bytea,
  challenge text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes',
  result jsonb,
  credential_id text REFERENCES account_passkeys(credential_id) ON DELETE RESTRICT
);
CREATE TRIGGER hail_fence_connection_invitations BEFORE INSERT OR UPDATE OR DELETE ON connection_invitations
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account','account_id');
CREATE TRIGGER hail_fence_connection_approvals BEFORE INSERT OR UPDATE OR DELETE ON connection_approvals
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account','account_id');

CREATE FUNCTION hail_guard_connection_pair() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Connection history cannot be deleted'; END IF;
  PERFORM hail_assert_unfenced_account(NEW.account_a);
  PERFORM hail_assert_unfenced_account(NEW.account_b);
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.account_a,NEW.account_b,NEW.did_a,NEW.did_b,NEW.generation_a,NEW.generation_b,NEW.grant_id_a,NEW.grant_id_b,NEW.created_at,NEW.pending_until)
      IS DISTINCT FROM ROW(OLD.id,OLD.account_a,OLD.account_b,OLD.did_a,OLD.did_b,OLD.generation_a,OLD.generation_b,OLD.grant_id_a,OLD.grant_id_b,OLD.created_at,OLD.pending_until)
      OR OLD.state IN ('disconnected','expired') AND NEW IS DISTINCT FROM OLD
      OR OLD.state='active' AND (NEW.state NOT IN ('active','disconnected') OR
        ROW(NEW.invitation_cose,NEW.confirmation_cose,NEW.grant_a_cose,NEW.grant_b_cose,NEW.evidence_a,NEW.evidence_b,NEW.activated_at)
        IS DISTINCT FROM ROW(OLD.invitation_cose,OLD.confirmation_cose,OLD.grant_a_cose,OLD.grant_b_cose,OLD.evidence_a,OLD.evidence_b,OLD.activated_at)) THEN
      RAISE EXCEPTION 'Connection identity, consent and terminal history cannot be replaced';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connection_pair_guard BEFORE INSERT OR UPDATE OR DELETE ON account_connections FOR EACH ROW EXECUTE FUNCTION hail_guard_connection_pair();

CREATE FUNCTION hail_preserve_connection_control() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Connection consent history cannot be deleted'; END IF;
  IF TG_TABLE_NAME='connection_invitations' THEN
    IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at') OR OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
      RAISE EXCEPTION 'Connection invitation intent cannot be replaced'; END IF;
  ELSE
    IF (to_jsonb(NEW)-'result'-'credential_id') IS DISTINCT FROM (to_jsonb(OLD)-'result'-'credential_id') OR
      OLD.result IS NOT NULL AND ROW(NEW.result,NEW.credential_id) IS DISTINCT FROM ROW(OLD.result,OLD.credential_id) THEN
      RAISE EXCEPTION 'Connection approval intent cannot be replaced'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connection_invitation_immutable BEFORE UPDATE OR DELETE ON connection_invitations FOR EACH ROW EXECUTE FUNCTION hail_preserve_connection_control();
CREATE TRIGGER connection_approval_immutable BEFORE UPDATE OR DELETE ON connection_approvals FOR EACH ROW EXECUTE FUNCTION hail_preserve_connection_control();

CREATE FUNCTION hail_connection_preview_cutover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM provider_accounts WHERE id=NEW.account_id FOR UPDATE;
   IF EXISTS(SELECT 1 FROM connection_invitations WHERE account_id=NEW.account_id)
    OR EXISTS(SELECT 1 FROM account_connections WHERE NEW.account_id IN (account_a,account_b)
      AND (state IN ('active','disconnected') OR state='pending' AND pending_until>clock_timestamp())) THEN
    RAISE EXCEPTION 'Retained connection preview consent is not portable: export support is required before cutover' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connection_preview_fence BEFORE INSERT ON provider_migration_fences FOR EACH ROW EXECUTE FUNCTION hail_connection_preview_cutover();
CREATE TRIGGER connection_preview_generation BEFORE UPDATE OF generation ON account_serving_generations
  FOR EACH ROW WHEN (NEW.generation IS DISTINCT FROM OLD.generation) EXECUTE FUNCTION hail_connection_preview_cutover();
CREATE TRIGGER connection_preview_custody BEFORE INSERT ON custody_transition_preparations
  FOR EACH ROW EXECUTE FUNCTION hail_connection_preview_cutover();

CREATE TRIGGER connection_invitations_no_truncate BEFORE TRUNCATE ON connection_invitations
  FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_public_plc_authority();
CREATE TRIGGER account_connections_no_truncate BEFORE TRUNCATE ON account_connections
  FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_public_plc_authority();
CREATE TRIGGER connection_approvals_no_truncate BEFORE TRUNCATE ON connection_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_public_plc_authority();
