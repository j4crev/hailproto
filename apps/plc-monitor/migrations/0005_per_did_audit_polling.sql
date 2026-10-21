-- Expand first: legacy global cursor/evidence remains readable during rollout.
ALTER TABLE monitored_dids ADD COLUMN last_audit jsonb;
ALTER TABLE monitored_dids ADD COLUMN coverage_since timestamptz;
ALTER TABLE monitored_dids ADD COLUMN last_polled_at timestamptz;
ALTER TABLE monitored_dids ADD COLUMN poll_ready boolean NOT NULL DEFAULT false;

ALTER TABLE monitor_observations ALTER COLUMN seq DROP NOT NULL;
ALTER TABLE monitor_observations DROP CONSTRAINT monitor_observations_seq_key;
