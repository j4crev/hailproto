import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {cidForCbor} from '@atproto/common';
import {encode as encodeDagCbor} from '@ipld/dag-cbor';
import {def,formatDidDoc,validateOperationLog,type DocumentData} from '@did-plc/lib';
import {createWebCryptoVerifier,decodeBase64Url,decodeDeterministic,encodeDeterministic,inspectSignedPayload,verifySignedPayload,type HailSignedPayloadType,type HailValue} from '@hailproto/codec';
import {ed25519PublicKeyFromDidKey} from '../identity/did-key.js';
import {parseJsonWithoutDuplicateKeys} from '../discovery/strict-json.js';
import {assertPublicAuthorityFresh} from '../plc/authority.js';
import {PUBLIC_EVIDENCE_LIMITS,encodePublicEvidence,validatePlcReadEvidence} from '../plc/read-evidence.js';
import {canonicalizeHailServiceBase,type HailDidResolver,type PlcResolutionEvidence} from '../plc/resolver.js';
import {withAbort} from '../plc/client.js';
import {inspectConnectionProof,type ConnectionHistory} from './connection-history.js';
import {decodeConnectionHandover,verifyConnectionHandoverSignature,verifyConnectionHandoverAbortSignature,verifyConnectionHandoverTransitionSignature,
  verifyConnectionHandoverResult,connectionHandoverPlanDigest,connectionActivationDigest} from './connection-handover.js';
import {verifyActivationReceipt} from './activation-receipt.js';
import {verifyConnectionCancellation} from './connection-cancellation.js';
import {decodeSignedRecord} from './wire.js';
import {managedSnapshotSignatureInput} from './managed-snapshot.js';
import {transferSnapshotSignatureInput} from './transfer.js';
import {assertConnectionHandoverSelection,decodeConnectionHandoverAbort} from './connection-handover.js';

const hash=(bytes:Uint8Array)=>new Uint8Array(createHash('sha256').update(bytes).digest());
const hex=(bytes:Uint8Array)=>'\\x'+Buffer.from(bytes).toString('hex');
const same=(a:Uint8Array,b:Uint8Array)=>Buffer.from(a).equals(Buffer.from(b));
const equivalent=(a:unknown,b:unknown)=>same(encodePublicEvidence(a as HailValue),encodePublicEvidence(b as HailValue));
function bytes(value:unknown,max=16384):Uint8Array {
  if(typeof value!=='string'||!/^\\x(?:[0-9a-f]{2})+$/.test(value)||value.length>2+max*2)throw new Error('Invalid historical connection bytes');
  return new Uint8Array(Buffer.from(value.slice(2),'hex'));
}
type ProofKind=Extract<HailSignedPayloadType,'hail.connection-invitation'|'hail.connection-confirmation'|'hail.connection-control'|'hail.connection-grant'|'hail.address-binding'>;

// The configured resolver establishes today's canonical chain. Historical COSE
// must name a key in its retained, still-canonical prefix, not today's rotated key
// and not an arbitrary key guessed from every past operation. No live rows change.
// Call after structural manifest/checkpoint validation; this is the authority pass.
export async function verifyConnectionHistoryAuthority(history:ConnectionHistory,resolver:HailDidResolver,now=new Date()):Promise<void> {
  // ponytail: one bounded verification pass; checkpoint verification can be paged
  // if large histories cannot finish within the 30-second staging budget.
  const deadline=AbortSignal.timeout(30_000);
  const current=new Map<string,Promise<{state:DocumentData;cids:string[]}>>(),authorities=new Map<string,Promise<DocumentData>>();
  const bundles=new Map(history.tables.public_plc_resolution_evidence.map(r=>[r.evidence_digest,r]));
  const canonical=(did:string)=>{
    let pending=current.get(did);
    if(!pending){pending=(async()=>{
      const resolved=await withAbort(resolver.resolve(did),deadline),log=resolved.evidence.log.map(op=>def.compatibleOpOrTombstone.parse(op));
      if(!log.length||log.length>1000)throw new Error('Historical connection needs a bounded current PLC chain');
      const state=await validateOperationLog(did,log);
      if(!state||resolved.did!==did||!isDeepStrictEqual(state,resolved.evidence.data)||!isDeepStrictEqual(formatDidDoc(state),resolved.evidence.document)||
        state.verificationMethods['hail-identity']!==resolved.identityDidKey||state.verificationMethods['hail-messaging']!==resolved.messagingDidKey||
        state.services.hail?.type!=='HailMessaging'||canonicalizeHailServiceBase(state.services.hail.endpoint)!==resolved.serviceBase)
        throw new Error('Current PLC authority disagrees with its canonical connection chain');
      const cids=await Promise.all(log.map(op=>cidForCbor(op).then(cid=>cid.toString()))),ref=resolved.evidence.verification;
      if(ref?.profile==='poc-local'){
        const stamp=Date.parse(ref.verifiedAt);if(!Number.isFinite(stamp)||Math.abs(now.getTime()-stamp)>30000||ref.operationCid!==cids.at(-1))throw new Error('Current private PLC authority is stale or inconsistent');
      }else assertPublicAuthorityFresh(resolved.evidence,now);
      return {state,cids};
    })();current.set(did,pending);}return pending;
  };
  const authority=(raw:unknown,did:string)=>{
    deadline.throwIfAborted();
    const value=typeof raw==='string'?parseJsonWithoutDuplicateKeys(raw):raw;
    const key=did+'\0'+JSON.stringify(value);let pending=authorities.get(key);
    if(!pending){pending=(async()=>{
      const evidence=value as PlcResolutionEvidence;
      if(!evidence||!Array.isArray(evidence.log)||!evidence.log.length||evidence.log.length>1000)throw new Error('Missing historical connection signing authority');
      const log=evidence.log.map(op=>def.compatibleOpOrTombstone.parse(op)),state=await validateOperationLog(did,log);
      if(!state||!isDeepStrictEqual(state,evidence.data)||!isDeepStrictEqual(formatDidDoc(state),evidence.document)||state.services.hail?.type!=='HailMessaging')
        throw new Error('Historical PLC evidence does not authenticate its connection signer');
      const cids=await Promise.all(log.map(op=>cidForCbor(op).then(cid=>cid.toString()))),head=cids.at(-1)!,latest=await canonical(did);
      if(cids.length>latest.cids.length||cids.some((cid,index)=>cid!==latest.cids[index]))throw new Error('Historical connection authority is no longer canonical');
      if(evidence.verification?.profile==='poc-local'){
        if(evidence.verification.operationCid!==head||!Number.isFinite(Date.parse(evidence.verification.verifiedAt)))throw new Error('Historical private PLC authority is inconsistent');
      }else if(evidence.verification){
        const ref=evidence.verification,row=bundles.get(hex(decodeBase64Url(ref.digest))),stamp=Date.parse(ref.verifiedAt);
        if(ref.profile!=='strict-public-v1'||ref.operationCid!==head||!Number.isFinite(stamp)||!row||row.did!==did||row.operation_cid!==head||Date.parse(String(row.verified_at))!==stamp)
          throw new Error('Missing or mismatched historical public connection authority');
        const bundleBytes=bytes(row.bundle_bytes,PUBLIC_EVIDENCE_LIMITS.maximumBytes);
        if(hex(hash(bundleBytes))!==row.evidence_digest)throw new Error('Historical public connection authority digest differs');
        const bundle=decodeDeterministic(bundleBytes,PUBLIC_EVIDENCE_LIMITS) as Record<string,any>;
        if(bundle.type!=='hail.public-plc-resolution'||bundle.version!==1||bundle.policy!=='strict-public-v1'||bundle.registry_origin!=='https://plc.directory'||
          bundle.did!==did||bundle.operation_cid!==head||bundle.verified_at!==ref.verifiedAt||!Array.isArray(bundle.witnesses)||bundle.witnesses.length<1||bundle.witnesses.length>2)
          throw new Error('Invalid historical public connection authority bundle');
        for(const witness of bundle.witnesses){
          if(!witness||!equivalent(witness.state,state)||!equivalent(witness.log,evidence.log)||!equivalent(witness.document,evidence.document))
            throw new Error('Historical connection witness differs from the retained signer');
          const checked=await validatePlcReadEvidence(did,evidence,witness.audit);
          if(!Array.isArray(witness.signed_operations)||witness.signed_operations.length!==checked.audit.length||
            witness.signed_operations.some((op:any,index:number)=>!op||op.cid!==checked.audit[index]!.cid||!(op.dag_cbor instanceof Uint8Array)||!same(op.dag_cbor,new Uint8Array(encodeDagCbor(checked.audit[index]!.operation)))))
            throw new Error('Historical PLC signed operation bytes differ from their audit');
        }
      }
      return state;
    })();authorities.set(key,pending);}return pending;
  };
  async function signed<T extends ProofKind>(kind:T,cose:Uint8Array,evidence:unknown){
    const inspected=inspectSignedPayload(kind,cose),p=inspected.payload;
    const did='grantor' in p?p.grantor:'from' in p?p.from:p.did,role=kind==='hail.connection-control'?'hail-messaging':'hail-identity';
    const state=await authority(evidence,did),key=state.verificationMethods[role];
    if(typeof key!=='string')throw new Error('Historical connection signing role is missing');
    await verifySignedPayload(kind,cose,createWebCryptoVerifier(async kid=>{
      if(kid!==did+'#'+role)throw new Error('Historical connection signing purpose differs');return ed25519PublicKeyFromDidKey(key);
    }));
    return {payload:p,state,key};
  }
  for(const invitation of history.tables.connection_invitations){
    const checked=await signed('hail.connection-invitation',bytes(invitation.cose),invitation.signing_evidence);
    if(checked.key!==invitation.signing_key)throw new Error('Historical invitation signer metadata differs');
  }
  for(const pair of history.tables.account_connections){
    if(!['active','disconnected'].includes(String(pair.state)))continue;
    const invitation=inspectSignedPayload('hail.connection-invitation',bytes(pair.invitation_cose)).payload;
    const confirmation=inspectSignedPayload('hail.connection-confirmation',bytes(pair.confirmation_cose)).payload;
    const evidence=(did:string)=>did===pair.did_a?pair.evidence_a:did===pair.did_b?pair.evidence_b:undefined;
    await signed('hail.connection-invitation',bytes(pair.invitation_cose),evidence(invitation.from));
    await signed('hail.connection-confirmation',bytes(pair.confirmation_cose),evidence(confirmation.from));
    if(pair.consent_format==='grants-v1')for(const side of ['a','b']){
      const checked=await signed('hail.connection-grant',bytes(pair['grant_'+side+'_cose']),pair['evidence_'+side]);
      if(checked.payload.revision!==1||checked.payload.previous!==null||checked.payload.status!=='active')throw new Error('Historical native consent is not its original standing Grant');
    }
  }
  const ledger=new Map(history.tables.federated_connection_signatures.map(r=>[r.digest,r]));
  for(const row of ledger.values()){
    const cose=bytes(row.cose),kind=inspectConnectionProof(cose).payload.type;
    await signed(kind,cose,row.authority);
  }
  async function retained<T extends ProofKind>(kind:T,cose:Uint8Array){
    const row=ledger.get(hex(hash(cose)));
    if(!row||!same(bytes(row.cose),cose))throw new Error('Missing retained authority for historical peer proof');
    return signed(kind,cose,row.authority);
  }
  const emptyHash=hash(new Uint8Array());
  for(const attempt of history.tables.federated_connection_attempts){
    const bundleBytes=bytes(attempt.bundle,100000),bundle=decodeDeterministic(bundleBytes) as Record<string,unknown>;
    if(!bundle||Object.keys(bundle).sort().join(',')!=='confirmation,invitation,inviterBinding,scannerBinding,snapshot'||
      Object.values(bundle).some(v=>!(v instanceof Uint8Array)||!v.length||v.length>16384))throw new Error('Invalid historical connection proof bundle');
    const b=bundle as Record<string,Uint8Array>,inviter=await retained('hail.connection-invitation',b.invitation!),scanner=await retained('hail.connection-confirmation',b.confirmation!);
    const invitation=inviter.payload,confirmation=scanner.payload;
    const ib=await signed('hail.address-binding',b.inviterBinding!,ledger.get(hex(hash(b.invitation!)))!.authority);
    const sb=await signed('hail.address-binding',b.scannerBinding!,ledger.get(hex(hash(b.confirmation!)))!.authority);
    const snapshot=(await retained('hail.connection-control',b.snapshot!)).payload,[small,large]=[invitation.from,confirmation.from].sort();
    if(ib.payload.did!==invitation.from||sb.payload.did!==confirmation.from||
      snapshot.operation!=='snapshot'||snapshot.from!==small||snapshot.to!==large||snapshot.request_id!==confirmation.confirmation_id||!same(snapshot.proof_hash.value,emptyHash)||
      attempt.direction==='outbound'&&confirmation.from!==history.did||attempt.direction==='admitted'&&invitation.from!==history.did)
      throw new Error('Historical connection consent has the wrong participants or reviewed epoch');
    const proof=hash(bundleBytes);
    if(attempt.admission_cose!==null){
      const admission=(await retained('hail.connection-control',bytes(attempt.admission_cose))).payload;
      if(admission.operation!=='admission'||admission.from!==invitation.from||admission.to!==confirmation.from||admission.request_id!==confirmation.confirmation_id||
        admission.epoch!==snapshot.epoch||admission.state!==snapshot.state||admission.connection_id!==snapshot.connection_id||!same(admission.proof_hash.value,proof)||
        admission.issued_at>=confirmation.expires_at||invitation.expires_at!==null&&admission.issued_at>=invitation.expires_at)
        throw new Error('Historical admission differs from its consent and epoch');
    }
    if(attempt.result_cose!==null){
      const result=(await retained('hail.connection-control',bytes(attempt.result_cose))).payload;
      if(result.operation!=='snapshot'||result.from!==small||result.to!==large||result.request_id!==confirmation.confirmation_id||result.state!=='active'||
        !same(result.proof_hash.value,proof)||(snapshot.state==='active'?result.epoch!==snapshot.epoch||result.connection_id!==snapshot.connection_id:result.epoch!==snapshot.epoch+1)||
        result.issued_at>=confirmation.expires_at||invitation.expires_at!==null&&result.issued_at>=invitation.expires_at)
        throw new Error('Historical activation differs from its admitted consent');
    }
  }
  for(const result of history.tables.federated_connection_results)await retained('hail.connection-control',bytes(result.request_cose));
  for(const disconnect of history.tables.federated_connection_disconnects){
    const result=(await retained('hail.connection-control',bytes(disconnect.result_cose))).payload;
    if(result.operation!=='snapshot'||result.request_id!==disconnect.id||result.state!=='disconnected'||result.connection_id!==disconnect.connection_id||
      result.epoch<=Number(disconnect.epoch)||!same(result.proof_hash.value,hash(encodeDeterministic({connection_id:disconnect.connection_id as string}))))
      throw new Error('Historical disconnect receipt differs from its terminal intent');
  }
  for(const outbox of history.tables.federated_connection_outbox){
    const ack=(await retained('hail.connection-control',bytes(outbox.ack_cose))).payload;
    const original=ledger.get(hex(ack.proof_hash.value));
    if(!original)throw new Error('Historical acknowledgement lost its signed delivery');
    const delivered=(await retained('hail.connection-control',bytes(original.cose))).payload;
    if(ack.operation!=='ack'||delivered.operation!=='snapshot'||ack.from!==delivered.to||ack.to!==delivered.from||ack.request_id!==delivered.request_id||
      ack.connection_id!==delivered.connection_id||ack.epoch!==delivered.epoch||ack.state!==delivered.state)throw new Error('Historical acknowledgement differs from its delivery');
  }
  const record=(row:Record<string,unknown>,payload:string,signature:string,max=65536)=>({payloadBytes:bytes(row[payload],max),signature:bytes(row[signature],64)});
  const messaging=async(raw:unknown,did:string)=>{const state=await authority(raw,did),key=state.verificationMethods['hail-messaging'];if(typeof key!=='string')throw new Error('Historical handover messaging role is missing');return {state,key};};
  for(const row of history.tables.connection_transfer_aborts){
    const source=await messaging(row.source_authority,history.did),cancelSigned=record(row,'cancellation_payload','cancellation_signature',4096),
      cancel=await verifyConnectionCancellation(cancelSigned,String(row.owner_key),'owner-cancel',row.managed_owner===true),archive=row.archive as Record<string,any>,exported=archive?.export;
    if(cancel.did!==history.did||cancel.transfer_id!==row.transfer_id||canonicalizeHailServiceBase(source.state.services.hail!.endpoint)!==cancel.source_service_base||
      row.owner_key!==(row.managed_owner?source.state.rotationKeys[0]:source.state.verificationMethods['hail-identity']))throw new Error('Historical cancellation has another owner');
    const snapshot=bytes(exported?.manifest_bytes,67108864),digest=hash(snapshot),m=parseJsonWithoutDuplicateKeys(new TextDecoder('utf-8',{fatal:true}).decode(snapshot)) as any;
    if(!same(digest,cancel.snapshot_digest)||!same(digest,bytes(exported.manifest_digest,32))||m.did!==history.did||m.accountId!==history.accountId||m.transferId!==row.transfer_id||
      m.sourceServiceBase!==cancel.source_service_base||m.destinationServiceBase!==cancel.destination_service_base||m.destinationMessagingPublicKey!==archive.destinationKey||exported.source_messaging_public_key!==source.key||
      ![5,6].includes(m.version)||!await crypto.subtle.verify('Ed25519',await ed25519PublicKeyFromDidKey(source.key),Uint8Array.from(bytes(exported.signature,64)),
        m.version===6?managedSnapshotSignatureInput(digest,6):transferSnapshotSignatureInput(digest,5)))throw new Error('Historical cancellation lost its exact source snapshot');
    await verifyConnectionCancellation({...cancelSigned,signature:bytes(row.destination_signature,64)},m.destinationMessagingPublicKey,'destination-cancelled');
    const peers=new Set<string>(m.connections?.tables.federated_connection_pairs.filter((p:any)=>p.state!=='empty').map((p:any)=>p.peer_did)??[]),seen=new Set<string>();
    if(!Array.isArray(archive.releases)||archive.releases.length!==peers.size)throw new Error('Historical cancellation lost peer releases');
    for(const release of archive.releases){
      const signed=decodeSignedRecord(release.proposal,65536),plan=decodeConnectionHandover(signed),receipt=decodeSignedRecord(release.receipt),abort=decodeConnectionHandoverAbort(receipt);
      if(seen.has(plan.peer_did)||!peers.has(plan.peer_did))throw new Error('Historical cancellation has another peer');seen.add(plan.peer_did);
      assertConnectionHandoverSelection(plan,{transferId:m.transferId,snapshotDigest:digest,history:m.connections,peerDid:plan.peer_did,destinationServiceBase:m.destinationServiceBase,destinationMessagingKey:m.destinationMessagingPublicKey});
      await verifyConnectionHandoverSignature(signed,'source-freeze',source.key);
      await verifyConnectionHandoverSignature(decodeSignedRecord({payload:release.proposal.payload,signature:release.destinationSignature},65536),'destination-freeze',m.destinationMessagingPublicKey);
      const peer=await messaging(release.authority,plan.peer_did);
      if(peer.key!==release.key||abort.did!==m.did||abort.peer_did!==plan.peer_did||abort.transfer_id!==m.transferId||!same(abort.plan_digest,connectionHandoverPlanDigest(signed.payloadBytes)))throw new Error('Historical cancellation peer release differs');
      await verifyConnectionHandoverAbortSignature(receipt,'peer-release',peer.key);
    }
  }
  for(const [rows,peerSide] of [[history.tables.connection_handover_barriers,true],[history.tables.connection_import_handovers,false]] as const)for(const row of rows){
    const source=record(row,'plan_bytes','source_signature'),plan=decodeConnectionHandover(source),planDigest=connectionHandoverPlanDigest(source.payloadBytes);
    if(hex(planDigest)!==row.plan_digest||plan.transfer_id!==row.transfer_id||(peerSide?plan.peer_did!==history.did||plan.did!==row.moving_did:plan.did!==history.did||plan.peer_did!==row.peer_did))throw new Error('Historical handover journal has another account or plan');
    const src=await messaging(row.source_authority,plan.did);
    if(src.key!==row.source_messaging_key||canonicalizeHailServiceBase(src.state.services.hail!.endpoint)!==plan.source_service_base)throw new Error('Historical handover source role differs');
    await verifyConnectionHandoverSignature(source,'source-freeze',src.key);
    await verifyConnectionHandoverSignature({...source,signature:bytes(row.destination_signature,64)},'destination-freeze',plan.destination_messaging_key);
    const peer=await messaging(row[peerSide?'peer_authority':'peer_freeze_authority'],plan.peer_did);
    if(peer.key!==row[peerSide?'peer_messaging_key':'peer_freeze_key'])throw new Error('Historical handover peer role differs');
    await verifyConnectionHandoverSignature({...source,signature:bytes(row[peerSide?'peer_signature':'peer_freeze_signature'],64)},'peer-freeze',peer.key);
    if(row.state==='released'){
      const release=record(row,'release_payload','release_source_signature',4096),releasing=await messaging(row.release_source_authority,plan.did);
      if(canonicalizeHailServiceBase(releasing.state.services.hail!.endpoint)!==plan.source_service_base)throw new Error('Historical abort did not belong to the source');
      const abort=await verifyConnectionHandoverAbortSignature(release,'source-abort',releasing.key);
      if(abort.did!==plan.did||abort.peer_did!==plan.peer_did||abort.transfer_id!==plan.transfer_id||!same(abort.plan_digest,planDigest))throw new Error('Historical abort targets another plan');
      await verifyConnectionHandoverAbortSignature({...release,signature:bytes(row.release_destination_signature,64)},'destination-abort',plan.destination_messaging_key);
      const released=await messaging(row.release_peer_authority,plan.peer_did);
      if(released.key!==row.release_peer_key)throw new Error('Historical release peer role differs');
      await verifyConnectionHandoverAbortSignature({...release,signature:bytes(row.release_peer_signature,64)},'peer-release',released.key);
      continue;
    }
    if(row.state!=='completed')throw new Error('Historical handover journal is unfinished');
    const moving=await messaging(row.commit_moving_authority,plan.did);
    if(moving.key!==plan.destination_messaging_key||canonicalizeHailServiceBase(moving.state.services.hail!.endpoint)!==plan.destination_service_base)throw new Error('Historical commit was not authorized by PLC destination state');
    const binding=await signed('hail.address-binding',bytes(row.destination_binding),row.commit_moving_authority),bindingDigest=hash(bytes(row.destination_binding));
    if(binding.payload.did!==plan.did)throw new Error('Historical handover binding belongs to another DID');
    const known=new Set([...plan.frontier.native.map(n=>n.connectionId),...(plan.frontier.federated?[plan.frontier.federated.connectionId,...plan.frontier.federated.tombstones.map(t=>t.connectionId)]:[])]);
    let previousTerminals=[...plan.frontier.native.filter(n=>n.state==='disconnected').map(n=>n.connectionId),...(plan.frontier.federated?.tombstones.map(t=>t.connectionId)??[])];
    for(const prefix of ['commit','completion'] as const){
      const command=record(row,prefix+'_payload',prefix+'_signature',4096),transition=await verifyConnectionHandoverTransitionSignature(command,moving.key);
      if(transition.action!==(prefix==='commit'?'commit':'complete')||transition.did!==plan.did||transition.peer_did!==plan.peer_did||transition.transfer_id!==plan.transfer_id||
        !same(transition.plan_digest,planDigest)||!same(transition.binding_digest,bindingDigest))throw new Error('Historical transition targets another handover');
      const responder=await messaging(row['peer_'+prefix+'_authority'],plan.peer_did);
      if(responder.key!==row['peer_'+prefix+'_key'])throw new Error('Historical transition peer key differs');
      const response=await verifyConnectionHandoverResult(record(row,'peer_'+prefix+'_payload','peer_'+prefix+'_signature'),responder.key);
      if(response.phase!==(prefix==='commit'?'committed':'completed')||response.did!==plan.did||response.peer_did!==plan.peer_did||response.transfer_id!==plan.transfer_id||
        !same(response.plan_digest,planDigest)||!same(response.request_digest,hash(command.payloadBytes))||response.terminal_ids.some(id=>!known.has(id))||
        previousTerminals.some(id=>!response.terminal_ids.includes(id)))throw new Error('Historical handover result lost its request or terminal history');
      previousTerminals=response.terminal_ids;
      if(prefix==='completion'){
        const activation=record(row,'activation_payload','activation_signature',16384),receipt=await verifyActivationReceipt(activation,moving.key,Math.floor(now.getTime()/1000));
        if(!same(connectionActivationDigest(activation),transition.activation_digest!)||receipt.did!==plan.did||receipt.transfer_id!==plan.transfer_id||receipt.destination_service_base!==plan.destination_service_base||
          receipt.destination_address!==binding.payload.address||!same(receipt.snapshot_digest,plan.snapshot_digest)||!same(receipt.address_binding_digest,bindingDigest))throw new Error('Historical handover activation receipt differs');
      }
    }
  }
}
