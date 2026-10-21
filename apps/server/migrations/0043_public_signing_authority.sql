CREATE TABLE public_signing_authority_evidence (
  action_type text NOT NULL CHECK (action_type IN ('address-binding', 'sender-profile', 'delivery-status')),
  local_account_id uuid NOT NULL,
  authority_did text NOT NULL CHECK (authority_did ~ '^did:plc:[a-z2-7]{24}$'),
  authority_role text NOT NULL CHECK (authority_role IN ('hail-identity', 'hail-messaging')),
  representation_digest bytea NOT NULL CHECK (octet_length(representation_digest) = 32),
  evidence_digest bytea NOT NULL REFERENCES public_plc_resolution_evidence(evidence_digest) ON DELETE RESTRICT,
  committed_at timestamptz NOT NULL,
  PRIMARY KEY (action_type, local_account_id, representation_digest)
);

-- Stable historical identifiers intentionally survive working-row lifecycle changes.
CREATE TRIGGER hail_public_signing_authority_immutable
  BEFORE UPDATE OR DELETE ON public_signing_authority_evidence
  FOR EACH ROW EXECUTE FUNCTION hail_immutable_public_plc_authority();

CREATE TRIGGER hail_public_signing_authority_no_truncate
  BEFORE TRUNCATE ON public_signing_authority_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_public_plc_authority();
