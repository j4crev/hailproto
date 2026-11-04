DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM body_attachment_refs) OR EXISTS(SELECT 1 FROM received_attachment_refs) THEN
    RAISE EXCEPTION 'Cannot roll back while messages retain attachments';
  END IF;
END $$;
DROP TABLE received_attachment_refs, body_attachment_refs, attachment_uploads, attachment_blobs;
