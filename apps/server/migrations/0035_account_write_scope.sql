-- Add account mutation authority without upgrading existing credentials.
ALTER TABLE account_api_credentials DROP CONSTRAINT account_api_credentials_scopes_check;
ALTER TABLE account_api_credentials ADD CONSTRAINT account_api_credentials_scopes_check CHECK (
  jsonb_typeof(scopes)='array' AND jsonb_array_length(scopes) BETWEEN 1 AND 7
  AND scopes <@ '["account:read","grants:read","grants:write","credentials:write","messages:read","messages:write","account:write"]'::jsonb);
