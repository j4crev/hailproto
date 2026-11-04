-- Detached immutable files, with ownership tied to retained bodies or editable uploads.
CREATE TABLE attachment_blobs (
  digest bytea PRIMARY KEY CHECK(octet_length(digest)=32),
  bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 26214400),
  CHECK(sha256(bytes)=digest)
);
CREATE TABLE attachment_uploads (
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  digest bytea NOT NULL REFERENCES attachment_blobs(digest) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,digest)
);
CREATE TABLE body_attachment_refs (
  sender_account_id uuid NOT NULL,
  body_digest bytea NOT NULL,
  digest bytea NOT NULL REFERENCES attachment_blobs(digest) ON DELETE RESTRICT,
  PRIMARY KEY(sender_account_id,body_digest,digest),
  FOREIGN KEY(body_digest,sender_account_id) REFERENCES detached_bodies(digest,sender_account_id) ON DELETE CASCADE
);
CREATE TABLE received_attachment_refs (
  recipient_did text NOT NULL,
  sender_did text NOT NULL,
  body_digest bytea NOT NULL,
  media_type text NOT NULL,
  profile text NOT NULL,
  digest bytea NOT NULL REFERENCES attachment_blobs(digest) ON DELETE RESTRICT,
  PRIMARY KEY(recipient_did,sender_did,body_digest,media_type,profile,digest),
  FOREIGN KEY(recipient_did,sender_did,body_digest,media_type,profile)
    REFERENCES verified_body_provenance(recipient_did,sender_did,digest,media_type,profile) ON DELETE CASCADE
);
CREATE TRIGGER hail_fence_attachment_uploads BEFORE INSERT OR UPDATE OR DELETE ON attachment_uploads
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account','account_id');
CREATE TRIGGER hail_fence_body_attachments BEFORE INSERT OR UPDATE OR DELETE ON body_attachment_refs
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account','sender_account_id');
CREATE TRIGGER hail_fence_received_attachments BEFORE INSERT OR UPDATE OR DELETE ON received_attachment_refs
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('did','recipient_did');

CREATE INDEX attachment_uploads_digest ON attachment_uploads(digest);
CREATE INDEX body_attachment_refs_digest ON body_attachment_refs(digest);
CREATE INDEX received_attachment_refs_digest ON received_attachment_refs(digest);
