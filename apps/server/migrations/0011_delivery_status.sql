CREATE TABLE delivery_status_payloads (
  sender_did text NOT NULL,
  message_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  payload_bytes bytea NOT NULL CHECK (octet_length(payload_bytes) BETWEEN 1 AND 16384),
  PRIMARY KEY (sender_did, message_id, revision),
  FOREIGN KEY (sender_did, message_id) REFERENCES received_envelopes(sender_did, message_id) ON DELETE RESTRICT
);

CREATE TABLE delivery_status_wrappers (
  sender_did text NOT NULL,
  message_id uuid NOT NULL,
  revision integer NOT NULL,
  signing_public_key text NOT NULL,
  cose bytea NOT NULL CHECK (octet_length(cose) BETWEEN 1 AND 16384),
  signing_plc_document jsonb NOT NULL,
  signing_plc_data jsonb NOT NULL,
  signing_plc_operation_log jsonb NOT NULL,
  signed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sender_did, message_id, revision, signing_public_key),
  FOREIGN KEY (sender_did, message_id, revision)
    REFERENCES delivery_status_payloads(sender_did, message_id, revision) ON DELETE RESTRICT
);

CREATE TABLE terminal_status_publications (
  sender_did text NOT NULL,
  message_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'retry', 'acknowledged', 'blocked')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_http_status integer,
  last_error text,
  acknowledged_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sender_did, message_id),
  FOREIGN KEY (sender_did, message_id) REFERENCES delivery_work(sender_did, message_id) ON DELETE RESTRICT,
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX terminal_status_due_idx ON terminal_status_publications(next_attempt_at)
  WHERE state IN ('pending', 'retry');

INSERT INTO terminal_status_publications (sender_did, message_id)
SELECT sender_did, message_id FROM delivery_work WHERE state IN ('delivered', 'failed', 'cancelled');

CREATE TABLE sent_delivery_status (
  sender_did text NOT NULL,
  message_id uuid NOT NULL,
  recipient_did text NOT NULL,
  current_revision integer NOT NULL CHECK (current_revision > 0),
  current_state text NOT NULL CHECK (current_state IN ('accepted', 'on-hold', 'delivered', 'failed', 'cancelled')),
  payload_bytes bytea NOT NULL,
  cose bytea NOT NULL,
  signing_public_key text NOT NULL,
  signing_plc_document jsonb NOT NULL,
  signing_plc_data jsonb NOT NULL,
  signing_plc_operation_log jsonb NOT NULL,
  revision_gap integer NOT NULL DEFAULT 0 CHECK (revision_gap >= 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sender_did, message_id),
  FOREIGN KEY (sender_did, message_id) REFERENCES sent_envelopes(sender_did, message_id) ON DELETE RESTRICT
);
