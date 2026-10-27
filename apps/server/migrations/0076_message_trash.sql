ALTER TABLE delivered_messages ADD COLUMN trashed_at timestamptz;
CREATE INDEX delivered_messages_trash_expiry ON delivered_messages (trashed_at,recipient_did) WHERE trashed_at IS NOT NULL;
CREATE TABLE account_message_preferences (
  account_id uuid PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  trash_enabled boolean NOT NULL DEFAULT true
);
CREATE TRIGGER hail_fence_message_preferences BEFORE INSERT OR UPDATE OR DELETE ON account_message_preferences
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account', 'account_id');
