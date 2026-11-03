CREATE TABLE account_message_drafts (
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object' AND octet_length(content::text) <= 400000),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  trashed_at timestamptz,
  PRIMARY KEY(account_id,id)
);
CREATE TRIGGER hail_fence_message_drafts BEFORE INSERT OR UPDATE OR DELETE ON account_message_drafts
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account','account_id');
