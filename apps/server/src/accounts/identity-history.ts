import type {SQL} from "bun";

// Saved consent is account-scoped and survives revocation. Do not limit this to
// the current UI page, or an address reassignment could bypass the warning.
export async function previousAddressIdentities(sql:SQL,accountId:string,address:string,did:string):Promise<string[]> {
  const rows=await sql<{did:string}[]>`
    SELECT DISTINCT known.did FROM (
      SELECT lineage.grantee_did AS did FROM grant_lineages lineage
        JOIN grant_consent_evidence consent USING(grant_id)
        WHERE lineage.local_account_id=${accountId} AND lineage.local_role='grantor'
          AND consent.grantee_address=${address}
      UNION
      SELECT peer_did AS did FROM federated_connection_pairs
        WHERE account_id=${accountId} AND peer_address=${address} AND state<>'empty'
      UNION
      SELECT moving_did AS did FROM connection_handover_barriers
        WHERE account_id=${accountId} AND destination_address=${address} AND state='completed'
    ) known WHERE known.did<>${did} ORDER BY known.did LIMIT 20`;
  return rows.map(row=>row.did);
}
