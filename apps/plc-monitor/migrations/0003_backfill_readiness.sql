-- Expand only: old cursor/history/alert/approval rows stay unchanged.
-- A migrated monitor must prove catch-up again rather than infer it from time.
ALTER TABLE monitor_cursor ADD COLUMN caught_up boolean NOT NULL DEFAULT false;

-- Existing enrollments are not silently relabeled as reviewed bootstraps.
-- Preserve the original checkpoint even when expected_state later changes.
CREATE TABLE monitor_bootstrap_checkpoints (
  did text PRIMARY KEY REFERENCES monitored_dids(did) ON DELETE RESTRICT,
  operation_cid text NOT NULL,
  reviewed_state jsonb NOT NULL,
  reviewed_at timestamptz NOT NULL
);
