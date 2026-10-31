import {createHash,createPrivateKey,createPublicKey,sign,verify} from "node:crypto";
import {readFileSync} from "node:fs";
import {expect,it} from "vitest";
import {decodePayload,encodePayload,fromDiagnosticJson,signPayload,verifySignedPayload,inspectSignedPayload,validateConversationRevivalBinding,
  type DiagnosticJson,type HailConversation,type HailConversationRevival,type HailSignedPayloadType} from "../src/index.js";

const vectors=JSON.parse(readFileSync(new URL("../vectors/conversations-v1.json",import.meta.url),"utf8")) as {
  test_keys:{key_id:string;seed_hex:string;public_key_hex:string}[];
  positive:{id:string;type:HailSignedPayloadType;diagnostic:DiagnosticJson;payload_hex:string;payload_sha256_hex:string;cose_sign1_hex:string;representation_sha256_hex:string}[];
  negative_payload:{id:string;type:HailSignedPayloadType;hex:string}[];
};
const bytes=(hex:string)=>new Uint8Array(Buffer.from(hex,"hex"));
const key=vectors.test_keys[0]!,privateKey=createPrivateKey({format:"der",type:"pkcs8",key:Buffer.from("302e020100300506032b657004220420"+key.seed_hex,"hex")});
const publicKey=createPublicKey({format:"der",type:"spki",key:Buffer.from("302a300506032b6570032100"+key.public_key_hex,"hex")});
const signer={keyId:key.key_id,async sign(data:Uint8Array){return new Uint8Array(sign(null,data,privateKey));}};
const verifier={async verify(data:Uint8Array,signature:Uint8Array,kid:string){return kid===key.key_id&&verify(null,data,publicKey,signature);}};
const hash=(data:Uint8Array)=>createHash("sha256").update(data).digest("hex");

for(const vector of vectors.positive)it(`round-trips and verifies shared conversation bytes: ${vector.id}`,async()=>{
  const payload=fromDiagnosticJson(vector.type,vector.diagnostic),encoded=encodePayload(vector.type,payload);
  expect(encoded).toEqual(bytes(vector.payload_hex));expect(hash(encoded)).toBe(vector.payload_sha256_hex);
  expect(decodePayload(vector.type,encoded)).toEqual(payload);
  const signed=await signPayload(vector.type,payload,signer);
  expect(signed).toEqual(bytes(vector.cose_sign1_hex));expect(hash(signed)).toBe(vector.representation_sha256_hex);
  expect((await verifySignedPayload(vector.type,signed,verifier)).payload).toEqual(payload);
  if(vector.type!=='hail.envelope')expect(()=>inspectSignedPayload("hail.envelope",signed)).toThrow();
  expect(()=>inspectSignedPayload(vector.type==="hail.conversation"?"hail.conversation-revival":"hail.conversation",signed)).toThrow();
  const corrupt=Uint8Array.from(signed);corrupt[corrupt.length-1]!^=1;
  await expect(verifySignedPayload(vector.type,corrupt,verifier)).rejects.toThrow();
  await expect(signPayload(vector.type,payload,{...signer,keyId:key.key_id.replace("#hail-messaging","#hail-identity")})).rejects.toThrow();
});
for(const vector of vectors.negative_payload)it(`rejects invalid conversation: ${vector.id}`,()=>{
  expect(()=>decodePayload(vector.type,bytes(vector.hex))).toThrow();
});
it("binds revival to the creator, exact signed descriptor, conversation and participant",async()=>{
  const descriptor=await verifySignedPayload("hail.conversation",bytes(vectors.positive[0]!.cose_sign1_hex),verifier);
  const revival=await verifySignedPayload("hail.conversation-revival",bytes(vectors.positive[2]!.cose_sign1_hex),verifier);
  expect(()=>validateConversationRevivalBinding(descriptor,revival)).not.toThrow();
  const changes:Partial<HailConversationRevival>[]=[
    {descriptor_hash:{algorithm:"sha-256",value:bytes(hash(descriptor.payloadBytes))}},
    {conversation_id:revival.payload.request_id},{to:"did:plc:"+"z".repeat(24)},
    {issued_at:descriptor.payload.created_at-1,expires_at:descriptor.payload.created_at+3600},
  ];
  for(const change of changes){
    const signed=await signPayload("hail.conversation-revival",{...revival.payload,...change},signer);
    const verified=await verifySignedPayload("hail.conversation-revival",signed,verifier);
    expect(()=>validateConversationRevivalBinding(descriptor,verified)).toThrow();
  }
  // A valid signature by another roster member still cannot revive the creator's conversation.
  const impostor={...revival.payload,from:descriptor.payload.participants[2]!};
  const kid=impostor.from+"#hail-messaging";
  const signed=await signPayload("hail.conversation-revival",impostor,{...signer,keyId:kid});
  const verified=await verifySignedPayload("hail.conversation-revival",signed,{async verify(data,signature,keyId){return keyId===kid&&verify(null,data,publicKey,signature);}});
  expect(()=>validateConversationRevivalBinding(descriptor,verified)).toThrow();
  const changed:HailConversation={...descriptor.payload,admission_until:descriptor.payload.admission_until-1};
  const changedVerified=await verifySignedPayload("hail.conversation",await signPayload("hail.conversation",changed,signer),verifier);
  expect(()=>validateConversationRevivalBinding(changedVerified,revival)).toThrow();
  expect(()=>encodePayload("hail.conversation",{...descriptor.payload,created_at:0.5})).toThrow();
});
