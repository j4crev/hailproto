-- Account-scoped peer/identity proof authority. Keep the original local-control
-- ledger and its digest conflict key compatible with older lifecycle writers.
CREATE TABLE connection_proof_signatures (
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  digest bytea NOT NULL CHECK(octet_length(digest)=32),
  cose bytea NOT NULL CHECK(octet_length(cose) BETWEEN 1 AND 16384),
  authority jsonb NOT NULL,
  PRIMARY KEY(account_id,digest)
);
CREATE TRIGGER connection_proof_signatures_fence BEFORE INSERT OR UPDATE OR DELETE ON connection_proof_signatures
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account','account_id');
CREATE TRIGGER connection_proof_signatures_immutable BEFORE UPDATE OR DELETE ON connection_proof_signatures
  FOR EACH ROW EXECUTE FUNCTION hail_immutable_public_plc_authority();
CREATE TRIGGER connection_proof_signatures_no_truncate BEFORE TRUNCATE ON connection_proof_signatures
  FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_public_plc_authority();
