-- Local, explicit introduction policy only. This does not authorize group delivery.
CREATE TABLE account_conversation_preferences (
  account_id uuid PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  allow_introductions boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE connection_conversation_preferences (
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  connection_id uuid NOT NULL,
  epoch bigint NOT NULL CHECK(epoch > 0),
  allow_introductions boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id, connection_id, epoch)
);
CREATE TRIGGER hail_fence_account_conversation_preferences BEFORE INSERT OR UPDATE OR DELETE ON account_conversation_preferences
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account', 'account_id');
CREATE TRIGGER hail_fence_connection_conversation_preferences BEFORE INSERT OR UPDATE OR DELETE ON connection_conversation_preferences
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account', 'account_id');
