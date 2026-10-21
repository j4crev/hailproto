-- The same provider may host both DIDs after a transfer. Keep the single
-- immutable Grant revision chain, with a second local ownership reference
-- for the sender/grantee. The primary lineage stays authoritative/grantor.
CREATE TABLE collocated_grant_receivers (
  grant_id uuid PRIMARY KEY REFERENCES grant_lineages(grant_id) ON DELETE RESTRICT,
  grantee_account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX hail_collocated_grantee_account ON collocated_grant_receivers (grantee_account_id);
