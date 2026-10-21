CREATE TABLE public_grant_authority_evidence (
  grant_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  local_account_id uuid NOT NULL,
  local_role text NOT NULL CHECK (local_role IN ('grantor','grantee')),
  purpose text NOT NULL CHECK (purpose IN ('signer','recipient','consent-binding','consent-profile')),
  authority_did text NOT NULL CHECK (authority_did ~ '^did:plc:[a-z2-7]{24}$'),
  representation_digest bytea NOT NULL CHECK (octet_length(representation_digest)=32),
  evidence_digest bytea NOT NULL REFERENCES public_plc_resolution_evidence(evidence_digest) ON DELETE RESTRICT,
  committed_at timestamptz NOT NULL,
  PRIMARY KEY(grant_id,revision,local_account_id,purpose)
);
-- Stable historical IDs, not foreign keys to recyclable working revisions/accounts.
CREATE TRIGGER hail_public_grant_authority_immutable BEFORE UPDATE OR DELETE ON public_grant_authority_evidence
  FOR EACH ROW EXECUTE FUNCTION hail_immutable_public_plc_authority();
CREATE TRIGGER hail_public_grant_authority_no_truncate BEFORE TRUNCATE ON public_grant_authority_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_public_plc_authority();
