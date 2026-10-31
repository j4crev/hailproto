DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM conversation_descriptors) OR EXISTS(SELECT 1 FROM conversation_memberships) THEN
    RAISE EXCEPTION 'Retained conversation authority prevents rollback';
  END IF;
END $$;
DROP TABLE conversation_revival_receipts;
DROP TABLE conversation_memberships;
DROP TABLE conversation_descriptors;
