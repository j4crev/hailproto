-- Coordinated upgrade: stop old application processes before applying this migration.
-- Keep the byte column as an import/write interface; only shared_content_blobs retains bytes.
CREATE TABLE shared_content_blobs (
  digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
  body_bytes bytea NOT NULL,
  byte_size bigint GENERATED ALWAYS AS (octet_length(body_bytes)) STORED,
  CHECK (sha256(body_bytes) = digest)
);

INSERT INTO shared_content_blobs (digest, body_bytes)
SELECT DISTINCT digest, body_bytes FROM verified_body_provenance;

ALTER TABLE verified_body_provenance ALTER COLUMN body_bytes DROP NOT NULL;
ALTER TABLE verified_body_provenance ADD CONSTRAINT verified_body_blob_fk
  FOREIGN KEY (digest) REFERENCES shared_content_blobs(digest) ON DELETE RESTRICT;
CREATE INDEX verified_body_provenance_digest_idx ON verified_body_provenance(digest);
-- This is a representation change, including for fenced accounts; no ownership changes.
ALTER TABLE verified_body_provenance DISABLE TRIGGER hail_fence_verified_bodies;
UPDATE verified_body_provenance SET body_bytes = NULL;
ALTER TABLE verified_body_provenance ENABLE TRIGGER hail_fence_verified_bodies;
ALTER TABLE verified_body_provenance ADD CONSTRAINT verified_body_bytes_external CHECK (body_bytes IS NULL);

CREATE FUNCTION hail_store_received_body() RETURNS trigger AS $$
BEGIN
  -- Never use global presence as proof that this recipient obtained the bytes.
  IF NEW.body_bytes IS NULL THEN
    RAISE EXCEPTION 'Verified body writes require independently verified bytes';
  END IF;
  IF octet_length(NEW.body_bytes) NOT BETWEEN 1 AND 262144 OR sha256(NEW.body_bytes) <> NEW.digest THEN
    RAISE EXCEPTION 'Verified body size or digest mismatch';
  END IF;
  INSERT INTO shared_content_blobs (digest, body_bytes) VALUES (NEW.digest, NEW.body_bytes)
    ON CONFLICT (digest) DO UPDATE SET digest = EXCLUDED.digest
    WHERE shared_content_blobs.body_bytes = EXCLUDED.body_bytes;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shared body conflicts with exact bytes'; END IF;
  -- The upsert holds the blob lock until the recipient reference commits, excluding GC.
  NEW.body_bytes := NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hail_store_received_body BEFORE INSERT OR UPDATE ON verified_body_provenance
  FOR EACH ROW EXECUTE FUNCTION hail_store_received_body();

-- Same portable row shape as before; exports remain self-contained and importable on old providers.
CREATE VIEW verified_body_contents AS
SELECT p.recipient_did, p.sender_did, p.digest, p.media_type, p.profile, b.body_bytes, p.verified_at
FROM verified_body_provenance p JOIN shared_content_blobs b USING (digest);

CREATE FUNCTION hail_collect_received_blobs(batch_size integer DEFAULT 500) RETURNS integer AS $$
DECLARE candidate bytea; removed integer := 0;
BEGIN
  IF batch_size < 1 OR batch_size > 5000 THEN RAISE EXCEPTION 'Invalid blob collection batch size'; END IF;
  FOR candidate IN
    SELECT b.digest FROM shared_content_blobs b
    WHERE NOT EXISTS (SELECT 1 FROM verified_body_provenance p WHERE p.digest = b.digest)
    ORDER BY b.digest LIMIT batch_size FOR UPDATE OF b SKIP LOCKED
  LOOP
    -- A separate statement rechecks references after taking the lock. The FK is also a safety net.
    DELETE FROM shared_content_blobs b WHERE b.digest = candidate
      AND NOT EXISTS (SELECT 1 FROM verified_body_provenance p WHERE p.digest = b.digest);
    IF FOUND THEN removed := removed + 1; END IF;
  END LOOP;
  RETURN removed;
END;
$$ LANGUAGE plpgsql;
