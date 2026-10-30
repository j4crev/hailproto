import { createHash } from "node:crypto";

import vectors from "../../../packages/hail-codec-ts/vectors/v0.json";
// Use the existing codec's pinned CBOR encoder to construct malformed payloads;
// signing helpers would correctly refuse to produce these negative fixtures.
const { encode, decode, Tagged, rfc8949EncodeOptions } = await import(Bun.resolveSync("cborg", new URL("../../../packages/hail-codec-ts", import.meta.url).pathname));
const supported = new Set(["hail.grant","hail.address-binding","hail.sender-profile"]);
export type SignedCase = { name:string; path:string; args:string[]; response:Record<string,unknown>; code?:string };
function response(vector:any, bytes:Uint8Array):SignedCase {
  const p = vector.diagnostic;
  const common = {version:1,cose:Buffer.from(bytes).toString("base64url"),digest:createHash("sha256").update(bytes).digest("base64url")};
  if(vector.type==="hail.grant")return {name:vector.id,path:`/grants/${p.grant_id}`,args:["grant","show",p.grant_id],response:{...common,type:"hailp.grant",localRole:"grantor"}};
  if(vector.type==="hail.address-binding")return {name:vector.id,path:"/binding",args:["binding","show"],response:{...common,type:"hailp.address-binding",bindingId:"019a0000-0000-7000-8000-000000000001",status:"active",renewalDue:false,expiresAt:p.expires_at}};
  return {name:vector.id,path:"/profile",args:["profile","show"],response:{...common,type:"hailp.sender-profile",revision:p.revision}};
}
const positive = vectors.positive.filter(v=>supported.has(v.type));
export const signedCases:SignedCase[] = positive.map(v=>response(v,Buffer.from(v.cose_sign1_hex!,"hex")));
function mutate(id:string,name:string,change:(payload:any,outer:any[])=>void,code="CLIENT_ERROR") {
  const v = positive.find(v=>v.id===id)!;
  const outer = decode(Buffer.from(v.cose_sign1_hex!,"hex"),{tags:Tagged.preserve(18)}).value;
  const payload=decode(outer[2]);
  change(payload,outer);
  outer[2]=encode(payload,rfc8949EncodeOptions);
  signedCases.push({...response(v,encode(new Tagged(18,outer),rfc8949EncodeOptions)),name,code});
}
for(const v of positive) {
  const original=response(v,Buffer.from(v.cose_sign1_hex!,"hex"));
  signedCases.push({...structuredClone(original),name:`${v.id}-wrong-digest`,response:{...original.response,digest:"A".repeat(43)},code:v.type==="hail.address-binding"?"CLIENT_ERROR":"RESPONSE_ERROR"});
  mutate(v.id,`${v.id}-unknown-member`,p=>{p.unknown=true;});
  mutate(v.id,`${v.id}-wrong-key-role`,p=>{p.key_id=`${"did" in p?p.did:p.grantor}#wrong`;});
}
for(const bad of vectors.negative_cose) {
  if(bad.operation!=="inspect"||!supported.has(bad.type))continue;
  const v=positive.find(v=>v.type===bad.type)!;
  signedCases.push({...response(v,Buffer.from(bad.hex,"hex")),name:bad.id,code:"CLIENT_ERROR"});
}
// Inspection has never claimed signature authentication; retain that boundary.
mutate("sender-profile-basic","inspection-does-not-verify-signature",(_,outer)=>{outer[3][0]^=1;},"");
for(const [name,value] of [["non-nfc","e\u0301"],["format-character","hello\u200d"],["control-character","hello\n"],["empty",""],["too-long","a".repeat(129)]]) {
  mutate("sender-profile-basic",`display-${name}`,p=>{p.display_name=value;});
}
mutate("sender-profile-basic","duplicate-categories",p=>{p.categories.push(p.categories[0]);});
mutate("sender-profile-basic","unsorted-categories",p=>{p.categories.reverse();});
mutate("sender-profile-basic","bad-revision",p=>{p.revision=0;});
mutate("sender-profile-v2-avatar","png-bad-crc",p=>{
  p.assets.assets[0].data[40]^=1;
  p.assets.assets[0].digest.value=new Uint8Array(createHash("sha256").update(p.assets.assets[0].data).digest());
});
mutate("sender-profile-v2-avatar","png-wrong-digest",p=>{p.assets.assets[0].digest.value=new Uint8Array(32);});
mutate("sender-profile-v2-avatar","png-wrong-dimensions",p=>{p.assets.assets[0].width=2;});
mutate("sender-profile-v2-avatar","wrong-asset-role",p=>{p.assets.assets[0].role="header";});
mutate("grant-revision-1","previous-absent",p=>{delete p.previous;});
mutate("grant-revision-2","previous-is-text",p=>{p.previous=Buffer.from(p.previous).toString("base64url");});
mutate("grant-revision-1","empty-categories",p=>{p.scope[0].values=[];});
mutate("grant-revision-1","unordered-categories",p=>{p.scope[0].values.reverse();});
mutate("grant-revision-1","wrong-grant-id",p=>{p.grant_id="019a0000-0000-7000-8000-000000000001";},"RESPONSE_ERROR");
mutate("address-binding-basic","binding-window-too-long",p=>{p.expires_at=p.issued_at+7776001;});
mutate("address-binding-basic","binding-did-mismatch",(p,outer)=>{
  p.did=`did:plc:${"b".repeat(24)}`;p.key_id=`${p.did}#hail-identity`;
  const header=decode(outer[0],{useMaps:true});header.set(4,new TextEncoder().encode(p.key_id));outer[0]=encode(header,rfc8949EncodeOptions);
});
for(const address of ["alice@example.invalid","alice@com","alice@localhost","alice@127.0.0.1","Alice@example.com","alice@EXAMPLE.com","alice@ab--cd.com","alice@xn--a.com","alice..x@example.com"]) {
  mutate("grant-revision-1",`invalid-address-${address}`,p=>{p.consent_context.grantee_address=address;});
}
for(const address of ["alice@example.com","alice@a.co.uk","alice@a.github.io","alice@xn--bcher-kva.de","alice@www.ck"]) {
  mutate("grant-revision-1",`valid-address-${address}`,p=>{p.consent_context.grantee_address=address;},"");
}
