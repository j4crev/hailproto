-- Inert, immutable evidence only. No connection-location or cutover guard changes.
CREATE TABLE connection_handover_preparations (
  transfer_id uuid NOT NULL REFERENCES pending_migration_imports(transfer_id) ON DELETE RESTRICT,
  peer_did text NOT NULL CHECK(peer_did ~ '^did:plc:[a-z2-7]{24}$'),
  request_id uuid NOT NULL,
  snapshot_digest bytea NOT NULL CHECK(octet_length(snapshot_digest)=32),
  payload_bytes bytea NOT NULL CHECK(octet_length(payload_bytes) BETWEEN 1 AND 65536),
  source_signature bytea NOT NULL CHECK(octet_length(source_signature)=64),
  destination_signature bytea NOT NULL CHECK(octet_length(destination_signature)=64),
  peer_signature bytea NOT NULL CHECK(octet_length(peer_signature)=64),
  peer_messaging_public_key text NOT NULL,
  peer_authority jsonb NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(transfer_id,peer_did,request_id)
);
CREATE TRIGGER connection_handover_preparations_immutable BEFORE UPDATE OR DELETE ON connection_handover_preparations
  FOR EACH ROW EXECUTE FUNCTION hail_immutable_public_plc_authority();
CREATE TRIGGER connection_handover_preparations_no_truncate BEFORE TRUNCATE ON connection_handover_preparations
  FOR EACH STATEMENT EXECUTE FUNCTION hail_immutable_public_plc_authority();
