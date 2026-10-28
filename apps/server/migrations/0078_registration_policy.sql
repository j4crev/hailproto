CREATE TABLE provider_registration_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode text NOT NULL DEFAULT 'invite' CHECK (mode IN ('invite','public'))
);
INSERT INTO provider_registration_settings(singleton) VALUES(true);
CREATE TABLE provider_registration_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operator_account_id uuid NOT NULL REFERENCES provider_accounts(id),
  previous_mode text NOT NULL CHECK (previous_mode IN ('invite','public')),
  mode text NOT NULL CHECK (mode IN ('invite','public')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE provider_signup_admissions (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash)=32),
  channel text NOT NULL CHECK (channel IN ('browser','cli')),
  request_digest bytea NOT NULL CHECK (octet_length(request_digest)=32),
  invitation_id uuid UNIQUE,
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '24 hours')
);
-- Retain consumed invitations and existing browser setup authority across rollout.
INSERT INTO provider_signup_admissions(token_hash,channel,request_digest,invitation_id,expires_at)
  SELECT token_hash,'browser',request_digest,invitation_id,expires_at FROM account_signup_ceremonies;
ALTER TABLE account_signup_ceremonies ALTER COLUMN invitation_id DROP NOT NULL;
