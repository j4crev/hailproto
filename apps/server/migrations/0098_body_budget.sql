-- Expand body storage without rewriting retained bytes. Deploy matching readers/writers together.
ALTER TABLE detached_bodies DROP CONSTRAINT detached_bodies_body_bytes_check;
ALTER TABLE detached_bodies ADD CONSTRAINT detached_bodies_body_bytes_check CHECK (octet_length(body_bytes) BETWEEN 1 AND 1048576);
ALTER TABLE verified_body_provenance DROP CONSTRAINT verified_body_provenance_body_bytes_check;
ALTER TABLE verified_body_provenance ADD CONSTRAINT verified_body_provenance_body_bytes_check CHECK (octet_length(body_bytes) BETWEEN 1 AND 1048576);
ALTER TABLE account_publications DROP CONSTRAINT account_publications_body_bytes_check;
ALTER TABLE account_publications ADD CONSTRAINT account_publications_body_bytes_check CHECK (octet_length(body_bytes) BETWEEN 1 AND 1048576);
ALTER TABLE connection_message_batches DROP CONSTRAINT connection_message_batches_body_bytes_check;
ALTER TABLE connection_message_batches ADD CONSTRAINT connection_message_batches_body_bytes_check CHECK (octet_length(body_bytes) BETWEEN 1 AND 1048576);
ALTER TABLE shared_content_blobs ADD CONSTRAINT shared_content_blobs_body_size_check CHECK (octet_length(body_bytes) BETWEEN 1 AND 1048576);
CREATE OR REPLACE FUNCTION hail_store_received_body() RETURNS trigger AS $$
BEGIN
  -- Never use global presence as proof that this recipient obtained the bytes.
  IF NEW.body_bytes IS NULL THEN
    RAISE EXCEPTION 'Verified body writes require independently verified bytes';
  END IF;
  IF octet_length(NEW.body_bytes) NOT BETWEEN 1 AND 1048576 OR sha256(NEW.body_bytes) <> NEW.digest THEN
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
