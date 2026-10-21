CREATE TABLE grant_lineages (
  grant_id uuid PRIMARY KEY,
  local_account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  local_role text NOT NULL,
  grantor_did text NOT NULL,
  grantee_did text NOT NULL,
  current_revision integer NOT NULL,
  current_digest bytea NOT NULL,
  current_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grant_lineages_uuid_v7
    CHECK (grant_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT grant_lineages_local_role
    CHECK (local_role IN ('grantor', 'grantee')),
  CONSTRAINT grant_lineages_distinct_parties
    CHECK (grantor_did <> grantee_did),
  CONSTRAINT grant_lineages_grantor_syntax
    CHECK (grantor_did ~ '^did:plc:[a-z2-7]{24}$'),
  CONSTRAINT grant_lineages_grantee_syntax
    CHECK (grantee_did ~ '^did:plc:[a-z2-7]{24}$'),
  CONSTRAINT grant_lineages_revision
    CHECK (current_revision > 0),
  CONSTRAINT grant_lineages_digest_size
    CHECK (octet_length(current_digest) = 32),
  CONSTRAINT grant_lineages_status
    CHECK (current_status IN ('active', 'revoked'))
);

CREATE UNIQUE INDEX grant_lineages_one_active_pair_idx
  ON grant_lineages (grantor_did, grantee_did)
  WHERE current_status = 'active';

CREATE INDEX grant_lineages_local_account_idx
  ON grant_lineages (local_account_id, local_role, updated_at DESC);

CREATE TABLE grant_revisions (
  grant_id uuid NOT NULL REFERENCES grant_lineages(grant_id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  status text NOT NULL,
  issued_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  expires_at bigint,
  previous_digest bytea,
  scope_payload jsonb NOT NULL,
  consent_address_binding_sha256 bytea NOT NULL,
  consent_sender_profile_sha256 bytea NOT NULL,
  cose bytea NOT NULL,
  representation_digest bytea NOT NULL,
  signing_public_key text NOT NULL,
  signing_plc_document jsonb NOT NULL,
  signing_plc_data jsonb NOT NULL,
  signing_plc_operation_log jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (grant_id, revision),
  UNIQUE (grant_id, representation_digest),
  CONSTRAINT grant_revisions_status
    CHECK (status IN ('active', 'revoked')),
  CONSTRAINT grant_revisions_revision
    CHECK (revision > 0),
  CONSTRAINT grant_revisions_timestamps
    CHECK (issued_at >= 0 AND updated_at >= issued_at AND (expires_at IS NULL OR expires_at >= issued_at)),
  CONSTRAINT grant_revisions_previous
    CHECK ((revision = 1 AND previous_digest IS NULL) OR
           (revision > 1 AND octet_length(previous_digest) = 32)),
  CONSTRAINT grant_revisions_consent_digest_sizes
    CHECK (octet_length(consent_address_binding_sha256) = 32 AND
           octet_length(consent_sender_profile_sha256) = 32),
  CONSTRAINT grant_revisions_digest_size
    CHECK (octet_length(representation_digest) = 32),
  CONSTRAINT grant_revisions_representation_size
    CHECK (octet_length(cose) BETWEEN 1 AND 262144)
);

CREATE TABLE grant_consent_evidence (
  grant_id uuid NOT NULL,
  revision integer NOT NULL,
  grantee_address text NOT NULL,
  binding_cose bytea NOT NULL,
  binding_digest bytea NOT NULL,
  binding_plc_document jsonb NOT NULL,
  binding_plc_data jsonb NOT NULL,
  binding_plc_operation_log jsonb NOT NULL,
  binding_verified_at timestamptz NOT NULL,
  profile_revision integer NOT NULL,
  profile_cose bytea NOT NULL,
  profile_digest bytea NOT NULL,
  profile_plc_document jsonb NOT NULL,
  profile_plc_data jsonb NOT NULL,
  profile_plc_operation_log jsonb NOT NULL,
  profile_verified_at timestamptz NOT NULL,
  retained_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (grant_id, revision),
  FOREIGN KEY (grant_id, revision)
    REFERENCES grant_revisions(grant_id, revision) ON DELETE RESTRICT,
  CONSTRAINT grant_consent_evidence_address_lowercase
    CHECK (grantee_address = lower(grantee_address)),
  CONSTRAINT grant_consent_evidence_digests
    CHECK (octet_length(binding_digest) = 32 AND octet_length(profile_digest) = 32),
  CONSTRAINT grant_consent_evidence_profile_revision
    CHECK (profile_revision > 0)
);

CREATE TABLE grant_publications (
  grant_id uuid NOT NULL,
  revision integer NOT NULL,
  destination_service_base text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_http_status integer,
  last_error text,
  acknowledged_etag text,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (grant_id, revision),
  FOREIGN KEY (grant_id, revision)
    REFERENCES grant_revisions(grant_id, revision) ON DELETE RESTRICT,
  CONSTRAINT grant_publications_state
    CHECK (state IN ('pending', 'retry', 'acknowledged', 'blocked')),
  CONSTRAINT grant_publications_attempt_count
    CHECK (attempt_count >= 0),
  CONSTRAINT grant_publications_lease
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT grant_publications_http_status
    CHECK (last_http_status IS NULL OR last_http_status BETWEEN 100 AND 599)
);

CREATE INDEX grant_publications_due_idx
  ON grant_publications (next_attempt_at, created_at)
  WHERE state IN ('pending', 'retry');
