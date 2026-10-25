import {createHash,createPrivateKey,createPublicKey,sign,verify} from "node:crypto";
import {readFileSync} from "node:fs";
import {expect,it} from "vitest";
import {decodePayload,encodePayload,encodeDeterministic,fromDiagnosticJson,inspectSignedPayload,signPayload,verifySignedPayload,expectedKeyId,
  type DiagnosticJson,type HailSignedPayloadType} from "../src/index.js";
import {envelope as legacyEnvelope,grant as subscriptionGrant} from "./fixtures.js";

const manifest=JSON.parse(readFileSync(new URL("../vectors/connections-draft.json",import.meta.url),"utf8")) as {
  test_keys:{key_id:string;seed_hex:string;public_key_hex:string}[];
  positive:{id:string;type:HailSignedPayloadType;diagnostic:DiagnosticJson;payload_hex:string;payload_sha256_hex:string;cose_sign1_hex:string;representation_sha256_hex:string}[];
  negative_payload:{id:string;type:HailSignedPayloadType;hex:string}[];
  evidence:{peer_binding_cose_hex:string;owner_binding_cose_hex:string};
};
const bytes=(hex:string)=>new Uint8Array(Buffer.from(hex,"hex"));
const hash=(bytes:Uint8Array)=>new Uint8Array(createHash("sha256").update(bytes).digest());
const verifier={async verify(data:Uint8Array,signature:Uint8Array,kid:string){
  const key=manifest.test_keys.find(key=>key.key_id===kid);if(!key)return false;
  return verify(null,data,createPublicKey({format:"der",type:"spki",key:Buffer.from("302a300506032b6570032100"+key.public_key_hex,"hex")}),signature);
}};

for(const vector of manifest.positive)it(`round-trips and signs draft connection authority: ${vector.id}`,async()=>{
  const payload=fromDiagnosticJson(vector.type,vector.diagnostic),encoded=encodePayload(vector.type,payload);
  expect(encoded).toEqual(bytes(vector.payload_hex));expect(Buffer.from(hash(encoded)).toString("hex")).toBe(vector.payload_sha256_hex);
  expect(decodePayload(vector.type,encoded)).toEqual(payload);
  const key=manifest.test_keys.find(key=>key.key_id===expectedKeyId(vector.type,payload))!;
  const privateKey=createPrivateKey({format:"der",type:"pkcs8",key:Buffer.from("302e020100300506032b657004220420"+key.seed_hex,"hex")});
  const signed=await signPayload(vector.type,payload,{keyId:key.key_id,async sign(data){return new Uint8Array(sign(null,data,privateKey));}});
  expect(signed).toEqual(bytes(vector.cose_sign1_hex));expect(Buffer.from(hash(signed)).toString("hex")).toBe(vector.representation_sha256_hex);
  expect((await verifySignedPayload(vector.type,signed,verifier)).payload).toEqual(payload);
  expect(()=>inspectSignedPayload("hail.grant",signed)).toThrow();
  if(vector.type!=="hail.envelope")expect(()=>inspectSignedPayload("hail.envelope",signed)).toThrow();
});
for(const vector of manifest.negative_payload)it(`rejects malformed connection authority: ${vector.id}`,()=>{
  expect(()=>decodePayload(vector.type,bytes(vector.hex))).toThrow();
});
it("binds full signed invitation/confirmation/binding bytes and preserves a standing grant independently of invitation expiry",async()=>{
  const permanent=manifest.positive.find(row=>row.id==="connection-permanent-invitation")!;
  const expiring=manifest.positive.find(row=>row.id==="connection-expiring-invitation")!;
  const confirmation=manifest.positive.find(row=>row.id==="connection-explicit-confirmation")!;
  const grant=manifest.positive.find(row=>row.id==="connection-standing-grant")!;
  const revoked=manifest.positive.find(row=>row.id==="connection-grant-revocation")!;
  const reciprocal=manifest.positive.find(row=>row.id==="connection-reciprocal-grant")!;
  const invitation=decodePayload("hail.connection-invitation",bytes(permanent.payload_hex));expect(invitation.expires_at).toBeNull();
  const timed=decodePayload("hail.connection-invitation",bytes(expiring.payload_hex));expect(timed.expires_at).not.toBeNull();
  const accepted=decodePayload("hail.connection-confirmation",bytes(confirmation.payload_hex));
  expect(accepted.invitation_hash.value).toEqual(hash(bytes(expiring.cose_sign1_hex)));
  expect(accepted.invitation_id).toBe(timed.invitation_id);
  const direct=decodePayload("hail.connection-grant",bytes(grant.payload_hex));expect(direct.expires_at).toBeNull();
  expect(direct.consent_context.invitation_hash.value).toEqual(accepted.invitation_hash.value);
  expect(direct.consent_context.confirmation_hash.value).toEqual(hash(bytes(confirmation.cose_sign1_hex)));
  const bindingBytes=bytes(manifest.evidence.peer_binding_cose_hex),binding=await verifySignedPayload("hail.address-binding",bindingBytes,verifier);
  expect(direct.grantee).toBe(binding.payload.did);expect(direct.consent_context.grantee_address).toBe(binding.payload.address);
  expect(direct.consent_context.address_binding_hash.value).toEqual(hash(bindingBytes));
  const reverse=decodePayload("hail.connection-grant",bytes(reciprocal.payload_hex));
  expect(reverse.connection_id).toBe(direct.connection_id);expect(reverse.grantor).toBe(direct.grantee);expect(reverse.grantee).toBe(direct.grantor);
  const ownerBytes=bytes(manifest.evidence.owner_binding_cose_hex),owner=await verifySignedPayload("hail.address-binding",ownerBytes,verifier);
  expect(reverse.grantee).toBe(owner.payload.did);expect(reverse.consent_context.address_binding_hash.value).toEqual(hash(ownerBytes));
  expect(decodePayload("hail.connection-grant",bytes(revoked.payload_hex)).previous).toEqual(hash(bytes(grant.cose_sign1_hex)));
  expect(()=>decodePayload("hail.envelope",encodeDeterministic({...legacyEnvelope,authorization:{type:"connection",connection_id:direct.connection_id}} as never))).toThrow();
  expect(()=>decodePayload("hail.grant",encodeDeterministic({...subscriptionGrant,purpose:"connection"} as never))).toThrow();
});
