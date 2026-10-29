// Deterministic public test key; never use for an account.
import {createHash,createPrivateKey,createPublicKey,sign} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {envelope} from '../test/fixtures.js';
import {encodePayload,encodeDeterministic,signPayload,toDiagnosticJson,type HailEnvelope,type HailValue} from '../src/index.js';
const seed=Buffer.alloc(32,42),privateKey=createPrivateKey({format:'der',type:'pkcs8',key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed])});
const key={key_id:envelope.from+'#hail-messaging',seed_hex:seed.toString('hex'),public_key_hex:createPublicKey(privateKey).export({format:'der',type:'spki'}).subarray(-32).toString('hex')};
const hex=(v:Uint8Array)=>Buffer.from(v).toString('hex'),hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
const parent={sender:envelope.to,message_id:'01954144-8097-7a9d-a7a8-ef29a823eaff'};
const connection:HailEnvelope={...envelope,version:3,authorization:{type:'connection',connection_id:parent.message_id,epoch:1},in_reply_to:parent,reply:{allowed:false}};
delete connection.category;
const reply:HailEnvelope={...connection,authorization:{type:'reply',reply_to:parent.message_id},reply:{allowed:true,until:envelope.created_at+86400}};
const positive=[];
for(const [id,payload] of [['thread-connection',connection],['thread-subscription',reply]] as const){
  const bytes=encodePayload('hail.envelope',payload);
  const cose=await signPayload('hail.envelope',payload,{keyId:key.key_id,async sign(bytes){return new Uint8Array(sign(null,bytes,privateKey));}});
  positive.push({id,type:'hail.envelope',diagnostic:toDiagnosticJson('hail.envelope',payload,false),payload_hex:hex(bytes),payload_sha256_hex:hash(bytes),cose_sign1_hex:hex(cose),representation_sha256_hex:hash(cose)});
}
const {in_reply_to:_,...missing}=connection;
const negative_payload=[
  ['missing-parent',missing],
  ['legacy-connection-parent',{...connection,version:2}],
  ['legacy-reply-parent',{...reply,version:1}],
  ['grant-parent',{...connection,authorization:envelope.authorization}],
  ['wrong-sender',{...connection,in_reply_to:{...parent,sender:envelope.from}}],
  ['wrong-id',{...reply,in_reply_to:{...parent,message_id:envelope.message_id}}],
  ['extra-parent-field',{...reply,in_reply_to:{...parent,thread:'anything'}}],
  ['connection-invitation',{...connection,reply:reply.reply}],
].map(([id,payload])=>({id,type:'hail.envelope',hex:hex(encodeDeterministic(payload as HailValue))}));
await writeFile(new URL('../vectors/threads-v3.json',import.meta.url),JSON.stringify({format:'hail-thread-vectors-1',test_keys:[key],positive,negative_payload},null,2)+'\n');
