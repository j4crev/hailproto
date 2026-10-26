import {createHash,randomUUID} from 'node:crypto';
import {P256Keypair} from '@atproto/crypto';
import {cidForCbor} from '@atproto/common';
import {encode as encodeDagCbor} from '@ipld/dag-cbor';
import {didForCreateOp,formatDidDoc,signOperation,validateOperationLog} from '@did-plc/lib';
import {base58btc} from 'multiformats/bases/base58';
import {createWebCryptoSigner,encodeBase64Url,inspectSignedPayload,signPayload} from '@hailproto/codec';
import {expect,it} from 'vitest';
import {CONNECTION_HISTORY_COLUMNS,validateConnectionHistory,type ConnectionHistory} from '../src/migration/connection-history.js';
import {verifyConnectionHistoryAuthority} from '../src/migration/connection-history-verification.js';
import {encodePublicEvidence} from '../src/plc/read-evidence.js';
import type {HailDidResolver,PlcResolutionEvidence} from '../src/plc/resolver.js';
import {uuidV7} from '../src/identity/uuid-v7.js';

const hash=(v:Uint8Array)=>new Uint8Array(createHash('sha256').update(v).digest());
const hex=(v:Uint8Array)=>'\\x'+Buffer.from(v).toString('hex');
const pg=(v:unknown)=>new Uint8Array(Buffer.from(String(v).slice(2),'hex'));
async function key(){
  const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']),raw=new Uint8Array(34);
  raw.set([0xed,1]);raw.set(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey)),2);
  return {privateKey:pair.privateKey,didKey:'did:key:'+base58btc.encode(raw)};
}
async function actor(){
  const root=await P256Keypair.create(),identity=await key(),messaging=await key();
  const operation=await signOperation({type:'plc_operation',prev:null,rotationKeys:[root.did()],alsoKnownAs:[],
    verificationMethods:{'hail-identity':identity.didKey,'hail-messaging':messaging.didKey},services:{hail:{type:'HailMessaging',endpoint:'https://source.example/hail'}}},root);
  return {root,identity,messaging,did:await didForCreateOp(operation),id:randomUUID(),log:[operation]};
}
type Actor=Awaited<ReturnType<typeof actor>>;
async function evidence(a:Actor):Promise<PlcResolutionEvidence>{const state=(await validateOperationLog(a.did,a.log))!;return {document:formatDidDoc(state),data:state,log:[...a.log]};}
async function rotate(a:Actor,log=a.log){
  const identity=await key(),messaging=await key(),state=(await validateOperationLog(a.did,log))!;
  const next=await signOperation({type:'plc_operation',prev:(await cidForCbor(log.at(-1)!)).toString(),rotationKeys:state.rotationKeys,alsoKnownAs:state.alsoKnownAs,
    verificationMethods:{'hail-identity':identity.didKey,'hail-messaging':messaging.didKey},services:state.services},a.root);
  a.identity=identity;a.messaging=messaging;a.log=[...log,next];
}
const row=(table:keyof ConnectionHistory['tables'],fields:Record<string,unknown>)=>({...Object.fromEntries(CONNECTION_HISTORY_COLUMNS[table].split(' ').map(k=>[k,null])),...fields});
async function fixture(){
  const actors=await Promise.all([actor(),actor()]);actors.sort((a,b)=>a.did.localeCompare(b.did));const [a,b]=actors as [Actor,Actor];
  const owner={accountId:a.id,did:a.did,sourceGeneration:1,sourceServiceBase:'https://source.example/hail'};
  const history:ConnectionHistory={type:'hail.connection-history',version:3,...owner,capturedAt:new Date(150000).toISOString(),sharePolicy:'invalidate-at-cutover',
    tables:Object.fromEntries(Object.keys(CONNECTION_HISTORY_COLUMNS).map(t=>[t,[] as Record<string,unknown>[]])) as ConnectionHistory['tables']};
  const invitation=await signPayload('hail.connection-invitation',{type:'hail.connection-invitation',version:1,from:a.did,key_id:a.did+'#hail-identity',invitation_id:uuidV7(),
    token_hash:{algorithm:'sha-256',value:hash(new Uint8Array(32))},issued_at:100,expires_at:null},createWebCryptoSigner(a.did+'#hail-identity',a.identity.privateKey));
  const confirmation=await signPayload('hail.connection-confirmation',{type:'hail.connection-confirmation',version:1,from:b.did,to:a.did,key_id:b.did+'#hail-identity',confirmation_id:uuidV7(),
    invitation_id:inspectSignedPayload('hail.connection-invitation',invitation).payload.invitation_id,invitation_hash:{algorithm:'sha-256',value:hash(invitation)},issued_at:101,expires_at:200},
    createWebCryptoSigner(b.did+'#hail-identity',b.identity.privateKey));
  const ea=await evidence(a),eb=await evidence(b),payload=inspectSignedPayload('hail.connection-invitation',invitation).payload;
  history.tables.connection_invitations.push(row('connection_invitations',{id:payload.invitation_id,account_id:a.id,did:a.did,serving_generation:1,cose:hex(invitation),
    token_hash:hex(payload.token_hash.value),signing_key:a.identity.didKey,signing_evidence:ea}));
  history.tables.account_connections.push(row('account_connections',{id:uuidV7(),account_a:a.id,account_b:b.id,did_a:a.did,did_b:b.did,generation_a:1,generation_b:1,
    state:'active',consent_format:'joint-v1',invitation_cose:hex(invitation),confirmation_cose:hex(confirmation),evidence_a:ea,evidence_b:eb}));
  const resolver:HailDidResolver={async resolve(did){const actor=actors.find(a=>a.did===did);if(!actor)throw new Error('Unknown DID');const e=await evidence(actor),state=e.data as any;
    return {did,identityDidKey:state.verificationMethods['hail-identity'],messagingDidKey:state.verificationMethods['hail-messaging'],serviceBase:state.services.hail.endpoint,evidence:e};}};
  const check=(h=history)=>{validateConnectionHistory(new TextEncoder().encode(JSON.stringify(h)),owner);return verifyConnectionHistoryAuthority(h,resolver);};
  return {a,b,history,resolver,check};
}

it('verifies exact historical consent after both identity and messaging keys rotate',async()=>{
  const {a,b,history,check}=await fixture(),original=JSON.stringify(history);
  await rotate(a);await rotate(b);
  await expect(check()).resolves.toBeUndefined();
  expect(JSON.stringify(history)).toBe(original); // no rewriting to current keys
});

it('rejects a forged original signature and provider-key substitution for identity consent',async()=>{
  const {a,b,history,check}=await fixture(),native=history.tables.account_connections[0]!;
  const confirmation=pg(native.confirmation_cose);confirmation[confirmation.length-1]!^=1;native.confirmation_cose=hex(confirmation);
  await expect(check()).rejects.toThrow(/signature/i);
  native.confirmation_cose=hex(await signPayload('hail.connection-confirmation',inspectSignedPayload('hail.connection-confirmation',confirmation).payload,
    createWebCryptoSigner(b.did+'#hail-identity',b.messaging.privateKey)));
  await expect(check()).rejects.toThrow(/signature/i);
  native.evidence_b=await evidence(a);
  await expect(check()).rejects.toThrow();
});

it('refuses a validly signed branch that is no longer in the current canonical PLC chain',async()=>{
  const {a,b,history,check}=await fixture(),genesis=[...a.log];await rotate(a);
  const native=history.tables.account_connections[0]!,invitation=await signPayload('hail.connection-invitation',
    inspectSignedPayload('hail.connection-invitation',pg(native.invitation_cose)).payload,createWebCryptoSigner(a.did+'#hail-identity',a.identity.privateKey));
  native.invitation_cose=hex(invitation);native.evidence_a=await evidence(a);
  const oldConfirmation=inspectSignedPayload('hail.connection-confirmation',pg(native.confirmation_cose)).payload;
  native.confirmation_cose=hex(await signPayload('hail.connection-confirmation',{...oldConfirmation,invitation_hash:{algorithm:'sha-256',value:hash(invitation)}},
    createWebCryptoSigner(b.did+'#hail-identity',b.identity.privateKey)));
  Object.assign(history.tables.connection_invitations[0]!,{cose:hex(invitation),signing_key:a.identity.didKey,signing_evidence:native.evidence_a});
  await rotate(a,genesis); // independently valid recovery branch, not that prefix
  await expect(check()).rejects.toThrow('no longer canonical');
});

it('requires retained public authority bundles and checks their witness chain, not just their hash',async()=>{
  const {a,history,check,resolver}=await fixture(),e=await evidence(a),operationCid=(await cidForCbor(a.log[0]!)).toString(),verifiedAt=history.capturedAt;
  const bundle={type:'hail.public-plc-resolution',version:1,policy:'strict-public-v1',registry_origin:'https://plc.directory',did:a.did,operation_cid:operationCid,verified_at:verifiedAt,
    witnesses:[{document:e.document,state:e.data,log:e.log,audit:[{did:a.did,operation:a.log[0]!,cid:operationCid,nullified:false,createdAt:new Date(0).toISOString()}],
      signed_operations:[{cid:operationCid,dag_cbor:new Uint8Array(encodeDagCbor(a.log[0]!))}]}]};
  const install=()=>{const bytes=encodePublicEvidence(bundle as never),digest=hash(bytes),authority={...e,verification:{profile:'strict-public-v1' as const,digest:encodeBase64Url(digest),operationCid,verifiedAt}};
    history.tables.connection_invitations[0]!.signing_evidence=authority;history.tables.account_connections[0]!.evidence_a=authority;
    history.tables.public_plc_resolution_evidence=[{evidence_digest:hex(digest),bundle_bytes:hex(bytes),did:a.did,operation_cid:operationCid,verified_at:verifiedAt}];};
  install();await expect(check()).resolves.toBeUndefined();
  const saved=history.tables.public_plc_resolution_evidence;history.tables.public_plc_resolution_evidence=[];
  await expect(verifyConnectionHistoryAuthority(history,resolver)).rejects.toThrow('Missing or mismatched historical public');
  history.tables.public_plc_resolution_evidence=saved;
  bundle.witnesses[0]!.signed_operations[0]!.dag_cbor=new Uint8Array([1]);install();
  await expect(check()).rejects.toThrow('signed operation bytes');
  bundle.witnesses[0]!.signed_operations[0]!.dag_cbor=new Uint8Array(encodeDagCbor(a.log[0]!));
  bundle.witnesses[0]!.state={...e.data as object,verificationMethods:{'hail-identity':a.messaging.didKey}};
  install();await expect(check()).rejects.toThrow('witness');
});

it('preserves grants-v1 consent under its original identity roles after rotation',async()=>{
  const {a,b,history,check}=await fixture(),pair=history.tables.account_connections[0]!;pair.consent_format='grants-v1';
  for(const [side,actor,peer] of [['a',a,b],['b',b,a]] as const){
    const id=uuidV7();pair['grant_id_'+side]=id;
    pair['grant_'+side+'_cose']=hex(await signPayload('hail.connection-grant',{type:'hail.connection-grant',version:1,grant_id:id,
      connection_id:pair.id as string,revision:1,previous:null,grantor:actor.did,grantee:peer.did,status:'active',issued_at:102,updated_at:102,expires_at:null,
      key_id:actor.did+'#hail-identity',consent_context:{grantee_address:'peer@peer.example.com',address_binding_hash:{algorithm:'sha-256',value:new Uint8Array(32)},
        invitation_hash:{algorithm:'sha-256',value:hash(pg(pair.invitation_cose))},confirmation_hash:{algorithm:'sha-256',value:hash(pg(pair.confirmation_cose))}}},
      createWebCryptoSigner(actor.did+'#hail-identity',actor.identity.privateKey)));
  }
  await rotate(a);await rotate(b);await expect(check()).resolves.toBeUndefined();
  const bytes=pg(pair.grant_a_cose);bytes[bytes.length-1]!^=1;pair.grant_a_cose=hex(bytes);
  await expect(check()).rejects.toThrow(/signature/i);
});
