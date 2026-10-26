import {randomUUID,createHash} from 'node:crypto';
import type {SQL} from 'bun';
import {decodeDeterministic,encodeBase64Url} from '@hailproto/codec';
import type {DiscoveryFetch,NetworkTargetValidator} from '../discovery/verifier.js';
import {parseJsonWithoutDuplicateKeys} from '../discovery/strict-json.js';
import type {KeyEncryptor} from '../identity/key-encryption.js';
import {importEd25519PrivateKey} from '../identity/keys.js';
import {OnboardingRepository} from '../onboarding/repository.js';
import type {HailDidResolver} from '../plc/resolver.js';
import {requireFreshPublicAuthority} from '../plc/authority.js';
import type {ConnectionFederation} from '../accounts/connection-federation.js';
import {RemoteConnectionReview,RemoteConnectionError} from '../accounts/connection-review.js';
import {validateTransferManifest} from './transfer.js';
import {validateManagedTransferManifest} from './managed-snapshot.js';
import {ConnectionReconstruction,connectionHandoverPeers,requireConnectionImportPhase} from './connection-reconstruction.js';
import {createConnectionHandoverPlan,assertConnectionHandoverSelection,decodeConnectionHandover,signConnectionHandover,verifyConnectionHandoverSignature,
  signConnectionHandoverTransition,connectionHandoverPlanDigest,connectionActivationDigest,type ConnectionHandoverTransition,
  decodeConnectionHandoverAbort,signConnectionHandoverAbort,verifyConnectionHandoverAbortSignature,type ConnectionHandoverAbort} from './connection-handover.js';
import {boundedTransferBody,decodeSignedRecord,encodeSignedRecord,TRANSFER_MEDIA_TYPE} from './wire.js';
import type {SignedHandshake} from './handshake.js';
import {MigrationFenceService} from './fence.js';
import {decodeConnectionCancellation,verifyConnectionCancellation,connectionCancellationInput} from './connection-cancellation.js';

const same=(a:Uint8Array,b:Uint8Array)=>Buffer.from(a).equals(Buffer.from(b));
const hash=(bytes:Uint8Array)=>new Uint8Array(createHash('sha256').update(bytes).digest());
const now=()=>Math.floor(Date.now()/1000);
const manifestFor=(bytes:Uint8Array,profile:string)=>profile==='managed'?validateManagedTransferManifest(bytes):validateTransferManifest(bytes);
type Manifest=ReturnType<typeof manifestFor>;
type Import={manifest:Manifest;state:string;digest:Uint8Array;binding:Uint8Array;bindingDigest:Uint8Array};

// Reuses the account-transfer boundary and prepared messaging key. No identity
// secret, owner recovery key or vault crosses either network boundary.
export class ConnectionTransferOrchestration {
  private readonly remote:RemoteConnectionReview;
  private readonly reconstruction:ConnectionReconstruction;
  constructor(private readonly sql:SQL,private readonly encryptor:KeyEncryptor,private readonly resolver:HailDidResolver,
    private readonly base:string,private readonly fetch:DiscoveryFetch,private readonly validateTarget:NetworkTargetValidator,
    private readonly local:Pick<ConnectionFederation,'handle'>){
    this.remote=new RemoteConnectionReview(sql,resolver,fetch,validateTarget,base);
    this.reconstruction=new ConnectionReconstruction(sql,resolver,this.remote,base,local);
  }
  private async imported(id:string,cancelling=false):Promise<Import>{
    const row=(await this.sql<{state:string;custody_profile:string;manifest_bytes:Uint8Array;manifest_digest:Uint8Array;destination_binding_cose:Uint8Array;destination_binding_digest:Uint8Array;connection_cancellation_payload:Uint8Array|null}[]>`
      SELECT state,custody_profile,manifest_bytes,manifest_digest,destination_binding_cose,destination_binding_digest,connection_cancellation_payload FROM pending_migration_imports WHERE transfer_id=${id}`)[0];
    if(!row||!(cancelling?['staged','invalidated']:['staged','active']).includes(row.state)||!cancelling&&row.connection_cancellation_payload||!same(hash(row.manifest_bytes),row.manifest_digest))throw new Error('No exact resumable account import');
    const manifest=manifestFor(row.manifest_bytes,row.custody_profile);
    if(manifest.transferId!==id||manifest.destinationServiceBase!==this.base)throw new Error('Connection orchestration has another destination');
    return {manifest,state:row.state,digest:new Uint8Array(row.manifest_digest),binding:new Uint8Array(row.destination_binding_cose),bindingDigest:new Uint8Array(row.destination_binding_digest)};
  }
  private async destinationKey(value:Import){
    const m=value.manifest,row=(await this.sql<{did:string;destination_service_base:string;messaging_public_key:string;messaging_private_ciphertext:Uint8Array;messaging_nonce:Uint8Array;state:string}[]>`
      SELECT did,destination_service_base,messaging_public_key,messaging_private_ciphertext,messaging_nonce,state FROM prepared_migration_target_keys WHERE transfer_id=${m.transferId}`)[0];
    if(!row||!(['staged','active'].includes(row.state)||value.state==='invalidated'&&row.state==='invalidated')||row.did!==m.did||row.destination_service_base!==this.base||row.messaging_public_key!==m.destinationMessagingPublicKey)throw new Error('Prepared destination key differs from the authenticated import');
    const raw=await this.encryptor.decrypt(m.transferId,'hail-messaging','ed25519',row.messaging_public_key,
      {ciphertext:row.messaging_private_ciphertext,nonce:row.messaging_nonce,encryptionVersion:1,kekId:'poc-v1'});
    try{return await importEd25519PrivateKey(raw);}finally{raw.fill(0);}
  }
  private async sourceRpc(value:Import,phase:string,input:unknown){
    // This source is pinned by the exact authenticated snapshot, including after
    // PLC cutover. It is not replaced with the destination returned by resolution.
    const url=new URL(value.manifest.sourceServiceBase+'/transfers/connection-source/'+phase);
    await this.validateTarget(url);
    const body=JSON.stringify(input);if(Buffer.byteLength(body)>12000000)throw new Error('Source handover exchange exceeds its bounded peer-proof limit');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{
      const response=await this.fetch(new Request(url,{method:'POST',redirect:'error',signal:controller.signal,
        headers:{'Content-Type':TRANSFER_MEDIA_TYPE,'Cache-Control':'no-store'},body}));
      if(response.status!==200||response.headers.get('content-type')!==TRANSFER_MEDIA_TYPE||response.headers.has('location')||response.headers.has('content-encoding')){
        await response.body?.cancel();throw new Error('Source handover exchange failed; retry the exact account completion');
      }
      return parseJsonWithoutDuplicateKeys(new TextDecoder('utf-8',{fatal:true}).decode(await boundedTransferBody(response.body,response.headers.get('content-length'),200000))) as Record<string,unknown>;
    }finally{clearTimeout(timer);controller.abort();}
  }
  private async peer(did:string,step:'handover-commit'|'handover-complete'|'handover-abort',wire:Record<string,unknown>){
    const current=await this.resolver.resolve(did);
    return current.serviceBase===this.base?this.local.handle(step,wire):(await this.remote.exchange(did,step,wire)).wire;
  }
  private async command(value:Import,peer:string,action:string,build:(key:CryptoKey)=>Promise<SignedHandshake>,renew?:SignedHandshake):Promise<SignedHandshake>{
    // Persist before any RPC: an interrupted process must never choose a fresh
    // plan/command when the peer may already have committed the previous one.
    return this.sql.begin(async tx=>{
      const current=(await tx<{state:string;manifest_digest:Uint8Array}[]>`SELECT state,manifest_digest FROM pending_migration_imports WHERE transfer_id=${value.manifest.transferId} FOR UPDATE`)[0];
      if(!current||!['staged','active'].includes(current.state)||!same(current.manifest_digest,value.digest))throw new Error('Import changed before handover issuance');
      const previous=(await tx<{payload:Uint8Array;signature:Uint8Array}[]>`SELECT payload,signature FROM connection_transfer_commands WHERE transfer_id=${value.manifest.transferId} AND peer_did=${peer} AND action=${action}`)[0];
      if(previous&&(!renew||!same(previous.payload,renew.payloadBytes)||!same(previous.signature,renew.signature)))return {payloadBytes:new Uint8Array(previous.payload),signature:new Uint8Array(previous.signature)};
      const signed=await build(await this.destinationKey(value));
      await tx`INSERT INTO connection_transfer_commands(account_id,transfer_id,peer_did,action,payload,signature)
        VALUES(${value.manifest.accountId},${value.manifest.transferId},${peer},${action},${signed.payloadBytes},${signed.signature})
        ON CONFLICT(transfer_id,peer_did,action) DO UPDATE SET payload=EXCLUDED.payload,signature=EXCLUDED.signature`;
      return signed;
    });
  }
  async freeze(id:string){
    const value=await this.imported(id),m=value.manifest;if(!m.connections)return;
    for(const peer of connectionHandoverPeers(m.connections)){
      const prior=(await this.sql<{state:string}[]>`SELECT state FROM connection_import_handovers WHERE account_id=${m.accountId} AND transfer_id=${id} AND peer_did=${peer}`)[0];
      if(prior&&prior.state!=='released')continue;
      const build=(key:CryptoKey)=>signConnectionHandover(createConnectionHandoverPlan(m.connections!,{transferId:id,requestId:randomUUID(),peerDid:peer,
        destinationServiceBase:this.base,destinationMessagingKey:m.destinationMessagingPublicKey,snapshotDigest:value.digest,issuedAt:now()}),'destination-freeze',key);
      let destination=await this.command(value,peer,'freeze',build);
      for(let retry=0;retry<2;retry++){
        const response=await this.sourceRpc(value,'freeze',{proposal:encodeSignedRecord(destination)}),source=decodeSignedRecord(response.proposal,65536);
        if(!same(source.payloadBytes,destination.payloadBytes))throw new Error('Source changed the exact fenced handover plan');
        try{await this.reconstruction.acceptFreeze({proposal:encodeSignedRecord(source),destinationSignature:encodeBase64Url(destination.signature)});break;}
        catch(error){
          // A 410 is proof that the peer has no stored result for these exact
          // bytes: stored freezes return their durable state before expiry checks.
          if(!(error instanceof RemoteConnectionError||error instanceof Error&&'status' in error)||Number((error as {status:number}).status)!==410||retry)throw error;
          destination=await this.command(value,peer,'freeze',build,destination);
        }
      }
    }
    await requireConnectionImportPhase(this.sql,m,'frozen');
  }
  async commit(id:string){await this.transition(id,'commit');}
  async finish(id:string,activation:SignedHandshake){
    await this.transition(id,'complete',activation);
    const value=await this.imported(id);await requireConnectionImportPhase(this.sql,value.manifest,'completed');
    await this.sourceRpc(value,'retire',{receipt:encodeSignedRecord(activation)});
  }
  private async transition(id:string,action:'commit'|'complete',activation?:SignedHandshake){
    const value=await this.imported(id),m=value.manifest;if(!m.connections)return;
    for(const peer of connectionHandoverPeers(m.connections)){
      const row=(await this.sql<{state:string;plan_digest:Uint8Array}[]>`SELECT state,plan_digest FROM connection_import_handovers WHERE account_id=${m.accountId} AND transfer_id=${id} AND peer_did=${peer}`)[0];
      if(!row)throw new Error('No durable freeze for connection transition');
      if(row.state==='completed'||action==='commit'&&row.state==='committed')continue;
      const build=(key:CryptoKey)=>{const command:ConnectionHandoverTransition={type:'hail.connection-handover-transition',version:1,action,request_id:randomUUID(),transfer_id:id,
        did:m.did,peer_did:peer,plan_digest:new Uint8Array(row.plan_digest),binding_digest:value.bindingDigest,activation_digest:activation?connectionActivationDigest(activation):null,issued_at:now(),expires_at:now()+300};
        return signConnectionHandoverTransition(command,key);};
      let signed=await this.command(value,peer,action,build);
      for(let retry=0;retry<2;retry++){
        try{
          const response=await this.peer(peer,action==='commit'?'handover-commit':'handover-complete',{command:encodeSignedRecord(signed),binding:encodeBase64Url(value.binding),...(activation?{activation:encodeSignedRecord(activation)}:{})});
          await this.reconstruction.acceptTransition({command:encodeSignedRecord(signed),receipt:response.receipt,...(activation?{activation:encodeSignedRecord(activation)}:{})});break;
        }catch(error){
          if(!(error instanceof RemoteConnectionError||error instanceof Error&&'status' in error)||Number((error as {status:number}).status)!==410||retry)throw error;
          signed=await this.command(value,peer,action,build,signed);
        }
      }
    }
    await requireConnectionImportPhase(this.sql,m,action==='commit'?'committed':'completed');
  }
  // Source issuance is deliberately narrow: only the destination key already
  // pinned by the authenticated fence may request a signature on its exact export.
  async sourceFreeze(input:unknown,forAbort=false){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).join(',')!=='proposal')throw new Error('Invalid source handover request');
    const destination=decodeSignedRecord((input as {proposal:unknown}).proposal,65536),plan=decodeConnectionHandover(destination);
    return this.sql.begin(async tx=>{
      const row=(await tx<{account_id:string;state:string;destination_service_base:string;destination_messaging_public_key:string;manifest_bytes:Uint8Array;manifest_digest:Uint8Array;source_messaging_public_key:string;custody_profile:string}[]>`
        SELECT f.account_id,f.state,f.destination_service_base,f.destination_messaging_public_key,e.manifest_bytes,e.manifest_digest,e.source_messaging_public_key,e.custody_profile
        FROM provider_migration_fences f JOIN provider_migration_exports e ON e.transfer_id=f.transfer_id WHERE f.did=${plan.did} AND f.transfer_id=${plan.transfer_id} FOR UPDATE OF f`)[0];
      if(!row||row.state!=='exported'||row.destination_service_base!==plan.destination_service_base||row.destination_messaging_public_key!==plan.destination_messaging_key||!same(hash(row.manifest_bytes),row.manifest_digest))throw new Error('No exact fenced export authorizes source freeze issuance');
      const m=manifestFor(row.manifest_bytes,row.custody_profile);
      if(!m.connections||m.accountId!==row.account_id||m.sourceServiceBase!==this.base||m.did!==plan.did)throw new Error('Source freeze differs from the fenced account');
      assertConnectionHandoverSelection(plan,{transferId:m.transferId,snapshotDigest:new Uint8Array(row.manifest_digest),history:m.connections,peerDid:plan.peer_did,
        destinationServiceBase:row.destination_service_base,destinationMessagingKey:row.destination_messaging_public_key});
      if(!connectionHandoverPeers(m.connections).includes(plan.peer_did))throw new Error('Source freeze names another peer');
      if(!forAbort){
        const retained=new Set(m.connections.tables.connection_handover_barriers.map(r=>String(r.plan_digest)));
        const live=await tx<{plan_digest:Uint8Array}[]>`SELECT plan_digest FROM connection_handover_barriers WHERE account_id=${m.accountId}`;
        if(live.some(r=>!retained.has('\\x'+Buffer.from(r.plan_digest).toString('hex'))))throw new Error('Peer handover history advanced after export; cancel and export again');
      }
      await verifyConnectionHandoverSignature(destination,'destination-freeze',row.destination_messaging_public_key);
      const resolved=await this.resolver.resolve(plan.did),key=await new OnboardingRepository(tx as SQL).getKey(m.accountId,'hail-messaging');
      if(resolved.did!==m.did||resolved.serviceBase!==this.base||resolved.messagingDidKey!==row.source_messaging_public_key||key.publicKey!==resolved.messagingDidKey)throw new Error('Source authority changed before freeze issuance');
      await requireFreshPublicAuthority(tx as SQL,resolved.evidence,{did:m.did,role:'hail-messaging',key:key.publicKey,serviceBase:this.base},new Date());
      const raw=await this.encryptor.decrypt(m.accountId,key.role,key.algorithm,key.publicKey,key);
      try{return {proposal:encodeSignedRecord(await signConnectionHandover(plan,'source-freeze',await importEd25519PrivateKey(raw)))};}finally{raw.fill(0);}
    });
  }
  async sourceRetire(input:unknown){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).join(',')!=='receipt')throw new Error('Invalid source retirement request');
    const signed=decodeSignedRecord((input as {receipt:unknown}).receipt),receipt=decodeDeterministic(signed.payloadBytes) as {did:string;transfer_id:string};
    if(typeof receipt.did!=='string'||!/^did:plc:[a-z2-7]{24}$/.test(receipt.did)||typeof receipt.transfer_id!=='string'||!/^[0-9a-f-]{36}$/.test(receipt.transfer_id))throw new Error('Invalid retirement subject');
    await new MigrationFenceService(this.sql,this.resolver,this.base).retire(receipt.did,receipt.transfer_id,signed);return {retired:true};
  }
  private async cancellation(value:Pick<Import,'manifest'|'digest'>,signed:SignedHandshake,fresh=false){
    const m=value.manifest,managed=m.custodyProfile==='managed',ownerKey=managed?m.ownerRecoveryPublicKey:String(m.tables.portable_custody_evidence[0]?.user_identity_public_key);
    const cancel=await verifyConnectionCancellation(signed,ownerKey,'owner-cancel',managed);
    if(cancel.did!==m.did||cancel.transfer_id!==m.transferId||cancel.source_service_base!==m.sourceServiceBase||cancel.destination_service_base!==m.destinationServiceBase||
      !same(cancel.snapshot_digest,value.digest)||fresh&&(cancel.issued_at>now()+300||cancel.expires_at<=now()))throw new Error('Owner cancellation differs from this exact transfer');
    return {cancel,ownerKey,managed};
  }
  async abort(input:unknown){
    const signed=decodeSignedRecord(input),cancel=decodeConnectionCancellation(signed),value=await this.imported(cancel.transfer_id,true),m=value.manifest;
    await this.sql.begin(async tx=>{
      const row=(await tx<{state:string;connection_cancellation_payload:Uint8Array|null;connection_cancellation_signature:Uint8Array|null}[]>`SELECT state,connection_cancellation_payload,connection_cancellation_signature
        FROM pending_migration_imports WHERE transfer_id=${m.transferId} FOR UPDATE`)[0];
      if(!row||!['staged','invalidated'].includes(row.state))throw new Error('A post-cutover import cannot be cancelled');
      if(row.connection_cancellation_payload){
        if(!same(row.connection_cancellation_payload,signed.payloadBytes)||!same(row.connection_cancellation_signature!,signed.signature))throw new Error('Another cancellation was already accepted');return;
      }
      await this.cancellation(value,signed,true);
      const current=await this.resolver.resolve(m.did);if(current.serviceBase!==m.sourceServiceBase)throw new Error('PLC cutover prevents cancellation');
      // The import-row lock also serializes PLC submission. This sticky marker
      // is committed before any release, so no concurrent completion can cut over.
      await tx`UPDATE pending_migration_imports SET connection_cancellation_payload=${signed.payloadBytes},connection_cancellation_signature=${signed.signature} WHERE transfer_id=${m.transferId}`;
    });
    if(value.state!=='invalidated'){
      // A fresh dual-signed abort may atomically acknowledge and release an
      // unobserved plan. Do not create new freezes while cancelling: the peer
      // may itself be moving, or a previous freeze reply may have been lost.
      for(const peer of m.connections?connectionHandoverPeers(m.connections):[]){
        const job=(await this.sql<{state:string;plan_bytes:Uint8Array;source_signature:Uint8Array;destination_signature:Uint8Array;plan_digest:Uint8Array}[]>`
          SELECT state,plan_bytes,source_signature,destination_signature,plan_digest FROM connection_import_handovers WHERE account_id=${m.accountId} AND transfer_id=${m.transferId} AND peer_did=${peer}`)[0];
        if(job?.state==='released')continue;
        const proposal=job?{payloadBytes:new Uint8Array(job.plan_bytes),signature:new Uint8Array(job.destination_signature)}:await this.command(value,peer,'freeze',key=>signConnectionHandover(
          createConnectionHandoverPlan(m.connections!,{transferId:m.transferId,requestId:randomUUID(),peerDid:peer,destinationServiceBase:this.base,destinationMessagingKey:m.destinationMessagingPublicKey,snapshotDigest:value.digest,issuedAt:now()}),'destination-freeze',key));
        const build=(key:CryptoKey)=>{
          const abort:ConnectionHandoverAbort={type:'hail.connection-handover-abort',version:1,request_id:randomUUID(),transfer_id:m.transferId,did:m.did,peer_did:peer,
            plan_digest:connectionHandoverPlanDigest(proposal.payloadBytes),issued_at:now(),expires_at:now()+300};return signConnectionHandoverAbort(abort,'destination-abort',key);
        };
        let command=await this.command(value,peer,'abort',build);
        for(let retry=0;retry<2;retry++){
          const reply=await this.sourceRpc(value,'abort',{
            cancellation:encodeSignedRecord(signed),proposal:encodeSignedRecord(proposal),abort:encodeSignedRecord(command)}),source=decodeSignedRecord(reply.abort);
          if(!same(source.payloadBytes,command.payloadBytes))throw new Error('Source changed the exact abort command');
          try{
            const released=await this.peer(peer,'handover-abort',{abort:encodeSignedRecord(source),destinationSignature:encodeBase64Url(command.signature),proposal:reply.proposal,freezeDestinationSignature:encodeBase64Url(proposal.signature)});
            await this.reconstruction.acceptAbort({abort:encodeSignedRecord(source),destinationSignature:encodeBase64Url(command.signature),receipt:released.receipt,
              proposal:reply.proposal,freezeDestinationSignature:encodeBase64Url(proposal.signature),freezeReceipt:released.freezeReceipt});break;
          }catch(error){
            if(!(error instanceof RemoteConnectionError||error instanceof Error&&'status' in error)||Number((error as {status:number}).status)!==410||retry)throw error;
            command=await this.command(value,peer,'abort',build,command);
          }
        }
      }
      await this.sql.begin(async tx=>{
        if((await tx`SELECT 1 FROM connection_import_handovers WHERE account_id=${m.accountId} AND transfer_id=${m.transferId} AND state<>'released'`).length)throw new Error('Peer holds remain unresolved');
        await tx`UPDATE pending_migration_imports SET state='invalidated',invalidated_at=clock_timestamp() WHERE transfer_id=${m.transferId} AND state='staged'`;
      });
    }
    const releases=await this.sql<{peer_did:string;plan_bytes:Uint8Array;source_signature:Uint8Array;destination_signature:Uint8Array;release_payload:Uint8Array;release_peer_signature:Uint8Array}[]>`
      SELECT peer_did,plan_bytes,source_signature,destination_signature,release_payload,release_peer_signature FROM connection_import_handovers WHERE account_id=${m.accountId} AND transfer_id=${m.transferId} AND state='released'`;
    const destination=await crypto.subtle.sign('Ed25519',await this.destinationKey(value),connectionCancellationInput('destination-cancelled',signed.payloadBytes));
    await this.sourceRpc(value,'release',{cancellation:encodeSignedRecord(signed),destinationSignature:encodeBase64Url(new Uint8Array(destination)),releases:releases.map(r=>({
      proposal:encodeSignedRecord({payloadBytes:new Uint8Array(r.plan_bytes),signature:new Uint8Array(r.source_signature)}),destinationSignature:encodeBase64Url(new Uint8Array(r.destination_signature)),
      receipt:encodeSignedRecord({payloadBytes:new Uint8Array(r.release_payload),signature:new Uint8Array(r.release_peer_signature)})}))});
    await this.sql.begin(async tx=>{
      await tx`SELECT transfer_id FROM pending_migration_imports WHERE transfer_id=${m.transferId} AND state='invalidated' FOR UPDATE`;
      const slots=(await tx<{invitation:Record<string,unknown>;reservation:Record<string,unknown>|null}[]>`SELECT to_jsonb(i) AS invitation,to_jsonb(r) AS reservation FROM received_transfer_invitations i
        LEFT JOIN transfer_address_reservations r ON r.transfer_id=i.transfer_id WHERE i.transfer_id=${m.transferId}`)[0];
      if(slots){
        await tx`UPDATE pending_migration_imports SET connection_cancellation_slots=${JSON.stringify(slots)}::text::jsonb WHERE transfer_id=${m.transferId} AND connection_cancellation_slots IS NULL`;
        await tx`INSERT INTO cancelled_transfer_sessions(did,nonce,grant_digest,receipt_digest) VALUES(${m.did},${String(slots.invitation.nonce)},${Buffer.from(String(slots.invitation.grant_digest).slice(2),'hex')},${hash(signed.payloadBytes)}) ON CONFLICT DO NOTHING`;
        await tx`DELETE FROM transfer_address_reservations WHERE transfer_id=${m.transferId}`;
        if(slots.reservation?.reserved_account_id)await tx`DELETE FROM provider_accounts WHERE id=${String(slots.reservation.reserved_account_id)} AND did IS NULL AND onboarding_state='reserved'`;
        await tx`DELETE FROM received_transfer_invitations WHERE transfer_id=${m.transferId}`;
      }
      await tx`UPDATE prepared_migration_target_keys SET state='invalidated' WHERE transfer_id=${m.transferId} AND state='staged'`;
    });
    return {phase:'cancelled',transferId:m.transferId};
  }
  async sourceAbort(input:unknown){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='abort,cancellation,proposal')throw new Error('Invalid source abort request');
    const wire=input as Record<string,unknown>,proposal=decodeSignedRecord(wire.proposal,65536),plan=decodeConnectionHandover(proposal),destination=decodeSignedRecord(wire.abort),abort=decodeConnectionHandoverAbort(destination);
    const sourceProposal=await this.sourceFreeze({proposal:wire.proposal},true);
    const exported=(await this.sql<{manifest_bytes:Uint8Array;manifest_digest:Uint8Array;custody_profile:string}[]>`SELECT manifest_bytes,manifest_digest,custody_profile FROM provider_migration_exports WHERE transfer_id=${plan.transfer_id}`)[0]!;
    const m=manifestFor(exported.manifest_bytes,exported.custody_profile);await this.cancellation({manifest:m,digest:exported.manifest_digest},decodeSignedRecord(wire.cancellation));
    await verifyConnectionHandoverAbortSignature(destination,'destination-abort',m.destinationMessagingPublicKey);
    if(abort.did!==m.did||abort.peer_did!==plan.peer_did||abort.transfer_id!==m.transferId||!same(abort.plan_digest,connectionHandoverPlanDigest(proposal.payloadBytes)))throw new Error('Source abort differs from the fenced plan');
    const key=await new OnboardingRepository(this.sql).getKey(m.accountId,'hail-messaging'),raw=await this.encryptor.decrypt(m.accountId,key.role,key.algorithm,key.publicKey,key);
    try{return {abort:encodeSignedRecord(await signConnectionHandoverAbort(abort,'source-abort',await importEd25519PrivateKey(raw))),proposal:sourceProposal.proposal};}finally{raw.fill(0);}
  }
  async sourceRelease(input:unknown){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='cancellation,destinationSignature,releases')throw new Error('Invalid source release request');
    const wire=input as Record<string,unknown>,signed=decodeSignedRecord(wire.cancellation),cancel=decodeConnectionCancellation(signed);
    const previous=(await this.sql<{cancellation_payload:Uint8Array;cancellation_signature:Uint8Array}[]>`SELECT cancellation_payload,cancellation_signature FROM connection_transfer_aborts WHERE transfer_id=${cancel.transfer_id}`)[0];
    if(previous){if(!same(previous.cancellation_payload,signed.payloadBytes)||!same(previous.cancellation_signature,signed.signature))throw new Error('Another cancellation was archived');return {released:true};}
    const exported=(await this.sql<{manifest_bytes:Uint8Array;manifest_digest:Uint8Array;custody_profile:string}[]>`SELECT manifest_bytes,manifest_digest,custody_profile FROM provider_migration_exports WHERE transfer_id=${cancel.transfer_id}`)[0];
    if(!exported)throw new Error('No fenced export to release');
    const m=manifestFor(exported.manifest_bytes,exported.custody_profile),owner=await this.cancellation({manifest:m,digest:exported.manifest_digest},signed),
      destination=decodeSignedRecord({payload:encodeBase64Url(signed.payloadBytes),signature:wire.destinationSignature});
    await verifyConnectionCancellation(destination,m.destinationMessagingPublicKey,'destination-cancelled');
    const peers=m.connections?connectionHandoverPeers(m.connections):[],releases=wire.releases;
    if(!Array.isArray(releases)||releases.length!==peers.length)throw new Error('Missing peer releases');
    const seen=new Set<string>(),retained=[] as unknown[];
    for(const item of releases){
      if(!item||typeof item!=='object'||Object.keys(item).sort().join(',')!=='destinationSignature,proposal,receipt')throw new Error('Invalid peer release');
      const source=decodeSignedRecord(item.proposal,65536),plan=decodeConnectionHandover(source),receipt=decodeSignedRecord(item.receipt),abort=decodeConnectionHandoverAbort(receipt);
      if(seen.has(plan.peer_did)||!peers.includes(plan.peer_did))throw new Error('Release names another peer');seen.add(plan.peer_did);
      const retainedSource=decodeSignedRecord((await this.sourceFreeze({proposal:{payload:encodeBase64Url(source.payloadBytes),signature:item.destinationSignature}},true)).proposal,65536);
      if(!same(retainedSource.signature,source.signature))throw new Error('Peer release changed the source freeze signature');
      const peer=await this.resolver.resolve(plan.peer_did);
      await requireFreshPublicAuthority(this.sql,peer.evidence,{did:peer.did,role:'hail-messaging',key:peer.messagingDidKey,serviceBase:peer.serviceBase},new Date());
      await verifyConnectionHandoverAbortSignature(receipt,'peer-release',peer.messagingDidKey);
      if(abort.did!==m.did||abort.transfer_id!==m.transferId||abort.peer_did!==plan.peer_did||!same(abort.plan_digest,connectionHandoverPlanDigest(source.payloadBytes)))throw new Error('Peer release differs from the exact export');
      retained.push({...item,key:peer.messagingDidKey,authority:peer.evidence});
    }
    await this.sql.begin(async tx=>{
      await tx`SELECT id FROM provider_accounts WHERE id=${m.accountId} FOR UPDATE`;
      const fence=(await tx<{state:string;account_id:string;snapshot_digest:Uint8Array}[]>`SELECT state,account_id,snapshot_digest FROM provider_migration_fences WHERE transfer_id=${m.transferId} AND did=${m.did} FOR UPDATE`)[0],current=await this.resolver.resolve(m.did);
      if(!fence||fence.account_id!==m.accountId||fence.state!=='exported'||!same(fence.snapshot_digest,exported.manifest_digest)||current.serviceBase!==this.base)throw new Error('PLC cutover or changed fence prevents source release');
      await requireFreshPublicAuthority(tx as SQL,current.evidence,{did:m.did,role:'hail-messaging',key:current.messagingDidKey,serviceBase:this.base},new Date());
      const archive=(await tx<{f:unknown;e:unknown;a:unknown}[]>`SELECT to_jsonb(f) AS f,to_jsonb(e) AS e,to_jsonb(a) AS a FROM provider_migration_fences f
        JOIN provider_migration_exports e ON e.transfer_id=f.transfer_id JOIN provider_transfer_authorizations a ON a.did=f.did WHERE f.transfer_id=${m.transferId}`)[0]!;
      // ponytail: retain the whole cancelled snapshot within the 64 MiB history
      // ceiling; content-address archived snapshots if repeated cancels outgrow it.
      await tx`INSERT INTO connection_transfer_aborts(account_id,transfer_id,cancellation_payload,cancellation_signature,destination_signature,owner_key,managed_owner,source_authority,archive)
        VALUES(${m.accountId},${m.transferId},${signed.payloadBytes},${signed.signature},${destination.signature},${owner.ownerKey},${owner.managed},${JSON.stringify(current.evidence)}::text::jsonb,
          ${JSON.stringify({fence:archive.f,export:archive.e,authorization:archive.a,releases:retained,destinationKey:m.destinationMessagingPublicKey})}::text::jsonb)`;
      // Exact signed history has been archived above. Only reusable live transfer
      // slots are removed; account, keys, messages and invitation codes stay put.
      await tx`DELETE FROM provider_migration_exports WHERE transfer_id=${m.transferId}`;
      await tx`DELETE FROM provider_transfer_authorizations WHERE did=${m.did} AND consumed_transfer_id=${m.transferId}`;
      await tx`DELETE FROM provider_migration_fences WHERE transfer_id=${m.transferId} AND state='exported'`;
    });
    return {released:true};
  }
}
