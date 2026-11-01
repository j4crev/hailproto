import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Hono} from 'hono';
import {expect,it} from 'vitest';
import {decodeDeterministic,encodeDeterministic,createWebCryptoVerifier,verifySignedPayload,type HailValue} from '@hailproto/codec';
import {verifyHandshake} from '../src/migration/handshake.js';
import {verifyManagedOwnerHandshake,verifyManagedProviderHandshake,verifyManagedHandshakeChain} from '../src/migration/managed-handshake.js';
import {verifyPortableMigrationConsent} from '../src/migration/consent.js';
import {verifyActivationReceipt} from '../src/migration/activation-receipt.js';
import {verifyConnectionHandover,verifyConnectionHandoverAbort,verifyConnectionHandoverTransition,verifyConnectionHandoverResult,connectionActivationDigest} from '../src/migration/connection-handover.js';
import {verifyConnectionCancellation} from '../src/migration/connection-cancellation.js';
import {decodeSignedRecord} from '../src/migration/wire.js';
import {validateTransferManifest} from '../src/migration/transfer.js';
import {validateManagedTransferManifest,managedHistoryCheckpoint} from '../src/migration/managed-snapshot.js';
import {validateConnectionHistory,connectionHistoryDigest} from '../src/migration/connection-history.js';
import {validateConversationHistory,conversationHistoryDigest} from '../src/migration/conversation-history.js';
import {validateHistorySchema,assertExportConformance} from './support/account-history-conformance.js';
import {registerConnectionRoutes} from '../src/accounts/connection-routes.js';
import type {AccountConnections} from '../src/accounts/connections.js';
import type {AccountApiRepository} from '../src/accounts/repository.js';
const fixture=async(name:string)=>JSON.parse(await readFile(new URL('../../../spec/vectors/'+name+'.json',import.meta.url),'utf8'));
const bytes=(s:string)=>new Uint8Array(Buffer.from(s,'hex'));
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const vectors=await fixture('transfer-wire');
async function verifyRecord(v:any,signature=bytes(v.signatureHex)){
 const signed={payloadBytes:bytes(v.payloadHex),signature},time=vectors.time;
 switch(v.type){
 case 'hail.portable-migration-consent':return verifyPortableMigrationConsent(signed,v.didKey,time);
 case 'hail.portable-migration-activated':return verifyActivationReceipt(signed,v.didKey,time);
 case 'hail.connection-handover-prepare':return verifyConnectionHandover(signed,v.role,v.didKey,time);
 case 'hail.connection-handover-abort':return verifyConnectionHandoverAbort(signed,v.role,v.didKey,time);
 case 'hail.connection-handover-transition':return verifyConnectionHandoverTransition(signed,v.didKey,time);
 case 'hail.connection-handover-result':return verifyConnectionHandoverResult(signed,v.didKey);
 case 'hail.connection-transfer-cancellation':return verifyConnectionCancellation(signed,v.didKey,v.role);
 default:if(v.type.startsWith('hail.managed-'))return v.algorithm==='ES256'
   ?verifyManagedOwnerHandshake(signed,v.type,v.didKey):verifyManagedProviderHandshake(signed,v.type,v.didKey);
 return verifyHandshake(signed,v.type,v.didKey);
 }
}
for(const v of vectors.records){it('accepts frozen '+v.id+' with the real server verifier and rejects a corrupt signature',async()=>{
 const value=await verifyRecord(v);expect(Buffer.from(encodeDeterministic(value as unknown as HailValue)).toString('hex')).toBe(v.payloadHex);
 expect(hash(bytes(v.payloadHex))).toBe(v.payloadDigestHex);
 expect(decodeSignedRecord(v.wire,65536)).toEqual({payloadBytes:bytes(v.payloadHex),signature:bytes(v.signatureHex)});
 const corrupt=bytes(v.signatureHex);corrupt[0]=corrupt[0]!^1;await expect(verifyRecord(v,corrupt)).rejects.toThrow();
 });}
it('links the managed v8 chain and separates handover roles and activation digest domains',async()=>{
 const record=(id:string)=>vectors.records.find((r:any)=>r.id===id);
 const signed=(id:string)=>decodeSignedRecord(record(id).wire,65536);
 await expect(verifyManagedHandshakeChain({grant:signed('managed-grant'),acknowledgement:signed('managed-acknowledgement'),offer:signed('managed-offer'),selection:signed('managed-selection'),approval:signed('managed-approval')},record('managed-grant').didKey,vectors.time)).resolves.toMatchObject({approval:{snapshot_version:8}});
 await expect(verifyConnectionHandover(signed('handover-source'),'destination',record('handover-source').didKey,vectors.time)).rejects.toThrow();
 const complete=decodeDeterministic(signed('handover-complete').payloadBytes) as Record<string,HailValue>;
 expect(complete.activation_digest).toEqual(connectionActivationDigest(signed('activation')));
 expect(Buffer.from(complete.activation_digest as Uint8Array).toString('hex')).not.toBe(hash(signed('activation').payloadBytes));
});
for(const kind of ['portable','managed'] as const){it('imports the fixed actual '+kind+' export shape, hashes and original signature',async()=>{
 const v=await fixture(kind+'-history'),raw=new Uint8Array(Buffer.from(v.manifestBase64,'base64url'));
 const snapshot={bytes:raw,digest:bytes(v.digestHex),signature:bytes(v.signatureHex),sourceMessagingPublicKey:v.sourceMessagingPublicKey};
 // Validation only: never rewrite the frozen fixture during unit tests.
 expect(process.env.HAIL_WRITE_HISTORY_VECTORS).not.toBe('1');await assertExportConformance(snapshot,kind);
 const m=JSON.parse(new TextDecoder().decode(raw));
 expect(Buffer.from(connectionHistoryDigest(m.connections)).toString('base64url')).toBe(m.connectionCheckpointDigest);
 expect(Buffer.from(conversationHistoryDigest(m.conversations)).toString('base64url')).toBe(m.conversationCheckpointDigest);
 if(kind==='managed')expect(Buffer.from(managedHistoryCheckpoint(m)).toString('base64url')).toBe(m.historyCheckpointDigest);
 expect(hash(Buffer.concat([raw,Buffer.from('\n')]))).toBe(v.jsonWhitespaceMutationDigestHex);
 await expect(assertExportConformance({...snapshot,bytes:Buffer.concat([raw,Buffer.from('\n')])},kind)).rejects.toThrow();
 const extra=structuredClone(m);extra.tables.account_keys[0].encrypted_private_key='\\x00';expect(()=>validateHistorySchema(extra)).toThrow('History schema');
 const omitted=structuredClone(m);delete omitted.tables.sent_delivery_status;expect(()=>validateHistorySchema(omitted)).toThrow('History schema');
 const foreign=structuredClone(m);foreign.tables.provider_accounts[0].id='01954144-8097-7a9d-a7a8-ffffffffffff';
 expect(()=>(kind==='portable'?validateTransferManifest:validateManagedTransferManifest)(new TextEncoder().encode(JSON.stringify(foreign)))).toThrow();
 const altered=structuredClone(m);altered.conversationCheckpointDigest='A'.repeat(43);
 expect(()=>(kind==='portable'?validateTransferManifest:validateManagedTransferManifest)(new TextEncoder().encode(JSON.stringify(altered)))).toThrow();
 });}
for(const id of ['connection-history','conversation-creator','conversation-renewed','conversation-left'])it('preserves nonempty '+id+' records and rejects wrong ownership',async()=>{
 const v=await fixture(id),h=v.history,owner={accountId:h.accountId,did:h.did,sourceGeneration:h.sourceGeneration,sourceServiceBase:h.sourceServiceBase};
 if(id==='connection-history'){
  const raw=new TextEncoder().encode(JSON.stringify(h));expect(validateConnectionHistory(raw,owner)).toEqual(h);
  expect(Buffer.from(connectionHistoryDigest(h)).toString('hex')).toBe(v.digestHex);
  expect(()=>validateConnectionHistory(raw,{...owner,did:'did:plc:'+'z'.repeat(24)})).toThrow();
 }else{
  expect(validateConversationHistory(h,owner,h.capturedAt)).toEqual(h);
  expect(Buffer.from(conversationHistoryDigest(h)).toString('hex')).toBe(v.digestHex);
  expect(()=>validateConversationHistory(h,{...owner,did:'did:plc:'+'z'.repeat(24)},h.capturedAt)).toThrow();
  if(id==='conversation-left'){expect(h.tables.conversation_memberships[0].state).toBe('left');expect(h.tables.account_conversation_preferences[0].allow_introductions).toBe(false);}
 }
});
it('verifies frozen connection proofs with the codec and exercises the real ingress parser',async()=>{
 const v=await fixture('connection-wire');
 for(const o of v.objects){
  const key=await crypto.subtle.importKey('raw',bytes(o.publicKeyHex),'Ed25519',false,['verify']);
  await verifySignedPayload(o.type,bytes(o.coseHex),createWebCryptoVerifier(async kid=>{expect(kid).toBe(o.keyId);return key;}));
 }
 expect(hash(bytes(v.bundleHex))).toBe(v.bundleDigestHex);
 // The double isolates only the ingress contract; real state/authority is covered by integration tests.
 let received:any;let response:any;
 const app=new Hono();registerConnectionRoutes(app,{federation:{async handle(_step:string,input:any){received=input;return response;}},
  async exportInvitation(input:any){received=input;return response;},async receiveConversationRevival(input:any){received=input;return response;}} as unknown as AccountConnections,{} as AccountApiRepository,'https://provider.example.com');
 for(const e of v.exchanges){response=e.response;const result=await app.request('/hail/connections/'+e.operation,{method:e.method,headers:{'Content-Type':e.contentType},body:e.requestUtf8});
  expect(result.status).toBe(e.responseStatus);expect(received).toEqual(e.request);expect(await result.json()).toEqual(e.response);
 }
 for(const e of v.negative){const headers:Record<string,string>={'Content-Type':e.contentType??'application/json'};
  if(e.contentEncoding)headers['Content-Encoding']=e.contentEncoding;if(e.authorization)headers.Authorization=e.authorization;
  const result=await app.request('/hail/connections/'+e.operation,{method:'POST',headers,body:e.body});expect(result.status).toBe(e.status);
 }
});

const negativeHistory=await fixture('history-negative');
for(const c of negativeHistory.cases)it('rejects published history vector '+c.id,async()=>{
 const v=await fixture(c.fixture),m=v.history??JSON.parse(Buffer.from(v.manifestBase64,'base64url').toString('utf8'));
 let parent=m;for(const k of c.path.slice(0,-1))parent=parent[k];const field=c.path.at(-1);
 if(c.action==='delete')delete parent[field];else parent[field]=c.value;
 if(c.stage==='schema'){
  if(v.history){const {assertCheckpointConformance}=await import('./support/account-history-conformance.js');await expect(assertCheckpointConformance(m,c.fixture)).rejects.toThrow('Checkpoint schema');}
  else expect(()=>validateHistorySchema(m)).toThrow('History schema');
 }else expect(()=>(m.custodyProfile==='managed'?validateManagedTransferManifest:validateTransferManifest)(new TextEncoder().encode(JSON.stringify(m)))).toThrow();
});
