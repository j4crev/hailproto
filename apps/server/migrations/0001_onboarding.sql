CREATE TABLE provider_accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL UNIQUE,
  canonical_address text NOT NULL UNIQUE,
  did text UNIQUE,
  onboarding_state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_accounts_address_lowercase
    CHECK (canonical_address = lower(canonical_address)),
  CONSTRAINT provider_accounts_did_syntax
    CHECK (did IS NULL OR did ~ '^did:plc:[a-z2-7]{24}$'),
  CONSTRAINT provider_accounts_onboarding_state
    CHECK (onboarding_state IN (
      'reserved',
      'prepared',
      'submission-unknown',
      'did-registered',
      'address-staged',
      'active'
    ))
);

CREATE TABLE account_keys (
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  role text NOT NULL,
  algorithm text NOT NULL,
  public_key text NOT NULL,
  encrypted_private_key bytea NOT NULL,
  encryption_nonce bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, role),
  CONSTRAINT account_keys_role
    CHECK (role IN ('plc-rotation', 'hail-identity', 'hail-messaging')),
  CONSTRAINT account_keys_algorithm
    CHECK (algorithm IN ('p256', 'secp256k1', 'ed25519')),
  CONSTRAINT account_keys_role_algorithm
    CHECK (
      (role = 'plc-rotation' AND algorithm IN ('p256', 'secp256k1')) OR
      (role IN ('hail-identity', 'hail-messaging') AND algorithm = 'ed25519')
    )
);

CREATE TABLE plc_operation_evidence (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  did text NOT NULL,
  operation_cid text NOT NULL,
  previous_cid text,
  registry_origin text NOT NULL,
  signed_operation jsonb NOT NULL,
  dag_cbor bytea NOT NULL,
  submission_state text NOT NULL,
  submitted_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (did, operation_cid),
  CONSTRAINT plc_operation_evidence_did_syntax
    CHECK (did ~ '^did:plc:[a-z2-7]{24}$'),
  CONSTRAINT plc_operation_evidence_submission_state
    CHECK (submission_state IN ('prepared', 'submission-unknown', 'submitted', 'verified'))
);

CREATE TABLE address_bindings (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  canonical_address text NOT NULL,
  did text NOT NULL,
  cose bytea NOT NULL,
  representation_digest bytea NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, representation_digest),
  CONSTRAINT address_bindings_address_lowercase
    CHECK (canonical_address = lower(canonical_address)),
  CONSTRAINT address_bindings_did_syntax
    CHECK (did ~ '^did:plc:[a-z2-7]{24}$'),
  CONSTRAINT address_bindings_digest_size
    CHECK (octet_length(representation_digest) = 32),
  CONSTRAINT address_bindings_lifetime
    CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '90 days')
);

CREATE INDEX plc_operation_evidence_account_created_idx
  ON plc_operation_evidence (account_id, created_at);

CREATE INDEX address_bindings_account_expires_idx
  ON address_bindings (account_id, expires_at DESC);
