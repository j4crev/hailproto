// Public deterministic test key; never use for a real account.
import {createHash,createPrivateKey,createPublicKey,sign} from "node:crypto";
import {writeFile} from "node:fs/promises";
import {encodePayload,encodeDeterministic,signPayload,toDiagnosticJson,
  type HailConversation,type HailConversationRevival,type HailValue,type HailEnvelope} from "../src/index.js";
import {envelope as baseEnvelope} from '../test/fixtures.js';

const seed=Buffer.alloc(32,43),privateKey=createPrivateKey({format:"der",type:"pkcs8",key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),seed])});
const did=(n:number)=>{let s="";do{s="abcdefghijklmnopqrstuvwxyz234567"[n%32]+s;n=Math.floor(n/32);}while(n);return "did:plc:"+s.padStart(24,"a");};
const key={key_id:did(0)+"#hail-messaging",seed_hex:seed.toString("hex"),public_key_hex:createPublicKey(privateKey).export({format:"der",type:"spki"}).subarray(-32).toString("hex")};
const signer={keyId:key.key_id,async sign(bytes:Uint8Array){return new Uint8Array(sign(null,bytes,privateKey));}};
const hex=(v:Uint8Array)=>Buffer.from(v).toString("hex"),hash=(v:Uint8Array)=>createHash("sha256").update(v).digest();
const descriptor:HailConversation={type:"hail.conversation",version:1,conversation_id:"01954144-8097-7a9d-a7a8-ef29a823eaf1",
  from:did(0),membership_revision:1,participants:[did(0),did(1),did(2)].sort(),created_at:1793443200,admission_until:1793443200+604800};
const signedDescriptor=await signPayload(descriptor.type,descriptor,signer);
const revival:HailConversationRevival={type:"hail.conversation-revival",version:1,conversation_id:descriptor.conversation_id,
  descriptor_hash:{algorithm:"sha-256",value:hash(signedDescriptor)},from:descriptor.from,to:did(1),
  request_id:"01954144-8097-7a9d-a7a8-ef29a823eaf2",issued_at:1856601600,expires_at:1856601600+86400};
const positive=[];
const introduction:HailEnvelope={...baseEnvelope,version:4,from:descriptor.from,to:did(1),
  authorization:{type:'conversation',creator:descriptor.from,conversation_id:descriptor.conversation_id,membership_revision:1,descriptor_hash:revival.descriptor_hash},
  conversation_message_id:descriptor.conversation_id,conversation_introduction:{descriptor:signedDescriptor,connection_id:revival.request_id,epoch:1},
  reply:{allowed:false}};
delete introduction.category;
const {conversation_introduction:ignored,...withoutIntroduction}=introduction;
const groupReply:HailEnvelope={...withoutIntroduction,conversation_message_id:revival.request_id,in_reply_to:{sender:did(2),message_id:descriptor.conversation_id}};
for(const [id,payload] of [["conversation-three",descriptor],["conversation-maximum",{...descriptor,participants:Array.from({length:101},(_,i)=>did(i)).sort()}],["conversation-revival",revival],
  ['conversation-introduction',introduction],['conversation-reply-all',groupReply]] as const){
  const bytes=encodePayload(payload.type,payload),cose=await signPayload(payload.type,payload,signer);
  positive.push({id,type:payload.type,diagnostic:toDiagnosticJson(payload.type,payload,false),payload_hex:hex(bytes),payload_sha256_hex:hex(hash(bytes)),cose_sign1_hex:hex(cose),representation_sha256_hex:hex(hash(cose))});
}
const {participants:_,...missingRoster}=descriptor;
const negative_payload=[
  ["missing-roster",missingRoster],["roster-too-small",{...descriptor,participants:[did(0),did(1)]}],
  ["roster-too-large",{...descriptor,participants:Array.from({length:102},(_,i)=>did(i)).sort()}],
  ["duplicate-member",{...descriptor,participants:[did(0),did(1),did(1)]}],
  ["unsorted-roster",{...descriptor,participants:[did(2),did(0),did(1)]}],
  ["missing-creator",{...descriptor,participants:[did(1),did(2),did(3)]}],
  ["invalid-member",{...descriptor,participants:[did(0),did(1),"user@example.com"]}],
  ["roster-revision",{...descriptor,membership_revision:2}],
  ["zero-window",{...descriptor,admission_until:descriptor.created_at}],
  ["long-admission",{...descriptor,admission_until:descriptor.admission_until+1}],
  ["negative-time",{...descriptor,created_at:-1}],
  ["extra-authority",{...descriptor,authorization:{type:"connection"}}],
  ["unknown-version",{...descriptor,version:2}],
  ["invalid-id",{...descriptor,conversation_id:"anything"}],
  ["revival-self",{...revival,to:revival.from}],
  ["revival-hash",{...revival,descriptor_hash:{algorithm:"sha-256",value:new Uint8Array(31)}}],
  ["revival-long",{...revival,expires_at:revival.expires_at+1}],
  ["revival-zero",{...revival,expires_at:revival.issued_at}],
  ["revival-request-id",{...revival,request_id:"anything"}],
  ["revival-new-roster",{...revival,participants:descriptor.participants}],
  ['conversation-legacy-envelope',{...introduction,version:3}],
  ['conversation-wrong-introducer',{...introduction,from:did(2)}],
  ['conversation-introduction-parent',{...introduction,in_reply_to:groupReply.in_reply_to}],
  ['conversation-envelope-hash',{...introduction,authorization:{...introduction.authorization,descriptor_hash:{algorithm:'sha-256',value:new Uint8Array(32)}}}],
  ['conversation-independent-reply',{...groupReply,reply:{allowed:true,until:baseEnvelope.created_at+86400}}],
  ['conversation-self-parent',{...groupReply,in_reply_to:{sender:groupReply.from,message_id:groupReply.conversation_message_id}}],
  ['conversation-missing-logical-id',Object.fromEntries(Object.entries(groupReply).filter(([key])=>key!=='conversation_message_id'))],
].map(([id,payload])=>({id,type:(payload as {type:string}).type,hex:hex(encodeDeterministic(payload as HailValue))}));
await writeFile(new URL("../vectors/conversations-v1.json",import.meta.url),JSON.stringify({format:"hail-conversation-vectors-1",test_keys:[key],positive,negative_payload},null,2)+"\n");
