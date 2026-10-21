-- Expand-only, provider-local history. Existing signed/account/envelope row shapes
-- stay unchanged; no old single-reader decision is retroactively relabeled.
CREATE TABLE public_plc_resolution_evidence (
  evidence_digest bytea PRIMARY KEY CHECK (octet_length(evidence_digest) = 32),
  did text NOT NULL CHECK (did ~ '^did:plc:[a-z2-7]{24}$'),
  operation_cid text NOT NULL,
  verified_at timestamptz NOT NULL,
  bundle_bytes bytea NOT NULL CHECK (octet_length(bundle_bytes) BETWEEN 1 AND 8388608)
);
CREATE INDEX public_plc_resolution_did_idx ON public_plc_resolution_evidence(did, verified_at);

CREATE TABLE public_envelope_authority_evidence (
  sender_did text NOT NULL CHECK (sender_did ~ '^did:plc:[a-z2-7]{24}$'),
  message_id uuid NOT NULL,
  authority_did text NOT NULL CHECK (authority_did ~ '^did:plc:[a-z2-7]{24}$'),
  recipient_did text NOT NULL CHECK (recipient_did ~ '^did:plc:[a-z2-7]{24}$'),
  local_account_id uuid NOT NULL,
  representation_digest bytea NOT NULL CHECK (octet_length(representation_digest) = 32),
  evidence_digest bytea NOT NULL REFERENCES public_plc_resolution_evidence(evidence_digest) ON DELETE RESTRICT,
  accepted_at timestamptz NOT NULL,
  PRIMARY KEY(sender_did, message_id, authority_did),
  CHECK (authority_did = sender_did OR authority_did = recipient_did),
  CHECK (sender_did <> recipient_did)
);
CREATE INDEX public_envelope_authority_account_idx ON public_envelope_authority_evidence(local_account_id, accepted_at);

CREATE FUNCTION hail_immutable_public_plc_authority() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Public PLC authority evidence is immutable' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hail_public_plc_resolution_immutable BEFORE UPDATE OR DELETE ON public_plc_resolution_evidence
  FOR EACH ROW EXECUTE FUNCTION hail_immutable_public_plc_authority();
CREATE TRIGGER hail_public_plc_resolution_no_truncate BEFORE TRUNCATE ON public_plc_resolution_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_public_plc_authority();
CREATE TRIGGER hail_public_envelope_authority_immutable BEFORE UPDATE OR DELETE ON public_envelope_authority_evidence
  FOR EACH ROW EXECUTE FUNCTION hail_immutable_public_plc_authority();
CREATE TRIGGER hail_public_envelope_authority_no_truncate BEFORE TRUNCATE ON public_envelope_authority_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_public_plc_authority();
