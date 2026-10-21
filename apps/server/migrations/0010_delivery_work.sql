CREATE TABLE delivery_work (
  sender_did text NOT NULL,
  message_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'accepted'
    CHECK (state IN ('accepted', 'on-hold', 'delivered', 'failed', 'cancelled')),
  reason text,
  status_revision integer NOT NULL DEFAULT 1 CHECK (status_revision > 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  transitioned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sender_did, message_id),
  FOREIGN KEY (sender_did, message_id)
    REFERENCES received_envelopes(sender_did, message_id) ON DELETE RESTRICT,
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((state = 'on-hold' OR state = 'failed' OR state = 'cancelled') = (reason IS NOT NULL))
);

CREATE INDEX delivery_work_due_idx ON delivery_work (next_attempt_at, lease_expires_at)
  WHERE state IN ('accepted', 'on-hold');

CREATE TABLE verified_body_provenance (
  recipient_did text NOT NULL,
  sender_did text NOT NULL,
  digest bytea NOT NULL CHECK (octet_length(digest) = 32),
  media_type text NOT NULL CHECK (media_type = 'application/hail-body+cbor'),
  profile text NOT NULL CHECK (profile = 'spt-1'),
  body_bytes bytea NOT NULL CHECK (octet_length(body_bytes) BETWEEN 1 AND 262144),
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recipient_did, sender_did, digest, media_type, profile)
);

CREATE TABLE delivered_messages (
  recipient_did text NOT NULL,
  sender_did text NOT NULL,
  message_id uuid NOT NULL,
  envelope_digest bytea NOT NULL CHECK (octet_length(envelope_digest) = 32),
  body_digest bytea NOT NULL CHECK (octet_length(body_digest) = 32),
  media_type text NOT NULL DEFAULT 'application/hail-body+cbor',
  profile text NOT NULL DEFAULT 'spt-1',
  delivered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sender_did, message_id),
  FOREIGN KEY (sender_did, message_id)
    REFERENCES received_envelopes(sender_did, message_id) ON DELETE RESTRICT,
  FOREIGN KEY (recipient_did, sender_did, body_digest, media_type, profile)
    REFERENCES verified_body_provenance(recipient_did, sender_did, digest, media_type, profile) ON DELETE RESTRICT
);

INSERT INTO delivery_work (sender_did, message_id, state, next_attempt_at)
SELECT sender_did, message_id, 'accepted', now() FROM received_envelopes WHERE outcome = 'accepted';
