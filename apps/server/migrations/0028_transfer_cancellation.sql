-- A source-issued receipt irrevocably rejects this grant before any fence.
-- The target may release even a submitted (ambiguous) reservation only with
-- that authenticated receipt; elapsed time alone cannot prove no fence.
ALTER TABLE provider_transfer_authorizations
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancellation_bytes bytea,
  ADD COLUMN cancellation_signature bytea,
  ADD COLUMN cancellation_receipt_bytes bytea,
  ADD COLUMN cancellation_receipt_signature bytea,
  ADD CONSTRAINT hail_transfer_cancel_complete CHECK (
    (cancelled_at IS NULL AND cancellation_bytes IS NULL AND cancellation_signature IS NULL AND
     cancellation_receipt_bytes IS NULL AND cancellation_receipt_signature IS NULL)
    OR (cancelled_at IS NOT NULL AND cancellation_bytes IS NOT NULL AND cancellation_signature IS NOT NULL AND
        cancellation_receipt_bytes IS NOT NULL AND cancellation_receipt_signature IS NOT NULL)
  );

CREATE TABLE cancelled_transfer_sessions (
  did text NOT NULL CHECK (did ~ '^did:plc:[a-z2-7]{24}$'),
  nonce uuid NOT NULL,
  grant_digest bytea NOT NULL CHECK (octet_length(grant_digest) = 32),
  receipt_digest bytea NOT NULL CHECK (octet_length(receipt_digest) = 32),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (did, nonce)
);
