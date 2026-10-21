CREATE TABLE sent_envelopes (
  sender_did text NOT NULL,
  message_id uuid NOT NULL,
  recipient_did text NOT NULL,
  grant_id uuid NOT NULL,
  envelope_cose bytea NOT NULL CHECK (octet_length(envelope_cose) BETWEEN 1 AND 16384),
  envelope_digest bytea NOT NULL CHECK (octet_length(envelope_digest) = 32),
  body_digest bytea NOT NULL CHECK (octet_length(body_digest) = 32),
  sender_account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sender_did, message_id),
  FOREIGN KEY (body_digest, sender_account_id) REFERENCES detached_bodies(digest, sender_account_id) ON DELETE RESTRICT
);

CREATE TABLE received_envelopes (
  sender_did text NOT NULL,
  message_id uuid NOT NULL,
  recipient_did text NOT NULL,
  grant_id uuid NOT NULL REFERENCES grant_lineages(grant_id) ON DELETE RESTRICT,
  local_account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  envelope_cose bytea NOT NULL CHECK (octet_length(envelope_cose) BETWEEN 1 AND 16384),
  envelope_digest bytea NOT NULL CHECK (octet_length(envelope_digest) = 32),
  payload_digest bytea NOT NULL CHECK (octet_length(payload_digest) = 32),
  signing_public_key text NOT NULL,
  signing_plc_document jsonb NOT NULL,
  signing_plc_data jsonb NOT NULL,
  signing_plc_operation_log jsonb NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'unauthorized', 'message-expired')),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sender_did, message_id),
  CHECK ((outcome = 'accepted') = (accepted_at IS NOT NULL))
);

CREATE INDEX received_envelopes_work_idx ON received_envelopes (accepted_at) WHERE outcome = 'accepted';
