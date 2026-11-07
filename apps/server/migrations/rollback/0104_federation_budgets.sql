DROP TABLE delivery_scheduling;
DROP INDEX received_recipient_budget;
DROP INDEX received_rejection_budget;
DROP TRIGGER hail_account_envelope_bytes ON received_envelopes;
DROP FUNCTION hail_account_envelope_bytes();
ALTER TABLE received_envelopes DROP COLUMN admission_bytes;
