CREATE TABLE sender_profiles (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  did text NOT NULL,
  revision integer NOT NULL,
  profile_payload jsonb NOT NULL,
  cose bytea NOT NULL,
  representation_digest bytea NOT NULL,
  signing_public_key text NOT NULL,
  profile_updated_at bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, revision),
  UNIQUE (did, revision),
  UNIQUE (account_id, representation_digest),
  CONSTRAINT sender_profiles_did_syntax
    CHECK (did ~ '^did:plc:[a-z2-7]{24}$'),
  CONSTRAINT sender_profiles_revision
    CHECK (revision > 0),
  CONSTRAINT sender_profiles_updated_at
    CHECK (profile_updated_at >= 0),
  CONSTRAINT sender_profiles_digest_size
    CHECK (octet_length(representation_digest) = 32),
  CONSTRAINT sender_profiles_representation_size
    CHECK (octet_length(cose) BETWEEN 1 AND 65536)
);

CREATE INDEX sender_profiles_current_idx
  ON sender_profiles (did, revision DESC);

CREATE TABLE verified_sender_profiles (
  id uuid PRIMARY KEY,
  did text NOT NULL,
  revision integer NOT NULL,
  profile_updated_at bigint NOT NULL,
  profile_payload jsonb NOT NULL,
  cose bytea NOT NULL,
  representation_digest bytea NOT NULL,
  service_base text NOT NULL,
  messaging_public_key text NOT NULL,
  plc_document jsonb NOT NULL,
  plc_data jsonb NOT NULL,
  plc_operation_log jsonb NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (did, revision),
  CONSTRAINT verified_sender_profiles_did_syntax
    CHECK (did ~ '^did:plc:[a-z2-7]{24}$'),
  CONSTRAINT verified_sender_profiles_revision
    CHECK (revision > 0),
  CONSTRAINT verified_sender_profiles_updated_at
    CHECK (profile_updated_at >= 0),
  CONSTRAINT verified_sender_profiles_digest_size
    CHECK (octet_length(representation_digest) = 32),
  CONSTRAINT verified_sender_profiles_representation_size
    CHECK (octet_length(cose) BETWEEN 1 AND 65536)
);

CREATE INDEX verified_sender_profiles_current_idx
  ON verified_sender_profiles (did, revision DESC);
