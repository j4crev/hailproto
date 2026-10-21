CREATE TABLE public_onboarding_preparations (
  account_id uuid PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  owner_recovery_public_key text NOT NULL,
  owner_identity_public_key text NOT NULL,
  provider_rotation_public_key text NOT NULL,
  provider_messaging_public_key text NOT NULL,
  monitor_origin text NOT NULL,
  monitor_public_key text NOT NULL,
  custody_profile text NOT NULL CHECK (custody_profile IN ('owner-controlled', 'managed')),
  backup_confirmed_at timestamptz NOT NULL,
  signup_token_hash bytea CHECK (signup_token_hash IS NULL OR octet_length(signup_token_hash) = 32),
  initial_binding_cose bytea,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (owner_recovery_public_key <> provider_rotation_public_key),
  CHECK (owner_identity_public_key <> provider_messaging_public_key)
);

CREATE TABLE public_onboarding_evidence (
  account_id uuid PRIMARY KEY,
  did text NOT NULL CHECK (did ~ '^did:plc:[a-z2-7]{24}$'),
  operation_cid text NOT NULL,
  genesis_digest bytea NOT NULL CHECK (octet_length(genesis_digest) = 32),
  binding_digest bytea NOT NULL CHECK (octet_length(binding_digest) = 32),
  plc_evidence_digest bytea NOT NULL REFERENCES public_plc_resolution_evidence(evidence_digest) ON DELETE RESTRICT,
  monitor_origin text NOT NULL,
  monitor_public_key text NOT NULL,
  monitor_payload bytea NOT NULL CHECK (octet_length(monitor_payload) BETWEEN 1 AND 4096),
  monitor_signature bytea NOT NULL CHECK (octet_length(monitor_signature) = 64),
  monitor_state_digest text NOT NULL CHECK (monitor_state_digest ~ '^[A-Za-z0-9_-]{43}$'),
  monitor_export_sequence bigint NOT NULL CHECK (monitor_export_sequence > 0),
  activated_at timestamptz NOT NULL,
  UNIQUE (did),
  UNIQUE (monitor_payload, monitor_signature)
);

CREATE TRIGGER hail_public_onboarding_immutable
  BEFORE UPDATE OR DELETE ON public_onboarding_evidence
  FOR EACH ROW EXECUTE FUNCTION hail_immutable_public_plc_authority();
CREATE TRIGGER hail_public_onboarding_no_truncate
  BEFORE TRUNCATE ON public_onboarding_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_public_plc_authority();

ALTER TABLE managed_custody_evidence DROP CONSTRAINT managed_custody_evidence_verification_mode_check;
ALTER TABLE managed_custody_evidence ADD CONSTRAINT managed_custody_evidence_verification_mode_check
  CHECK (verification_mode IN ('poc-local', 'strict-public-v1'));
