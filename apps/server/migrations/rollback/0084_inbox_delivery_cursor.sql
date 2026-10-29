-- Roll back application consumers first; retained wait cursors become invalid.
DROP TRIGGER assign_delivery_sequence ON delivered_messages;
DROP FUNCTION hail_assign_delivery_sequence();
ALTER TABLE delivered_messages DROP COLUMN delivery_sequence;
DROP SEQUENCE inbox_delivery_sequence;
