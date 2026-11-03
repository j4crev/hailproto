-- Mailbox disposition is local presentation state. Retained publication intent,
-- signed envelopes, delivery evidence and reply authority are never deleted here.
CREATE TABLE account_sent_dispositions (
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('category','connections','message')),
  send_id uuid NOT NULL,
  trashed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY(account_id,kind,send_id)
);
CREATE TRIGGER hail_fence_sent_dispositions BEFORE INSERT OR UPDATE OR DELETE ON account_sent_dispositions
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account','account_id');

CREATE VIEW account_sent_members AS
  SELECT t.account_id,'category'::text AS kind,t.publication_id AS send_id,t.message_id,
    e.message_id IS NOT NULL AS submitted,
    t.state IN ('blocked','cancelled','expired') OR
      (t.state='submitted' AND s.current_state IN ('delivered','failed','cancelled')) AS completed
  FROM publication_targets t LEFT JOIN sent_envelopes e ON e.sender_account_id=t.account_id AND e.message_id=t.message_id
    LEFT JOIN sent_delivery_status s ON s.sender_did=e.sender_did AND s.message_id=e.message_id
  UNION ALL
  SELECT t.account_id,'connections',t.publication_id,t.message_id,e.message_id IS NOT NULL,
    t.state IN ('blocked','cancelled','expired') OR
      (t.state='submitted' AND s.current_state IN ('delivered','failed','cancelled'))
  FROM connection_message_targets t LEFT JOIN sent_envelopes e ON e.sender_account_id=t.account_id AND e.message_id=t.message_id
    LEFT JOIN sent_delivery_status s ON s.sender_did=e.sender_did AND s.message_id=e.message_id
  UNION ALL
  SELECT e.sender_account_id,'message',e.message_id,e.message_id,true,s.current_state IN ('delivered','failed','cancelled')
  FROM sent_envelopes e LEFT JOIN sent_delivery_status s ON s.sender_did=e.sender_did AND s.message_id=e.message_id
  WHERE NOT EXISTS(SELECT 1 FROM publication_targets t WHERE t.account_id=e.sender_account_id AND t.message_id=e.message_id)
    AND NOT EXISTS(SELECT 1 FROM connection_message_targets t WHERE t.account_id=e.sender_account_id AND t.message_id=e.message_id);

CREATE VIEW account_sent_items AS
  SELECT account_id,id,'category'::text AS kind,sender_did,category,created_at,body_bytes FROM account_publications WHERE sealed
  UNION ALL
  SELECT account_id,id,'connections',sender_did,NULL::text,created_at,body_bytes FROM connection_message_batches WHERE sealed
  UNION ALL
  SELECT e.sender_account_id,e.message_id,'message',e.sender_did,NULL::text,e.created_at,b.body_bytes
  FROM sent_envelopes e JOIN detached_bodies b ON b.sender_account_id=e.sender_account_id AND b.digest=e.body_digest
  WHERE NOT EXISTS(SELECT 1 FROM publication_targets t WHERE t.account_id=e.sender_account_id AND t.message_id=e.message_id)
    AND NOT EXISTS(SELECT 1 FROM connection_message_targets t WHERE t.account_id=e.sender_account_id AND t.message_id=e.message_id);

CREATE FUNCTION hail_sent_visible(owner_id uuid,envelope_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS(SELECT 1 FROM account_sent_members m JOIN account_sent_dispositions d
    ON d.account_id=m.account_id AND d.kind=m.kind AND d.send_id=m.send_id
    WHERE m.account_id=owner_id AND m.message_id=envelope_id)
$$;
