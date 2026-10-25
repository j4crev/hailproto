// Public deterministic fixture keys only; never use these keys for an account.
import {createHash,createPrivateKey,createPublicKey,sign} from "node:crypto";
import {writeFile} from "node:fs/promises";
import {encodeDeterministic,encodePayload,signPayload,toDiagnosticJson,expectedKeyId,type HailConnectionInvitation,
  type HailConnectionConfirmation,type HailConnectionGrant,type HailPayloadByType,type HailSignedPayloadType,type HailValue} from "../src/index.js";

const owner="did:plc:"+"a".repeat(24),peer="did:plc:"+"b".repeat(24),issued=1787851200;
const id=(suffix:string)=>"01954144-8097-7a9d-a7a8-ef29a823ea"+suffix;
const hash=(bytes:Uint8Array)=>new Uint8Array(createHash("sha256").update(bytes).digest());
const digest=(bytes:Uint8Array)=>({algorithm:"sha-256" as const,value:hash(bytes)});
const hex=(bytes:Uint8Array)=>Buffer.from(bytes).toString("hex");
const keys=[owner,peer].map((did,index)=>{
  const seed=Uint8Array.from({length:32},(_,i)=>i+index*96);
  const privateKey=createPrivateKey({format:"der",type:"pkcs8",key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),seed])});
  const publicBytes=createPublicKey(privateKey).export({format:"der",type:"spki"}).subarray(-32);
  return {key_id:did+"#hail-identity",seed_hex:hex(seed),public_key_hex:hex(publicBytes),privateKey};
});
const positive:Record<string,unknown>[]=[],negative:Record<string,unknown>[]=[];
async function add<T extends HailSignedPayloadType>(name:string,type:T,payload:HailPayloadByType[T]){
  const bytes=encodePayload(type,payload),key=keys.find(key=>key.key_id===expectedKeyId(type,payload))!;
  const cose=await signPayload(type,payload,{keyId:key.key_id,async sign(bytes){return new Uint8Array(sign(null,bytes,key.privateKey));}});
  positive.push({id:name,type,diagnostic:toDiagnosticJson(type,payload),payload_hex:hex(bytes),payload_sha256_hex:hex(hash(bytes)),
    cose_sign1_hex:hex(cose),representation_sha256_hex:hex(hash(cose))});return cose;
}
function bad(name:string,type:HailSignedPayloadType,payload:unknown){
  negative.push({id:name,type,hex:hex(encodeDeterministic(payload as HailValue))});
}
const invitation:HailConnectionInvitation={type:"hail.connection-invitation",version:1,invitation_id:id("f1"),from:owner,
  token_hash:digest(new Uint8Array(32).fill(17)),issued_at:issued,expires_at:null,key_id:owner+"#hail-identity"};
await add("connection-permanent-invitation",invitation.type,invitation);
const expiringInvitation={...invitation,invitation_id:id("f2"),token_hash:digest(new Uint8Array(32).fill(18)),expires_at:issued+86400};
const expiringBytes=await add("connection-expiring-invitation",invitation.type,expiringInvitation);
const confirmation:HailConnectionConfirmation={type:"hail.connection-confirmation",version:1,confirmation_id:id("f3"),from:peer,to:owner,
  invitation_id:expiringInvitation.invitation_id,invitation_hash:digest(expiringBytes),issued_at:issued+1,expires_at:issued+301,key_id:peer+"#hail-identity"};
const confirmationBytes=await add("connection-explicit-confirmation",confirmation.type,confirmation);
const peerBinding=await signPayload("hail.address-binding",{type:"hail.address-binding",version:1,address:"friend@example.com",did:peer,
  issued_at:issued-100,expires_at:issued+86400,key_id:peer+"#hail-identity"},{keyId:keys[1]!.key_id,
  async sign(bytes){return new Uint8Array(sign(null,bytes,keys[1]!.privateKey));}});
const grant:HailConnectionGrant={type:"hail.connection-grant",version:1,grant_id:id("f4"),connection_id:id("f5"),revision:1,previous:null,
  grantor:owner,grantee:peer,status:"active",issued_at:issued+2,updated_at:issued+2,expires_at:null,
  consent_context:{grantee_address:"friend@example.com",address_binding_hash:digest(peerBinding),
    invitation_hash:digest(expiringBytes),confirmation_hash:digest(confirmationBytes)},key_id:owner+"#hail-identity"};
const grantBytes=await add("connection-standing-grant",grant.type,grant);
const ownerBinding=await signPayload("hail.address-binding",{type:"hail.address-binding",version:1,address:"owner@example.com",did:owner,
  issued_at:issued-100,expires_at:issued+86400,key_id:owner+"#hail-identity"},{keyId:keys[0]!.key_id,
  async sign(bytes){return new Uint8Array(sign(null,bytes,keys[0]!.privateKey));}});
await add("connection-reciprocal-grant",grant.type,{...grant,grant_id:id("f6"),grantor:peer,grantee:owner,key_id:peer+"#hail-identity",
  consent_context:{...grant.consent_context,grantee_address:"owner@example.com",address_binding_hash:digest(ownerBinding)}});
await add("connection-grant-revocation",grant.type,{...grant,revision:2,previous:hash(grantBytes),status:"revoked",updated_at:issued+3});
bad("connection-invitation-secret-forbidden",invitation.type,{...invitation,token:new Uint8Array(32)});
bad("connection-invitation-invalid-expiry",invitation.type,{...invitation,expires_at:issued});
bad("connection-invitation-unknown-version",invitation.type,{...invitation,version:2});
bad("connection-confirmation-must-expire",confirmation.type,{...confirmation,expires_at:null});
bad("connection-confirmation-window-bounded",confirmation.type,{...confirmation,expires_at:issued+302});
bad("connection-confirmation-self",confirmation.type,{...confirmation,to:peer});
bad("connection-grant-not-a-subscription",grant.type,{...grant,scope:[{type:"categories",values:["general"]}]});
bad("connection-grant-identity-role",grant.type,{...grant,key_id:owner+"#hail-messaging"});
bad("connection-grant-self",grant.type,{...grant,grantee:owner});
bad("connection-grant-revision-predecessor",grant.type,{...grant,revision:2});
bad("connection-grant-digest-length",grant.type,{...grant,consent_context:{...grant.consent_context,confirmation_hash:{algorithm:"sha-256",value:new Uint8Array(31)}}});
await writeFile(new URL("../vectors/connections-draft.json",import.meta.url),JSON.stringify({format:"hail-connection-draft-vectors-1",
  test_keys:keys.map(({privateKey,...key})=>key),evidence:{peer_binding_cose_hex:hex(peerBinding),owner_binding_cose_hex:hex(ownerBinding)},positive,negative_payload:negative},null,2)+"\n");
