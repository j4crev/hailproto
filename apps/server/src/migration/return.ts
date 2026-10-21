import {isDeepStrictEqual} from "node:util";
import type {SQL} from "bun";
import {validateTransferManifest,type TransferManifest} from "./transfer.js";
import {validateManagedTransferManifest,type ManagedTransferManifest} from "./managed-snapshot.js";

export async function retiredReturnAccount(sql:SQL,did:string) {
  const rows=await sql<{account_id:string;generation:string|number;export_record:Record<string,unknown>}[]>`
    SELECT f.account_id,g.generation,h.export_record FROM provider_migration_fences f
    JOIN provider_accounts a ON a.id=f.account_id AND a.did=f.did
    JOIN account_serving_generations g ON g.account_id=a.id
    JOIN provider_retired_transfer_history h ON h.transfer_id=f.transfer_id AND h.serving_generation=g.generation
    JOIN provider_migration_exports e ON e.transfer_id=f.transfer_id
    LEFT JOIN provider_transfer_authorizations auth ON auth.did=f.did AND auth.consumed_transfer_id=f.transfer_id
    WHERE f.did=${did} AND f.state='retired' AND h.fence_record=to_jsonb(f) AND h.export_record=to_jsonb(e)
      AND h.authorization_record IS NOT DISTINCT FROM to_jsonb(auth)
      AND EXISTS (SELECT 1 FROM portable_custody_evidence WHERE account_id=a.id AND monitor_verification_mode='poc-local')
      AND NOT EXISTS (SELECT 1 FROM managed_custody_evidence WHERE account_id=a.id)
      AND NOT EXISTS (SELECT 1 FROM account_keys WHERE account_id=a.id AND role='hail-identity')`;
  return rows[0]??null;
}
export async function validateReturningEvidence(sql:SQL,manifest:TransferManifest) {
  const retired=await retiredReturnAccount(sql,manifest.did);if(!retired||retired.account_id!==manifest.accountId)throw new Error("Destination has no matching retired owner-controlled history");
  const bytes=retired.export_record.manifest_bytes;if(typeof bytes!=="string"||!/^\\x[0-9a-f]+$/.test(bytes))throw new Error("Retired snapshot is unavailable");
  const previous=validateTransferManifest(new Uint8Array(Buffer.from(bytes.slice(2),"hex")));
  const old=previous.tables.portable_custody_evidence[0]!,next=manifest.tables.portable_custody_evidence[0]!;
  if(old.monitor_verification_mode!=="poc-local"||next.monitor_verification_mode!=="poc-local"||old.user_identity_public_key!==next.user_identity_public_key||old.user_recovery_public_key!==next.user_recovery_public_key)throw new Error("Returning identity/recovery changes require the separate custody-transition profile");
  validateRetainedHistory(previous.tables,manifest.tables);
  return retired;
}

type HistoryTables=TransferManifest["tables"]|ManagedTransferManifest["tables"];
function validateRetainedHistory(previous:HistoryTables,currentTables:HistoryTables) {
  const immutable={grant_revisions:["grant_id","revision"],grant_consent_evidence:["grant_id","revision"],
    plc_operation_evidence:["operation_cid"],sent_envelopes:["sender_did","message_id"],received_envelopes:["sender_did","message_id"],
    delivery_status_payloads:["sender_did","message_id","revision"],delivery_status_wrappers:["sender_did","message_id","revision","signing_public_key"],
    delivered_messages:["recipient_did","sender_did","message_id"],verified_body_provenance:["recipient_did","sender_did","digest","media_type","profile"]} as const;
  for(const [table,keys] of Object.entries(immutable)) {
    const name=table as keyof typeof immutable;
    for(const row of previous[name]) {
      const current=currentTables[name].find(candidate=>keys.every(key=>candidate[key]===row[key]));
      const expected={...row},actual=current?{...current}:null;
      // Receiver-local arrival time is not part of the signed Grant checkpoint.
      // The old observation remains immutable in the archived export.
      if(name==="grant_revisions"){delete expected.received_at;if(actual)delete actual.received_at;}
      if(!actual||!isDeepStrictEqual(actual,expected))throw new Error(`Returning snapshot loses or conflicts with retained ${table} history`);
    }
  }
  for(const row of previous.grant_lineages) {
    const current=currentTables.grant_lineages.find(candidate=>candidate.grant_id===row.grant_id);
    if(!current||Number(current.current_revision)<Number(row.current_revision)||current.grantor_did!==row.grantor_did||current.grantee_did!==row.grantee_did)throw new Error("Returning snapshot loses retained Grant ownership/checkpoints");
    if(row.current_status!=="active"&&(current.current_status!==row.current_status||current.current_revision!==row.current_revision))throw new Error("Returning snapshot revives a terminal Grant");
  }
  const terminals=["delivered","failed","cancelled"];
  for(const old of previous.delivery_work){
    const current=currentTables.delivery_work.find(row=>row.sender_did===old.sender_did&&row.message_id===old.message_id);
    if(!current||Number(current.status_revision)<Number(old.status_revision)||Number(current.attempt_count)<Number(old.attempt_count)||
      terminals.includes(old.state as string)&&(current.state!==old.state||current.status_revision!==old.status_revision))throw new Error("Returning snapshot loses or rewinds delivery responsibility");
  }
  for(const old of previous.sent_delivery_status){
    const current=currentTables.sent_delivery_status.find(row=>row.sender_did===old.sender_did&&row.message_id===old.message_id);
    if(!current||Number(current.current_revision)<Number(old.current_revision)||terminals.includes(old.current_state as string)&&
      (current.current_state!==old.current_state||current.current_revision!==old.current_revision))throw new Error("Returning snapshot rewinds received status");
  }
  for(const table of ["grant_publications","terminal_status_publications"] as const)for(const old of previous[table]){
    const keys=table==="grant_publications"?["grant_id","revision"]:["sender_did","message_id"];
    const current=currentTables[table].find(row=>keys.every(key=>row[key]===old[key]));
    if(!current||Number(current.attempt_count)<Number(old.attempt_count)||old.state==="acknowledged"&&
      (current.state!=="acknowledged"||table==="grant_publications"&&current.acknowledged_etag!==old.acknowledged_etag))throw new Error("Returning snapshot loses publication responsibility/acknowledgement");
  }
  for(const old of previous.reply_capabilities){
    const current=currentTables.reply_capabilities.find(row=>row.original_sender_did===old.original_sender_did&&row.original_message_id===old.original_message_id);
    const released=currentTables.delivery_work.find(row=>row.sender_did===old.claimed_sender_did&&row.message_id===old.claimed_message_id);
    if(!current||current.permitted_recipient_did!==old.permitted_recipient_did||current.reply_until!==old.reply_until||old.state==="consumed"&&current.state!=="consumed"||
      old.state==="claimed"&&(current.claimed_sender_did!==old.claimed_sender_did||current.claimed_message_id!==old.claimed_message_id)&&
      !["failed","cancelled"].includes(released?.state as string))throw new Error("Returning snapshot loses or resets reply ownership");
  }
  for(const old of previous.detached_bodies){
    const current=currentTables.detached_bodies.find(row=>row.digest===old.digest);
    if(!current||current.body_bytes!==old.body_bytes||old.available_until!==null&&Number(current.available_until)<Number(old.available_until))throw new Error("Returning snapshot loses retained body availability");
  }
  for(const old of previous.body_authorizations){
    const current=currentTables.body_authorizations.find(row=>row.token_hash===old.token_hash);
    if(!current||!isDeepStrictEqual(current,old))throw new Error("Returning snapshot loses retained body authorization");
  }
}

export async function validateManagedReturningEvidence(sql:SQL,manifest:ManagedTransferManifest) {
  const retired=await retiredManagedReturnAccount(sql,manifest.did);
  if(!retired||retired.account_id!==manifest.accountId||manifest.sourceGeneration<Number(retired.generation))
    throw new Error("Destination has no matching retired managed history");
  const bytes=retired.export_record.manifest_bytes;
  if(typeof bytes!=="string"||!/^\\x[0-9a-f]+$/.test(bytes))throw new Error("Retired managed snapshot is unavailable");
  const previous=validateManagedTransferManifest(new Uint8Array(Buffer.from(bytes.slice(2),"hex")));
  if(previous.ownerRecoveryPublicKey!==manifest.ownerRecoveryPublicKey)
    throw new Error("Returning managed snapshot changes owner recovery authority");
  validateRetainedHistory(previous.tables,manifest.tables);
  return retired;
}

export async function retiredManagedReturnAccount(sql:SQL,did:string) {
  return (await sql<{account_id:string;generation:string|number;export_record:Record<string,unknown>}[]>`
    SELECT f.account_id,g.generation,h.export_record FROM provider_migration_fences f
    JOIN provider_accounts a ON a.id=f.account_id AND a.did=f.did
    JOIN account_serving_generations g ON g.account_id=a.id
    JOIN provider_retired_transfer_history h ON h.transfer_id=f.transfer_id AND h.serving_generation=g.generation
    JOIN provider_migration_exports e ON e.transfer_id=f.transfer_id
    LEFT JOIN provider_transfer_authorizations auth ON auth.did=f.did AND auth.consumed_transfer_id=f.transfer_id
    WHERE f.did=${did} AND f.state='retired' AND h.fence_record=to_jsonb(f) AND h.export_record=to_jsonb(e)
      AND h.authorization_record IS NOT DISTINCT FROM to_jsonb(auth)
      AND EXISTS (SELECT 1 FROM managed_custody_evidence WHERE account_id=a.id
        AND verification_mode IN ('strict-public-v1','poc-local'))
      AND NOT EXISTS (SELECT 1 FROM portable_custody_evidence WHERE account_id=a.id)`)[0]??null;
}

export async function clearRetiredImportSlots(tx:SQL,account:string) {
  const rows=await tx<{transfer_id:string;import_record:unknown;invitation_record:unknown;reservation_record:unknown;prepared_public_record:unknown;
    current_import:unknown;current_invitation:unknown;current_reservation:unknown;current_prepared:unknown}[]>`
    SELECT h.*,to_jsonb(i) AS current_import,to_jsonb(invitation) AS current_invitation,to_jsonb(reservation) AS current_reservation,
      to_jsonb(prepared)-'rotation_private_ciphertext'-'rotation_nonce'-'identity_private_ciphertext'-'identity_nonce'-'messaging_private_ciphertext'-'messaging_nonce' AS current_prepared
    FROM provider_retired_import_history h JOIN pending_migration_imports i USING(transfer_id)
    LEFT JOIN received_transfer_invitations invitation USING(transfer_id)
    LEFT JOIN transfer_address_reservations reservation USING(transfer_id)
    LEFT JOIN prepared_migration_target_keys prepared USING(transfer_id)
    WHERE h.account_id=${account}`;
  for(const row of rows){
    if(!isDeepStrictEqual(row.import_record,row.current_import)||!isDeepStrictEqual(row.invitation_record,row.current_invitation)||
      !isDeepStrictEqual(row.reservation_record,row.current_reservation)||!isDeepStrictEqual(row.prepared_public_record,row.current_prepared))throw new Error("Retired import slot conflicts with archived evidence");
    const observation=(await tx<{record:unknown;current:unknown}[]>`SELECT h.record,to_jsonb(o) AS current
      FROM provider_retired_observation_history h LEFT JOIN portable_cutover_observations o USING(transfer_id) WHERE h.transfer_id=${row.transfer_id}`)[0];
    if(observation&&!isDeepStrictEqual(observation.record,observation.current))throw new Error("Retired observation conflicts with archived evidence");
    const currentObservation=await tx`SELECT transfer_id FROM portable_cutover_observations WHERE transfer_id=${row.transfer_id}`;
    if(currentObservation.length&&!observation)throw new Error("Retired observation was not archived");
    await tx`DELETE FROM transfer_address_reservations WHERE transfer_id=${row.transfer_id}`;
    await tx`DELETE FROM received_transfer_invitations WHERE transfer_id=${row.transfer_id}`;
    await tx`DELETE FROM portable_cutover_observations WHERE transfer_id=${row.transfer_id}`;
    await tx`DELETE FROM pending_migration_imports WHERE transfer_id=${row.transfer_id}`;
    await tx`DELETE FROM prepared_migration_target_keys WHERE transfer_id=${row.transfer_id}`;
  }
}

export async function replaceRetiredProjection(tx:SQL,manifest:TransferManifest) {
  await tx`SELECT id FROM provider_accounts WHERE id=${manifest.accountId} AND did=${manifest.did} FOR UPDATE`;
  const retired=await validateReturningEvidence(tx,manifest),account=manifest.accountId,did=manifest.did;
  // Detachment is allowed only after exact immutable archival and a validated latest source snapshot.
  await tx`DELETE FROM provider_migration_exports WHERE transfer_id IN (SELECT transfer_id FROM provider_migration_fences WHERE account_id=${account})`;
  await tx`DELETE FROM provider_transfer_authorizations WHERE did=${did}`;
  await tx`DELETE FROM provider_migration_fences WHERE account_id=${account}`;
  await tx`UPDATE account_api_credentials SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE account_id=${account}`;
  const received="SELECT sender_did,message_id FROM received_envelopes WHERE local_account_id=$1";
  for(const table of ["terminal_status_publications","delivery_status_wrappers","delivery_status_payloads","delivery_work"])
    await tx.unsafe(`DELETE FROM "${table}" WHERE (sender_did,message_id) IN (${received})`,[account]);
  await tx`DELETE FROM serving_worker_leases WHERE account_id=${account}`;
  await tx`DELETE FROM delivered_messages WHERE recipient_did=${did}`;
  await tx`DELETE FROM verified_body_provenance WHERE recipient_did=${did}`;
  await tx`DELETE FROM received_envelopes WHERE local_account_id=${account}`;
  await tx`DELETE FROM reply_capabilities WHERE original_sender_did=${did}`;
  await tx`DELETE FROM sent_delivery_status WHERE sender_did=${did}`;
  await tx`DELETE FROM body_authorizations WHERE sender_account_id=${account}`;
  await tx`DELETE FROM sent_envelopes WHERE sender_account_id=${account}`;
  await tx`DELETE FROM detached_bodies WHERE sender_account_id=${account}`;
  await tx`DELETE FROM collocated_grant_receivers WHERE grantee_account_id=${account}`;
  await tx`DELETE FROM grant_publications WHERE grant_id IN (SELECT grant_id FROM grant_lineages WHERE local_account_id=${account})`;
  const exclusive="SELECT grant_id FROM grant_lineages WHERE local_account_id=$1 AND NOT EXISTS (SELECT 1 FROM collocated_grant_receivers c WHERE c.grant_id=grant_lineages.grant_id)";
  await tx.unsafe(`DELETE FROM grant_consent_evidence WHERE grant_id IN (${exclusive})`,[account]);
  await tx.unsafe(`DELETE FROM grant_revisions WHERE grant_id IN (${exclusive})`,[account]);
  await tx.unsafe(`DELETE FROM grant_lineages WHERE grant_id IN (${exclusive})`,[account]);
  for(const table of ["sender_profiles","address_bindings","plc_operation_evidence","portable_custody_evidence","account_keys"])
    await tx.unsafe(`DELETE FROM "${table}" WHERE account_id=$1`,[account]);
  // Incoming import lifecycle records are retained separately before any later return recycles their slots.
  await clearRetiredImportSlots(tx,account);
  await tx`SELECT set_config('hail.returning_account',${account},true)`;
  await tx`UPDATE account_serving_generations SET generation=generation+1 WHERE account_id=${account}`;
  const generation=Number(retired.generation)+1;
  const contexts=await tx<{value:string}[]>`SELECT current_setting('hail.admitted_generations',true) AS value`;
  const admitted=JSON.parse(contexts[0]?.value||"{}");admitted[account]=generation;
  await tx`SELECT set_config('hail.admitted_generations',${JSON.stringify(admitted)},true)`;
  return generation;
}

export async function replaceRetiredManagedProjection(tx:SQL,manifest:ManagedTransferManifest) {
  await tx`SELECT id FROM provider_accounts WHERE id=${manifest.accountId} AND did=${manifest.did} FOR UPDATE`;
  await validateManagedReturningEvidence(tx,manifest);const account=manifest.accountId,did=manifest.did;
  await tx`DELETE FROM provider_migration_exports WHERE transfer_id IN (SELECT transfer_id FROM provider_migration_fences WHERE account_id=${account})`;
  await tx`DELETE FROM provider_transfer_authorizations WHERE did=${did}`;
  await tx`DELETE FROM provider_migration_fences WHERE account_id=${account}`;
  await tx`UPDATE account_api_credentials SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE account_id=${account}`;
  const received="SELECT sender_did,message_id FROM received_envelopes WHERE local_account_id=$1";
  for(const table of ["terminal_status_publications","delivery_status_wrappers","delivery_status_payloads","delivery_work"])
    await tx.unsafe(`DELETE FROM "${table}" WHERE (sender_did,message_id) IN (${received})`,[account]);
  await tx`DELETE FROM serving_worker_leases WHERE account_id=${account}`;
  await tx`DELETE FROM delivered_messages WHERE recipient_did=${did}`;
  await tx`DELETE FROM verified_body_provenance WHERE recipient_did=${did}`;
  await tx`DELETE FROM received_envelopes WHERE local_account_id=${account}`;
  await tx`DELETE FROM reply_capabilities WHERE original_sender_did=${did}`;
  await tx`DELETE FROM sent_delivery_status WHERE sender_did=${did}`;
  await tx`DELETE FROM body_authorizations WHERE sender_account_id=${account}`;
  await tx`DELETE FROM sent_envelopes WHERE sender_account_id=${account}`;
  await tx`DELETE FROM detached_bodies WHERE sender_account_id=${account}`;
  await tx`DELETE FROM collocated_grant_receivers WHERE grantee_account_id=${account}`;
  await tx`DELETE FROM grant_publications WHERE grant_id IN (SELECT grant_id FROM grant_lineages WHERE local_account_id=${account})`;
  const exclusive="SELECT grant_id FROM grant_lineages WHERE local_account_id=$1 AND NOT EXISTS (SELECT 1 FROM collocated_grant_receivers c WHERE c.grant_id=grant_lineages.grant_id)";
  await tx.unsafe(`DELETE FROM grant_consent_evidence WHERE grant_id IN (${exclusive})`,[account]);
  await tx.unsafe(`DELETE FROM grant_revisions WHERE grant_id IN (${exclusive})`,[account]);
  await tx.unsafe(`DELETE FROM grant_lineages WHERE grant_id IN (${exclusive})`,[account]);
  for(const table of ["sender_profiles","address_bindings","plc_operation_evidence","managed_custody_evidence","account_keys"])
    await tx.unsafe(`DELETE FROM "${table}" WHERE account_id=$1`,[account]);
  await clearRetiredImportSlots(tx,account);
  const generation=manifest.sourceGeneration+1;
  await tx`SELECT set_config('hail.managed_migration',${account},true)`;
  await tx`UPDATE account_serving_generations SET generation=${generation} WHERE account_id=${account}`;
  const contexts=await tx<{value:string}[]>`SELECT current_setting('hail.admitted_generations',true) AS value`;
  const admitted=JSON.parse(contexts[0]?.value||"{}");admitted[account]=generation;
  await tx`SELECT set_config('hail.admitted_generations',${JSON.stringify(admitted)},true)`;
  return generation;
}
