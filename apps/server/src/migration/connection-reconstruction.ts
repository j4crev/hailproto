import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {SQL} from 'bun';
import {encodeBase64Url} from '@hailproto/codec';
import type {HailDidResolver} from '../plc/resolver.js';
import {requireFreshPublicAuthority} from '../plc/authority.js';
import type {RemoteConnectionReview} from '../accounts/connection-review.js';
import type {ConnectionFederation} from '../accounts/connection-federation.js';
import {PLC_READ_EVIDENCE_POLICY_VERSION} from '../identity/managed-profile.js';
import {parseJsonWithoutDuplicateKeys} from '../discovery/strict-json.js';
import {uuidV7} from '../identity/uuid-v7.js';
import {decodeSignedRecord} from './wire.js';
import {validateTransferManifest} from './transfer.js';
import {validateManagedTransferManifest} from './managed-snapshot.js';
import {connectionHistoryDigest,type ConnectionHistory} from './connection-history.js';
import {verifyConnectionHistoryAuthority} from './connection-history-verification.js';
import {assertConnectionHandoverSelection,decodeConnectionHandover,decodeConnectionHandoverTransition,verifyConnectionHandoverSignature,
  verifyConnectionHandoverTransitionSignature,verifyConnectionHandoverResult,connectionHandoverPlanDigest,connectionActivationDigest,decodeConnectionHandoverResult} from './connection-handover.js';
import {decodeConnectionHandoverAbort,verifyConnectionHandoverAbortSignature} from './connection-handover.js';
import {verifyActivationReceipt} from './activation-receipt.js';

type Row=Record<string,unknown>;
type Manifest=ReturnType<typeof validateTransferManifest>|ReturnType<typeof validateManagedTransferManifest>;
const hash=(bytes:Uint8Array)=>new Uint8Array(createHash('sha256').update(bytes).digest());
const same=(a:Uint8Array,b:Uint8Array)=>Buffer.from(a).equals(Buffer.from(b));
const hex=(bytes:Uint8Array)=>'\\x'+Buffer.from(bytes).toString('hex');
const pg=(value:unknown)=>{if(typeof value!=='string'||!/^\\x(?:[0-9a-f]{2})+$/.test(value))throw new Error('Invalid connection reconstruction bytes');return new Uint8Array(Buffer.from(value.slice(2),'hex'));};
export function connectionHandoverPeers(history:ConnectionHistory):string[]{
  if(history.tables.account_connections.length)throw new Error('Pre-launch native connection records require an explicit reset before portability');
  return history.tables.federated_connection_pairs.filter(p=>p.state!=='empty').map(p=>String(p.peer_did)).sort();
}
function exactFields(value:unknown,fields:string[]):asserts value is Row {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==fields.sort().join(','))throw new Error('Invalid connection reconstruction fields');
}
async function pending(sql:SQL,id:string,base:string){
  const row=(await sql<{state:string;custody_profile:string;manifest_bytes:Uint8Array;manifest_digest:Uint8Array;source_messaging_public_key:string;
    destination_binding_digest:Uint8Array;destination_binding_cose:Uint8Array;destination_address:string}[]>`SELECT state,custody_profile,manifest_bytes,manifest_digest,source_messaging_public_key,
    destination_binding_digest,destination_binding_cose,destination_address FROM pending_migration_imports WHERE transfer_id=${id} FOR UPDATE`)[0];
  if(!row||!['staged','active'].includes(row.state))throw new Error('No authenticated connection import exists');
  const manifest=row.custody_profile==='managed'?validateManagedTransferManifest(row.manifest_bytes):validateTransferManifest(row.manifest_bytes);
  if(!manifest.connections||manifest.transferId!==id||manifest.destinationServiceBase!==base||!same(hash(row.manifest_bytes),row.manifest_digest))throw new Error('Connection import snapshot or destination differs');
  return {row,manifest,history:manifest.connections};
}
export async function requireConnectionImportPhase(sql:SQL,manifest:Manifest,phase:'frozen'|'committed'|'completed'):Promise<void>{
  if(!manifest.connections)return;
  if((await sql`SELECT 1 FROM pending_migration_imports WHERE transfer_id=${manifest.transferId} AND connection_cancellation_payload IS NOT NULL`).length)throw new Error('Connection transfer cancellation is irreversible');
  if(manifest.connections.sourceGeneration>=Number.MAX_SAFE_INTEGER)throw new Error('Connection serving generation is exhausted');
  const peers=connectionHandoverPeers(manifest.connections);if(!peers.length)return;
  const staged=(await sql<{manifest_bytes:Uint8Array;manifest_digest:Uint8Array;custody_profile:string}[]>`SELECT manifest_bytes,manifest_digest,custody_profile FROM pending_migration_imports WHERE transfer_id=${manifest.transferId}`)[0];
  if(!staged||!same(hash(staged.manifest_bytes),staged.manifest_digest)||!isDeepStrictEqual(manifest,staged.custody_profile==='managed'?validateManagedTransferManifest(staged.manifest_bytes):validateTransferManifest(staged.manifest_bytes)))throw new Error('Handover readiness lost its exact staged snapshot');
  const rows=await sql<{peer_did:string;state:string;plan_bytes:Uint8Array;source_signature:Uint8Array}[]>`SELECT peer_did,state,plan_bytes,source_signature FROM connection_import_handovers
    WHERE account_id=${manifest.accountId} AND transfer_id=${manifest.transferId}`;
  const rank={frozen:0,committed:1,completed:2};
  for(const peer of peers){const row=rows.find(r=>r.peer_did===peer);
    if(!row||!(row.state in rank)||rank[row.state as keyof typeof rank]<rank[phase])throw new Error('Connection history is staged only; authenticated handover '+phase+' is required before cutover');
    const plan=decodeConnectionHandover({payloadBytes:new Uint8Array(row.plan_bytes),signature:new Uint8Array(row.source_signature)});
    assertConnectionHandoverSelection(plan,{transferId:manifest.transferId,snapshotDigest:new Uint8Array(staged.manifest_digest),history:manifest.connections,
      peerDid:peer,destinationServiceBase:manifest.destinationServiceBase,destinationMessagingKey:manifest.destinationMessagingPublicKey});
  }
}

// This API receives proof artifacts, not private keys or caller-supplied routes.
export class ConnectionReconstruction {
  constructor(private readonly sql:SQL,private readonly resolver:HailDidResolver,private readonly remote:RemoteConnectionReview,private readonly base:string,
    private readonly local?:Pick<ConnectionFederation,'handle'>){}
  async acceptFreeze(input:unknown){
    exactFields(input,['proposal','destinationSignature']);
    const proposal=decodeSignedRecord(input.proposal,65536),plan=decodeConnectionHandover(proposal);
    if(typeof input.destinationSignature!=='string')throw new Error('Missing destination freeze signature');
    const destination=decodeSignedRecord({payload:encodeBase64Url(proposal.payloadBytes),signature:input.destinationSignature},65536);
    return this.sql.begin(async tx=>{
      const {row,manifest,history}=await pending(tx as SQL,plan.transfer_id,this.base);
      if(!connectionHandoverPeers(history).includes(plan.peer_did))throw new Error('Freeze names an unsupported peer');
      assertConnectionHandoverSelection(plan,{transferId:manifest.transferId,snapshotDigest:new Uint8Array(row.manifest_digest),history,peerDid:plan.peer_did,
        destinationServiceBase:this.base,destinationMessagingKey:manifest.destinationMessagingPublicKey});
      const prior=(await tx<{state:string;plan_bytes:Uint8Array;source_signature:Uint8Array;destination_signature:Uint8Array}[]>`SELECT state,plan_bytes,source_signature,destination_signature
        FROM connection_import_handovers WHERE account_id=${manifest.accountId} AND transfer_id=${manifest.transferId} AND peer_did=${plan.peer_did}`)[0];
      if(prior){if(!same(prior.plan_bytes,proposal.payloadBytes)||!same(prior.source_signature,proposal.signature)||!same(prior.destination_signature,destination.signature))throw new Error('Freeze retry changed exact artifacts');return {phase:prior.state};}
      if(row.state!=='staged')throw new Error('An active import cannot create another freeze');
      const source=await this.resolver.resolve(manifest.did);
      if(source.did!==manifest.did||source.serviceBase!==manifest.sourceServiceBase||source.messagingDidKey!==row.source_messaging_public_key)throw new Error('Freeze source authority changed');
      await requireFreshPublicAuthority(tx as SQL,source.evidence,{did:manifest.did,role:'hail-messaging',key:source.messagingDidKey,serviceBase:source.serviceBase},new Date());
      await verifyConnectionHandoverSignature(proposal,'source-freeze',source.messagingDidKey);
      await verifyConnectionHandoverSignature(destination,'destination-freeze',manifest.destinationMessagingPublicKey);
      await verifyConnectionHistoryAuthority(history,this.resolver);
      const target=await this.resolver.resolve(plan.peer_did);
      const reply=target.serviceBase===this.base?{wire:await (async()=>{if(!this.local)throw new Error('Local peer handover is unavailable');return this.local.handle('handover-freeze',input);})(),state:target}:
        await this.remote.exchange(plan.peer_did,'handover-freeze',input);
      const receipt=decodeSignedRecord(reply.wire.receipt,65536);
      if(reply.wire.phase!=='frozen'||!same(receipt.payloadBytes,proposal.payloadBytes))throw new Error('Peer did not retain the exact freeze');
      const expected=history.tables.federated_connection_pairs.find(p=>p.peer_did===plan.peer_did)!;
      if(reply.state.serviceBase!==expected.peer_service_base)throw new Error('Freeze peer location changed');
      await requireFreshPublicAuthority(tx as SQL,reply.state.evidence,{did:plan.peer_did,role:'hail-messaging',key:reply.state.messagingDidKey,serviceBase:reply.state.serviceBase},new Date());
      await verifyConnectionHandoverSignature(receipt,'peer-freeze',reply.state.messagingDidKey);
      await tx`INSERT INTO connection_import_handovers(transfer_id,account_id,peer_did,plan_digest,plan_bytes,source_signature,destination_signature,destination_binding,source_messaging_key,source_authority,
        peer_freeze_signature,peer_freeze_key,peer_freeze_authority,state) VALUES(${manifest.transferId},${manifest.accountId},${plan.peer_did},${connectionHandoverPlanDigest(proposal.payloadBytes)},
        ${proposal.payloadBytes},${proposal.signature},${destination.signature},${row.destination_binding_cose},${source.messagingDidKey},${JSON.stringify(source.evidence)}::jsonb,${receipt.signature},${reply.state.messagingDidKey},${JSON.stringify(reply.state.evidence)}::jsonb,'frozen')`;
      return {phase:'frozen'};
    });
  }
  async acceptTransition(input:unknown){
    exactFields(input,['command','receipt',...((input&&typeof input==='object'&&'activation' in input)?['activation']:[])]);
    const command=decodeSignedRecord(input.command),request=decodeConnectionHandoverTransition(command),signed=decodeSignedRecord(input.receipt,65536),result=decodeConnectionHandoverResult(signed);
    exactFields(input,request.action==='complete'?['command','receipt','activation']:['command','receipt']);
    const activation=request.action==='complete'?decodeSignedRecord(input.activation):null;
    if(activation&&!same(connectionActivationDigest(activation),request.activation_digest!))throw new Error('Transition activation bytes changed');
    return this.sql.begin(async tx=>{
      const {row,manifest,history}=await pending(tx as SQL,request.transfer_id,this.base);
      const job=(await tx<Row[]>`SELECT * FROM connection_import_handovers WHERE account_id=${manifest.accountId} AND transfer_id=${manifest.transferId} AND peer_did=${request.peer_did} FOR UPDATE`)[0];
      if(!job||!same(job.plan_digest as Uint8Array,request.plan_digest)||request.did!==manifest.did||!same(request.binding_digest,row.destination_binding_digest)||
        result.did!==manifest.did||result.peer_did!==request.peer_did||result.transfer_id!==manifest.transferId||!same(result.plan_digest,request.plan_digest)||!same(result.request_digest,hash(command.payloadBytes))||
        result.phase!==(request.action==='commit'?'committed':'completed'))throw new Error('Peer transition differs from the staged account');
      const prefix=request.action==='commit'?'commit':'completion',prior=job[prefix+'_payload'] as Uint8Array|null;
      if(prior){if(!same(prior,command.payloadBytes)||!same(job[prefix+'_signature'] as Uint8Array,command.signature)||
        !same(job['peer_'+prefix+'_payload'] as Uint8Array,signed.payloadBytes)||!same(job['peer_'+prefix+'_signature'] as Uint8Array,signed.signature))throw new Error('Peer transition retry changed exact artifacts');return {phase:job.state};}
      if(request.action==='complete'&&(job.state!=='committed'||row.state!=='active')||request.action==='commit'&&job.state!=='frozen')throw new Error('Connection transition is out of order');
      const current=await this.resolver.resolve(manifest.did),now=Math.floor(Date.now()/1000);
      if(current.did!==manifest.did||current.serviceBase!==this.base||current.messagingDidKey!==manifest.destinationMessagingPublicKey)throw new Error('PLC does not authorize this destination');
      await requireFreshPublicAuthority(tx as SQL,current.evidence,{did:manifest.did,role:'hail-messaging',key:current.messagingDidKey,serviceBase:this.base},new Date());
      // The peer already executed this command: transport expiry must not strand
      // its durable result. New peer actions still require a fresh command.
      await verifyConnectionHandoverTransitionSignature(command,current.messagingDidKey);
      const peer=await this.resolver.resolve(request.peer_did),pair=history.tables.federated_connection_pairs.find(p=>p.peer_did===peer.did);
      if(!pair||pair.peer_service_base!==peer.serviceBase)throw new Error('Transition peer location changed');
      await requireFreshPublicAuthority(tx as SQL,peer.evidence,{did:peer.did,role:'hail-messaging',key:peer.messagingDidKey,serviceBase:peer.serviceBase},new Date());
      await verifyConnectionHandoverResult(signed,peer.messagingDidKey);
      if(result.issued_at<request.issued_at-300||result.issued_at>=request.expires_at||result.issued_at>now+300)throw new Error('Peer result was not issued within the command window');
      await verifyConnectionHistoryAuthority(history,this.resolver);
      const known=new Set([String(pair.connection_id),...history.tables.federated_connection_tombstones.filter(t=>t.pair_id===pair.id).map(t=>String(t.connection_id))]);
      if(result.terminal_ids.some(id=>!known.has(id))||history.tables.federated_connection_tombstones.some(t=>t.pair_id===pair.id&&!result.terminal_ids.includes(String(t.connection_id))))throw new Error('Peer closed an unrelated connection ID or omitted terminal history');
      if(request.action==='complete'){
        const committed=decodeConnectionHandoverResult({payloadBytes:new Uint8Array(job.peer_commit_payload as Uint8Array),signature:new Uint8Array(job.peer_commit_signature as Uint8Array)});
        if(committed.terminal_ids.some(id=>!result.terminal_ids.includes(id)))throw new Error('Final handover omitted a committed terminal ID');
        const receipt=await verifyActivationReceipt(activation!,current.messagingDidKey,now);
        if(receipt.did!==manifest.did||receipt.transfer_id!==manifest.transferId||receipt.destination_address!==row.destination_address||receipt.destination_service_base!==this.base||
          !same(receipt.snapshot_digest,row.manifest_digest)||!same(receipt.address_binding_digest,row.destination_binding_digest))throw new Error('Transition activation belongs to another account import');
        if(!(await tx`SELECT transfer_id FROM connection_history_archives WHERE account_id=${manifest.accountId} AND transfer_id=${manifest.transferId}`).length)throw new Error('Connection history was not reconstructed');
        const generation=Number((await tx<{generation:number|string}[]>`SELECT g.generation FROM account_serving_generations g JOIN provider_accounts a ON a.id=g.account_id
          WHERE a.id=${manifest.accountId} AND a.did=${manifest.did} AND a.onboarding_state='active'`)[0]?.generation);
        if(!Number.isSafeInteger(generation)||generation<1||manifest.custodyProfile==='managed'&&generation!==history.sourceGeneration+1)throw new Error('Terminal overlay has another serving generation');
        await tx`SELECT set_config('hail.admitted_generations',${JSON.stringify({[manifest.accountId]:generation})},true)`;
        await applyConnectionTerminals(tx as SQL,manifest.accountId,request.peer_did,result.terminal_ids);
      }
      if(request.action==='commit')await tx`UPDATE connection_import_handovers SET state='committed',commit_payload=${command.payloadBytes},commit_signature=${command.signature},commit_moving_authority=${JSON.stringify(current.evidence)}::jsonb,
        peer_commit_payload=${signed.payloadBytes},peer_commit_signature=${signed.signature},peer_commit_key=${peer.messagingDidKey},peer_commit_authority=${JSON.stringify(peer.evidence)}::jsonb
        WHERE account_id=${manifest.accountId} AND transfer_id=${manifest.transferId} AND peer_did=${peer.did}`;
      else await tx`UPDATE connection_import_handovers SET state='completed',completion_payload=${command.payloadBytes},completion_signature=${command.signature},activation_payload=${activation!.payloadBytes},activation_signature=${activation!.signature},
        peer_completion_payload=${signed.payloadBytes},peer_completion_signature=${signed.signature},peer_completion_key=${peer.messagingDidKey},peer_completion_authority=${JSON.stringify(peer.evidence)}::jsonb
        WHERE account_id=${manifest.accountId} AND transfer_id=${manifest.transferId} AND peer_did=${peer.did}`;
      return {phase:request.action==='commit'?'committed':'completed'};
    });
  }
  async acceptAbort(input:unknown){
    exactFields(input,['abort','destinationSignature','receipt','proposal','freezeDestinationSignature','freezeReceipt']);
    const source=decodeSignedRecord(input.abort),abort=decodeConnectionHandoverAbort(source),destination=decodeSignedRecord({payload:encodeBase64Url(source.payloadBytes),signature:input.destinationSignature}),
      receipt=decodeSignedRecord(input.receipt);
    if(!same(source.payloadBytes,receipt.payloadBytes))throw new Error('Peer release changed the abort bytes');
    return this.sql.begin(async tx=>{
      const {manifest,row,history}=await pending(tx as SQL,abort.transfer_id,this.base);
      const job=(await tx<Row[]>`SELECT * FROM connection_import_handovers WHERE account_id=${manifest.accountId} AND transfer_id=${manifest.transferId} AND peer_did=${abort.peer_did} FOR UPDATE`)[0];
      const proposal=decodeSignedRecord(input.proposal,65536),plan=decodeConnectionHandover(proposal),freezeDestination=decodeSignedRecord({payload:encodeBase64Url(proposal.payloadBytes),signature:input.freezeDestinationSignature},65536),frozen=decodeSignedRecord(input.freezeReceipt,65536);
      if(abort.did!==manifest.did||!same(connectionHandoverPlanDigest(proposal.payloadBytes),abort.plan_digest)||job&&!same(job.plan_digest as Uint8Array,abort.plan_digest)||!same(frozen.payloadBytes,proposal.payloadBytes)||!connectionHandoverPeers(history).includes(abort.peer_did))throw new Error('Abort belongs to another import');
      assertConnectionHandoverSelection(plan,{transferId:manifest.transferId,snapshotDigest:new Uint8Array(row.manifest_digest),history,peerDid:abort.peer_did,destinationServiceBase:this.base,destinationMessagingKey:manifest.destinationMessagingPublicKey});
      if(job?.state==='released'){
        if(!same(job.release_payload as Uint8Array,source.payloadBytes)||!same(job.release_source_signature as Uint8Array,source.signature)||!same(job.release_destination_signature as Uint8Array,destination.signature)||!same(job.release_peer_signature as Uint8Array,receipt.signature))throw new Error('Release retry changed exact artifacts');return {phase:'released'};
      }
      if(job&&job.state!=='frozen'||!(await tx`SELECT 1 FROM pending_migration_imports WHERE transfer_id=${manifest.transferId} AND state='staged' AND connection_cancellation_payload IS NOT NULL`).length)throw new Error('Only an irreversibly cancelling import may release a freeze');
      const current=await this.resolver.resolve(manifest.did),peer=await this.resolver.resolve(abort.peer_did);
      if(current.serviceBase!==manifest.sourceServiceBase)throw new Error('PLC cutover prevents abort import');
      await requireFreshPublicAuthority(tx as SQL,current.evidence,{did:manifest.did,role:'hail-messaging',key:current.messagingDidKey,serviceBase:current.serviceBase},new Date());
      await requireFreshPublicAuthority(tx as SQL,peer.evidence,{did:peer.did,role:'hail-messaging',key:peer.messagingDidKey,serviceBase:peer.serviceBase},new Date());
      await verifyConnectionHandoverAbortSignature(source,'source-abort',current.messagingDidKey);
      await verifyConnectionHandoverAbortSignature(destination,'destination-abort',manifest.destinationMessagingPublicKey);
      await verifyConnectionHandoverAbortSignature(receipt,'peer-release',peer.messagingDidKey);
      if(!job){
        await verifyConnectionHandoverSignature(proposal,'source-freeze',current.messagingDidKey);
        await verifyConnectionHandoverSignature(freezeDestination,'destination-freeze',manifest.destinationMessagingPublicKey);
        await verifyConnectionHandoverSignature(frozen,'peer-freeze',peer.messagingDidKey);
        await tx`INSERT INTO connection_import_handovers(transfer_id,account_id,peer_did,plan_digest,plan_bytes,source_signature,destination_signature,destination_binding,source_messaging_key,source_authority,
          peer_freeze_signature,peer_freeze_key,peer_freeze_authority,state,release_payload,release_source_signature,release_source_authority,release_destination_signature,release_peer_signature,release_peer_key,release_peer_authority)
          VALUES(${manifest.transferId},${manifest.accountId},${peer.did},${abort.plan_digest},${proposal.payloadBytes},${proposal.signature},${freezeDestination.signature},${row.destination_binding_cose},${current.messagingDidKey},${JSON.stringify(current.evidence)}::jsonb,
            ${frozen.signature},${peer.messagingDidKey},${JSON.stringify(peer.evidence)}::jsonb,'released',${source.payloadBytes},${source.signature},${JSON.stringify(current.evidence)}::jsonb,
            ${destination.signature},${receipt.signature},${peer.messagingDidKey},${JSON.stringify(peer.evidence)}::jsonb)`;
        return {phase:'released'};
      }
      await tx`UPDATE connection_import_handovers SET state='released',release_payload=${source.payloadBytes},release_source_signature=${source.signature},release_source_authority=${JSON.stringify(current.evidence)}::jsonb,
        release_destination_signature=${destination.signature},release_peer_signature=${receipt.signature},release_peer_key=${peer.messagingDidKey},release_peer_authority=${JSON.stringify(peer.evidence)}::jsonb
        WHERE account_id=${manifest.accountId} AND transfer_id=${manifest.transferId} AND peer_did=${peer.did}`;
      return {phase:'released'};
    });
  }
}

export async function applyConnectionTerminals(sql:SQL,accountId:string,peerDid:string,ids:string[]):Promise<void>{
  const pair=(await sql<{id:string;connection_id:string|null;epoch:number|string;state:string}[]>`SELECT id,connection_id,epoch,state FROM federated_connection_pairs WHERE account_id=${accountId} AND peer_did=${peerDid} FOR UPDATE`)[0];
  if(!pair)throw new Error('Terminal overlay has no reconstructed pair');
  for(const id of ids)await sql`INSERT INTO federated_connection_tombstones(account_id,pair_id,connection_id,epoch) VALUES(${accountId},${pair.id},${id},${pair.epoch}) ON CONFLICT(pair_id,connection_id) DO NOTHING`;
  if(pair.state==='active'&&pair.connection_id&&ids.includes(pair.connection_id)){
    await sql`UPDATE federated_connection_pairs SET cutoff_at=GREATEST(cutoff_at,clock_timestamp()),updated_at=clock_timestamp() WHERE id=${pair.id}`;
    if(!(await sql`SELECT id FROM federated_connection_disconnects WHERE account_id=${accountId} AND pair_id=${pair.id} AND connection_id=${pair.connection_id} AND result_cose IS NULL`).length)
      await sql`INSERT INTO federated_connection_disconnects(id,account_id,pair_id,connection_id,epoch) VALUES(${uuidV7()},${accountId},${pair.id},${pair.connection_id},${pair.epoch})`;
  }
}

// Called within the existing atomic account materialization transaction, after
// the account/generation and before releasing destination connection holds.
export async function reconstructConnections(sql:SQL,manifest:Manifest,generation:number):Promise<void>{
  const history=manifest.connections;if(!history)return;
  await requireConnectionImportPhase(sql,manifest,'committed');
  if(!Number.isSafeInteger(generation)||generation<1||manifest.custodyProfile==='managed'&&generation!==history.sourceGeneration+1)throw new Error('Connection reconstruction generation differs');
  const account=(await sql<{did:string;generation:number|string}[]>`SELECT a.did,g.generation FROM provider_accounts a JOIN account_serving_generations g ON g.account_id=a.id WHERE a.id=${manifest.accountId}`)[0];
  if(account?.did!==manifest.did||Number(account.generation)!==generation)throw new Error('Connection reconstruction has another account owner');
  await sql`SELECT set_config('hail.connection_import_transfer',${manifest.transferId},true)`;
  await sql`SELECT set_config('hail.connection_import_generation',${String(generation)},true)`;
  const keys:Record<string,string[]>={public_plc_resolution_evidence:['evidence_digest'],federated_connection_pairs:['id'],federated_connection_attempts:['account_id','id'],
    federated_connection_events:['id'],federated_connection_results:['id'],federated_connection_tombstones:['pair_id','connection_id'],federated_connection_disconnects:['id'],
    federated_connection_outbox:['id'],connection_proof_signatures:['account_id','digest'],connection_handover_barriers:['account_id','plan_digest'],
    connection_import_handovers:['account_id','transfer_id','peer_did'],connection_transfer_aborts:['account_id','transfer_id'],connection_message_batches:['account_id','id'],connection_message_targets:['account_id','publication_id','recipient_did']};
  const normalized=(name:string,value:unknown):unknown=>{
    if(name==='authority'){
      const authority=(typeof value==='string'?parseJsonWithoutDuplicateKeys(value):value) as Record<string,unknown>,ref=authority?.verification as Record<string,unknown>|undefined;
      // The caller has verified the incoming bundle. Keep the original proof row;
      // distinct read receipts remain in public evidence and the immutable import
      // archive. Only observation digest/time may differ, never signer state/log.
      if(ref?.profile==='strict-public-v1'){
        const {digest,verifiedAt,...selection}=ref;
        return {...authority,verification:selection};
      }
      return authority;
    }
    return name.endsWith('_at')&&typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():value;
  };
  const insert=async(table:string,row:Row)=>{
    const inserted=await sql.unsafe(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}",($1::text)::jsonb) ON CONFLICT DO NOTHING RETURNING 1`,[JSON.stringify(row)]);
    if(inserted.length)return;
    const primary=keys[table];if(!primary)throw new Error('Unknown reconstruction table');
    const prior=(await sql.unsafe<{row:Row}[]>(`SELECT to_jsonb(t) AS row FROM "${table==='public_plc_resolution_evidence'?'public_plc_resolution_contents':table}" t WHERE ${primary.map((key,index)=>`to_jsonb(t)->'${key}'=(($${index+1}::text)::jsonb)`).join(' AND ')}`,
      primary.map(key=>JSON.stringify(row[key]))))[0]?.row;
    if(!prior||Object.keys(row).some(key=>!isDeepStrictEqual(normalized(key,row[key]),normalized(key,prior[key]))))throw new Error('Reconstruction conflicts with retained '+table+' bytes or ownership');
  };
  for(const row of history.tables.public_plc_resolution_evidence)await insert('public_plc_resolution_evidence',{...row,record_version:1,read_evidence_policy_version:PLC_READ_EVIDENCE_POLICY_VERSION});
  for(const row of history.tables.federated_connection_pairs){
    const projected:Row={...row,serving_generation:generation,coordinator_service_base:manifest.did<String(row.peer_did)?manifest.destinationServiceBase:row.peer_service_base,
      cutoff_at:row.cutoff_at===null?null:new Date().toISOString()};
    const prior=(await sql<Row[]>`SELECT * FROM federated_connection_pairs WHERE id=${row.id}`)[0];
    if(prior){
      if(prior.account_id!==manifest.accountId||prior.local_did!==manifest.did||prior.peer_did!==row.peer_did||Number(prior.epoch)>Number(row.epoch))throw new Error('Reconstruction conflicts with retained pair identity or epoch');
      await sql`UPDATE federated_connection_pairs SET serving_generation=${generation},peer_address=${String(projected.peer_address)},peer_service_base=${String(projected.peer_service_base)},
        coordinator_service_base=${String(projected.coordinator_service_base)},epoch=${Number(row.epoch)},state=${String(row.state)},connection_id=${row.connection_id as string|null},
        cutoff_at=CASE WHEN ${projected.cutoff_at as string|null}::timestamptz IS NULL THEN cutoff_at ELSE GREATEST(cutoff_at,${projected.cutoff_at as string|null}::timestamptz) END,updated_at=clock_timestamp() WHERE id=${row.id}`;
    }else await insert('federated_connection_pairs',projected);
  }
  for(const table of ['federated_connection_attempts','federated_connection_events','federated_connection_results','federated_connection_tombstones','federated_connection_disconnects','federated_connection_outbox'] as const)
    for(const row of history.tables[table])await insert(table,row);
  for(const row of history.tables.federated_connection_signatures)await insert('connection_proof_signatures',row);
  for(const row of history.tables.connection_handover_barriers)await insert('connection_handover_barriers',row);
  for(const row of history.tables.connection_import_handovers)await insert('connection_import_handovers',row);
  for(const row of history.tables.connection_transfer_aborts)await insert('connection_transfer_aborts',row);
  for(const batch of history.tables.connection_message_batches){
    const prior=(await sql<{request_digest:Uint8Array;manifest:Uint8Array;body_bytes:Uint8Array}[]>`SELECT request_digest,manifest,body_bytes FROM connection_message_batches WHERE account_id=${manifest.accountId} AND id=${batch.id}`)[0];
    if(prior){if(!same(prior.request_digest,pg(batch.request_digest))||!same(prior.manifest,pg(batch.manifest))||!same(prior.body_bytes,pg(batch.body_bytes)))throw new Error('Reconstruction conflicts with immutable batch intent');await insert('connection_message_batches',batch);continue;}
    await insert('connection_message_batches',{...batch,sealed:false});
    for(const target of history.tables.connection_message_targets.filter(t=>t.publication_id===batch.id))await insert('connection_message_targets',target);
    await sql`UPDATE connection_message_batches SET sealed=true WHERE account_id=${manifest.accountId} AND id=${batch.id}`;
  }
  for(const peer of connectionHandoverPeers(history)){
    const row=(await sql<{peer_commit_payload:Uint8Array;peer_commit_signature:Uint8Array}[]>`SELECT peer_commit_payload,peer_commit_signature FROM connection_import_handovers WHERE account_id=${manifest.accountId} AND transfer_id=${manifest.transferId} AND peer_did=${peer}`)[0]!;
    const result=decodeConnectionHandoverResult({payloadBytes:new Uint8Array(row.peer_commit_payload),signature:new Uint8Array(row.peer_commit_signature)});
    await applyConnectionTerminals(sql,manifest.accountId,peer,result.terminal_ids);
  }
  const historyBytes=new TextEncoder().encode(JSON.stringify(history));
  const archive=(await sql<{history_bytes:Uint8Array;history_digest:Uint8Array}[]>`SELECT history_bytes,history_digest FROM connection_history_archives WHERE account_id=${manifest.accountId} AND transfer_id=${manifest.transferId}`)[0];
  if(archive){if(!same(archive.history_bytes,historyBytes)||!same(archive.history_digest,connectionHistoryDigest(history)))throw new Error('Connection history archive conflicts with retained bytes');}
  else await sql`INSERT INTO connection_history_archives(account_id,transfer_id,history_bytes,history_digest) VALUES(${manifest.accountId},${manifest.transferId},${historyBytes},${connectionHistoryDigest(history)})`;
  // Invitations/approvals remain in the immutable archive only. In particular,
  // no token ciphertext, session challenge or old personal code becomes live.
}
