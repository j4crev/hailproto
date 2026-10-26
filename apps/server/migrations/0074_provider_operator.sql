-- Local operational authority: never exported with a user's portable account.
CREATE TABLE provider_operators (
  account_id uuid PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  serving_generation bigint NOT NULL CHECK (serving_generation>0),
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE provider_signup_invitations (
  id uuid PRIMARY KEY,
  operator_account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  email text CHECK (length(email) BETWEEN 3 AND 254),
  issued_at bigint NOT NULL,
  email_accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX provider_signup_invitations_created ON provider_signup_invitations(created_at DESC);
