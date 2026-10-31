import type { SQL } from "bun";
import type { AccountApiSession } from "./repository.js";
import { CustomDomainError } from "./domain-proof.js";
import { withdrawAccountBindings } from "../discovery/withdrawal.js";

export function requireRecentPasskey(session:AccountApiSession) {
  if(!session.passkey_credential_id||!session.passkey_verified_at||session.passkey_verified_at.getTime()<Date.now()-300_000)
    throw new CustomDomainError(403,"Sign in again with your passkey before this operation.");
}

export async function requireCurrentPasskey(tx:SQL,session:AccountApiSession) {
  requireRecentPasskey(session);
  if(!(await tx`SELECT s.id FROM account_passkey_sessions s JOIN account_passkeys k ON k.credential_id=s.credential_id AND k.account_id=s.account_id
    WHERE s.id=${session.credential_id} AND s.account_id=${session.account_id} AND s.credential_id=${session.passkey_credential_id!}
      AND s.revoked_at IS NULL AND k.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND s.created_at>clock_timestamp()-interval '5 minutes'`).length)
    throw new CustomDomainError(403,"Current, recently verified passkey session required.");
}

async function boundLifecycleTransaction(tx:SQL) {
  const row=(await tx`SELECT current_setting('transaction_timeout')::interval=interval '0 seconds' OR
    current_setting('transaction_timeout')::interval>interval '30 seconds' AS cap`)[0];
  if(row.cap)await tx`SET LOCAL transaction_timeout = '30s'`;
}

// Caller owns the transaction. Retained historical addresses never authorize a
// new account; DID/account IDs remain the authority for existing conversations.
export async function releaseAccountAddress(tx:SQL,accountId:string,reason:"domain-withdrawal"|"account-deletion") {
  await boundLifecycleTransaction(tx);
  const account=(await tx`SELECT id,canonical_address,address_released_at FROM provider_accounts WHERE id=${accountId} FOR UPDATE`)[0];
  if(!account)throw new CustomDomainError(404,"Account not found.");
  if(account.address_released_at)return;
  await tx`SELECT hail_assert_unfenced_account(${accountId}::uuid)`;
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${account.canonical_address},91))`;
  await withdrawAccountBindings(tx,accountId,reason);
  await tx`UPDATE provider_accounts SET address_released_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=${accountId}`;
}

export async function withdrawDomain(tx:SQL,domainId:string) {
  await boundLifecycleTransaction(tx);
  const domain=(await tx`SELECT * FROM account_custom_domains WHERE id=${domainId} FOR UPDATE`)[0];
  if(!domain)throw new CustomDomainError(404,"Domain not found.");
  if(domain.withdrawn_at)return;
  // A domain administrator controls publication, never another account's keys.
  const accounts=await tx`SELECT id FROM provider_accounts WHERE split_part(canonical_address,'@',2)=${domain.domain}
    AND address_released_at IS NULL ORDER BY id FOR UPDATE`;
  const generations=await tx`SELECT account_id,generation FROM account_serving_generations WHERE account_id IN
    (SELECT id FROM provider_accounts WHERE split_part(canonical_address,'@',2)=${domain.domain} AND address_released_at IS NULL)`;
  for(const generation of generations)await tx`SELECT set_config('hail.admitted_generations',
    (coalesce(nullif(current_setting('hail.admitted_generations',true),''),'{}')::jsonb ||
      jsonb_build_object(${generation.account_id}::text,${Number(generation.generation)}::bigint))::text,true)`;
  for(const account of accounts)await releaseAccountAddress(tx,account.id,"domain-withdrawal");
  await tx`UPDATE custom_address_authorizations SET retired_at=clock_timestamp() WHERE domain_id=${domainId} AND retired_at IS NULL`;
  await tx`UPDATE account_custom_domains SET withdrawn_at=clock_timestamp() WHERE id=${domainId}`;
}

export class AccountLifecycle {
  constructor(private readonly sql:SQL){}
  async close(session:AccountApiSession,address:string) {
    requireRecentPasskey(session);
    if(address!==session.canonical_address)throw new CustomDomainError(400,"Confirm the exact account address.");
    return this.sql.begin(async tx=>{
      await boundLifecycleTransaction(tx);
      const account=(await tx`SELECT id,did,closed_at FROM provider_accounts WHERE id=${session.account_id} AND did=${session.did} FOR UPDATE`)[0];
      if(!account)throw new CustomDomainError(404,"Account not found.");
      if(account.closed_at)return {closed:true};
      await tx`SELECT hail_assert_unfenced_account(${session.account_id}::uuid)`;
      await requireCurrentPasskey(tx,session);
      if((await tx`SELECT id FROM account_custom_domains WHERE account_id=${session.account_id} AND verified_at IS NOT NULL AND withdrawn_at IS NULL`).length)
        throw new CustomDomainError(409,"Withdraw your registered domains before deleting this account. Other accounts under them will retain their inboxes and identities.");
      if((await tx`SELECT 1 FROM provider_migration_exports WHERE did=${session.did}
        UNION ALL SELECT 1 FROM pending_migration_imports WHERE did=${session.did}
        UNION ALL SELECT 1 FROM provider_retired_import_history WHERE did=${session.did}
        UNION ALL SELECT 1 FROM provider_retired_transfer_history WHERE did=${session.did} LIMIT 1`).length)
        throw new CustomDomainError(409,"This account has migration snapshots. Deletion requires snapshot erasure support before inbox removal can be guaranteed.");
      await tx`UPDATE publication_targets SET state='cancelled' WHERE account_id=${session.account_id} AND state='pending'`;
      await tx`UPDATE connection_message_targets SET state='cancelled' WHERE account_id=${session.account_id} AND state='pending'`;
      await tx`SELECT hail_assert_connection_source_drained(${session.account_id}::uuid)`;
      await tx`UPDATE delivery_work w SET state='cancelled',reason='account-closed',lease_token=NULL,lease_expires_at=NULL,
        status_revision=status_revision+1,transitioned_at=clock_timestamp() FROM received_envelopes e
        WHERE e.sender_did=w.sender_did AND e.message_id=w.message_id AND e.local_account_id=${session.account_id} AND w.state IN ('accepted','on-hold')`;
      await tx`UPDATE terminal_status_publications p SET state='blocked',last_error='Account closed',
        lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() FROM received_envelopes e
        WHERE e.sender_did=p.sender_did AND e.message_id=p.message_id AND e.local_account_id=${session.account_id}
          AND p.state IN ('pending','retry')`;
      await tx`UPDATE grant_publications p SET state='blocked',last_error='Account closed',
        lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() FROM grant_lineages g
        WHERE g.grant_id=p.grant_id AND g.local_account_id=${session.account_id} AND p.state IN ('pending','retry')`;
      // The account row lock serializes every guarded delivery writer. No new
      // inbox body can be committed after closure; shared recipient copies stay.
      const blobs=await tx`SELECT DISTINCT digest FROM verified_body_provenance WHERE recipient_did=${session.did} ORDER BY digest`;
      await tx`DELETE FROM delivered_messages WHERE recipient_did=${session.did}`;
      await tx`DELETE FROM verified_body_provenance WHERE recipient_did=${session.did}`;
      for(const blob of blobs){
        await tx`SELECT digest FROM shared_content_blobs WHERE digest=${blob.digest} FOR UPDATE`;
        await tx`DELETE FROM shared_content_blobs b WHERE digest=${blob.digest}
          AND NOT EXISTS(SELECT 1 FROM verified_body_provenance p WHERE p.digest=b.digest)`;
      }
      await tx`UPDATE account_api_credentials SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE account_id=${session.account_id}`;
      await tx`UPDATE account_passkey_sessions SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE account_id=${session.account_id}`;
      await tx`UPDATE account_passkeys SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE account_id=${session.account_id}`;
      await releaseAccountAddress(tx,session.account_id,"account-deletion");
      await tx`UPDATE provider_accounts SET closed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=${session.account_id}`;
      return {closed:true};
    });
  }
}
