-- Cosmetic, recipient-local state for the existing authenticated handover.
-- Not authorization/replay state: expiry or loss cannot change a relationship.
-- Deliberately not included in migration snapshots. A move of the observer's own
-- account may discard this temporary notice; generation binding prevents revival.
CREATE TABLE connection_address_notices (
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  serving_generation bigint NOT NULL CHECK(serving_generation>0),
  peer_did text NOT NULL,
  connection_id uuid NOT NULL,
  transfer_id uuid NOT NULL,
  previous_address text NOT NULL,
  address text NOT NULL CHECK(address<>previous_address),
  completed_at timestamptz,
  PRIMARY KEY(account_id,peer_did)
);
CREATE TRIGGER hail_fence_connection_address_notices BEFORE INSERT OR UPDATE OR DELETE ON connection_address_notices
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account','account_id');
