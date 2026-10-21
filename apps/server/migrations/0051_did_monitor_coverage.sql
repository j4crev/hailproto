-- Per-DID monitor attestations do not claim a global PLC export position.
ALTER TABLE public_onboarding_evidence ALTER COLUMN monitor_export_sequence DROP NOT NULL;
