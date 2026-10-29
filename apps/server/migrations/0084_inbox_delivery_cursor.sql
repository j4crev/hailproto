-- Serialize sequence allocation per recipient until commit, including old writers.
-- A plain sequence alone could skip a delivery whose transaction commits late.
CREATE SEQUENCE inbox_delivery_sequence;
ALTER TABLE delivered_messages ADD COLUMN delivery_sequence bigint;
UPDATE delivered_messages SET delivery_sequence=nextval('inbox_delivery_sequence');
CREATE FUNCTION hail_assign_delivery_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.recipient_did, 842184));
  NEW.delivery_sequence := nextval('inbox_delivery_sequence');
  RETURN NEW;
END $$;
CREATE TRIGGER assign_delivery_sequence BEFORE INSERT ON delivered_messages
FOR EACH ROW EXECUTE FUNCTION hail_assign_delivery_sequence();
ALTER TABLE delivered_messages ALTER COLUMN delivery_sequence SET NOT NULL;
CREATE UNIQUE INDEX delivered_messages_sequence ON delivered_messages(recipient_did,delivery_sequence);
