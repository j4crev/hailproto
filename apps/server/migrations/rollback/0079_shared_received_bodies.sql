-- Stop application processes first. Requires capacity for one copy per provenance row.
BEGIN;
LOCK TABLE verified_body_provenance, shared_content_blobs IN ACCESS EXCLUSIVE MODE;
DROP TRIGGER hail_store_received_body ON verified_body_provenance;
ALTER TABLE verified_body_provenance DROP CONSTRAINT verified_body_bytes_external;
ALTER TABLE verified_body_provenance DISABLE TRIGGER hail_fence_verified_bodies;
UPDATE verified_body_provenance p SET body_bytes = b.body_bytes FROM shared_content_blobs b WHERE b.digest = p.digest;
ALTER TABLE verified_body_provenance ENABLE TRIGGER hail_fence_verified_bodies;
ALTER TABLE verified_body_provenance ALTER COLUMN body_bytes SET NOT NULL;
ALTER TABLE verified_body_provenance DROP CONSTRAINT verified_body_blob_fk;
DROP INDEX verified_body_provenance_digest_idx;
DROP VIEW verified_body_contents;
DROP FUNCTION hail_store_received_body();
DROP FUNCTION hail_collect_received_blobs(integer);
DROP TABLE shared_content_blobs;
DELETE FROM schema_migrations WHERE version = 79;
COMMIT;
