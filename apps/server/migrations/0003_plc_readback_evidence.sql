ALTER TABLE plc_operation_evidence
  ADD COLUMN verified_document jsonb,
  ADD COLUMN verified_data jsonb,
  ADD COLUMN verified_log jsonb,
  ADD COLUMN verified_audit jsonb;
