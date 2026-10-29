-- Expand approval ownership without changing any existing browser approval.
ALTER TABLE connection_approvals
  ALTER COLUMN session_id DROP NOT NULL,
  ADD COLUMN api_credential_id uuid REFERENCES account_api_credentials(id) ON DELETE RESTRICT,
  ADD CONSTRAINT connection_approval_access CHECK (
    (session_id IS NOT NULL AND api_credential_id IS NULL) OR
    (session_id IS NULL AND api_credential_id IS NOT NULL AND action IN ('create','connect') AND owner_payload IS NOT NULL AND credential_id IS NULL)
  );
