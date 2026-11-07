-- Keep derived accounting out of portable/managed history representations.
-- A BEFORE trigger also computes it for whole-row legacy import statements.
ALTER TABLE received_envelopes ADD COLUMN admission_bytes bigint NOT NULL DEFAULT 0;
CREATE FUNCTION hail_account_envelope_bytes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.admission_bytes := octet_length(NEW.envelope_cose)
    + octet_length(NEW.signing_plc_document::text)
    + octet_length(NEW.signing_plc_data::text)
    + octet_length(NEW.signing_plc_operation_log::text);
  RETURN NEW;
END $$;
CREATE TRIGGER hail_account_envelope_bytes BEFORE INSERT OR UPDATE ON received_envelopes
  FOR EACH ROW EXECUTE FUNCTION hail_account_envelope_bytes();
-- Historical accounts may be migration-fenced. Backfill only derived accounting
-- under the migration table lock; application fence/generation checks resume
-- before this transaction commits. No signed or protocol-state bytes change.
ALTER TABLE received_envelopes DISABLE TRIGGER USER;
UPDATE received_envelopes SET admission_bytes = octet_length(envelope_cose)
  + octet_length(signing_plc_document::text) + octet_length(signing_plc_data::text)
  + octet_length(signing_plc_operation_log::text);
ALTER TABLE received_envelopes ENABLE TRIGGER USER;
CREATE INDEX received_rejection_budget ON received_envelopes(sender_did)
  INCLUDE(admission_bytes) WHERE outcome <> 'accepted';
CREATE INDEX received_recipient_budget ON received_envelopes(recipient_did,sender_did,message_id);
CREATE TABLE delivery_scheduling (
  scope text NOT NULL CHECK(scope IN ('sender','recipient')),
  did text NOT NULL,
  last_attempt_at timestamptz NOT NULL,
  PRIMARY KEY(scope,did)
);
