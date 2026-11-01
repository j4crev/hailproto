import type {SQL} from "bun";

// Presentation only: published local bindings and this account's active connections.
export async function participantAddresses(sql:SQL,accountId:string,participants:string[]) {
    if(!participants.length)return {} as Record<string,string>;
    const addresses=await sql<{did:string;address:string}[]>`
      SELECT member.did,COALESCE(local.canonical_address,peer.peer_address) AS address
      FROM jsonb_array_elements_text(${JSON.stringify(participants)}::text::jsonb) AS member(did)
      LEFT JOIN LATERAL (
        SELECT b.canonical_address FROM address_bindings b JOIN provider_accounts a ON a.id=b.account_id
        WHERE b.did=member.did AND a.did=b.did AND a.onboarding_state='active' AND a.closed_at IS NULL
          AND a.address_released_at IS NULL AND a.canonical_address=b.canonical_address AND b.selected_at IS NOT NULL
          AND b.published_at IS NOT NULL AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp())
          AND NOT EXISTS(SELECT 1 FROM address_binding_withdrawals w WHERE w.binding_id=b.id)
          AND NOT EXISTS(SELECT 1 FROM address_bindings newer WHERE newer.canonical_address=b.canonical_address
            AND (newer.selected_at,newer.id)>(b.selected_at,b.id))
          AND NOT EXISTS(SELECT 1 FROM provider_migration_fences f WHERE f.account_id=a.id AND f.state='retired')
        ORDER BY b.selected_at DESC,b.id DESC LIMIT 1
      ) local ON true
      LEFT JOIN LATERAL (
        SELECT p.peer_address FROM federated_connection_pairs p JOIN account_serving_generations g
          ON g.account_id=p.account_id AND g.generation=p.serving_generation
        WHERE p.account_id=${accountId} AND p.peer_did=member.did AND p.state='active'
          AND NOT hail_connection_handover_blocked(p.local_did,p.peer_did) LIMIT 1
      ) peer ON true
      WHERE COALESCE(local.canonical_address,peer.peer_address) IS NOT NULL`;
    return Object.fromEntries(addresses.map(row=>[row.did,row.address]));
}
