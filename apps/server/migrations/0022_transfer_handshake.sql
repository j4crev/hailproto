-- One active user authorization per DID. It remains separate from messaging Grants.
CREATE TABLE provider_transfer_authorizations (
  did text PRIMARY KEY CHECK (did ~ '^did:plc:[a-z2-7]{24}$'),
  nonce uuid NOT NULL UNIQUE,
  destination_service_base text NOT NULL,
  expires_at timestamptz NOT NULL,
  grant_bytes bytea NOT NULL,
  grant_signature bytea NOT NULL,
  invitation_bytes bytea NOT NULL,
  invitation_signature bytea NOT NULL,
  consumed_transfer_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
