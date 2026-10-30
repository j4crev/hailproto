import assert from "node:assert/strict";
import {writeFile,readFile} from "node:fs/promises";
import {join} from "node:path";
import {createUserVault,cipher,unlockIdentityKey} from "../../../packages/hail-client-support/src/vault-crypto.ts";
const {encodeDeterministic,decodeDeterministic}=await import(Bun.resolveSync("@hailproto/codec",new URL("../../cli",import.meta.url).pathname));
const {verifySignature}=await import(Bun.resolveSync("@atproto/crypto",new URL("../../cli",import.meta.url).pathname));
const {base58btc}=await import(Bun.resolveSync("multiformats/bases/base58",new URL("../../cli",import.meta.url).pathname));
const hash=(v:Uint8Array)=>new Uint8Array(new Bun.CryptoHasher("sha256").update(v).digest());
export async function transferOfferCases(binary:string,root:string,directory:string,provider:string,env:Record<string,string|undefined>,install:(handler:(r:Request)=>Promise<Response>)=>void){
 const id="019a0000-0000-7000-8000-000000000001",did=`did:plc:${"a".repeat(24)}`,token=`hailp_${"a".repeat(43)}`,destination="https://destination.example";
 const commands=[[binary]],peer=await createUserVault(),other=await createUserVault();
 const signer=await unlockIdentityKey(peer.vault,await cipher(peer.recoverySecret));let cases=0;
 async function signed(payload:any){const bytes=encodeDeterministic(payload);const sig=await crypto.subtle.sign("Ed25519",signer,Buffer.concat([Buffer.from(payload.type+".v1\0"),bytes]));return {payload:Buffer.from(bytes).toString("base64url"),signature:Buffer.from(sig).toString("base64url")};}
 for(const [index,command] of commands.entries())for(const managed of [false,true]){
  const created=await createUserVault();created.vault.did=did;const secret=Buffer.from(created.recoverySecret).toString("base64url"),group=managed?"managed-transfer":"transfer";
  const prefix=join(directory,`offer-${index}-${managed}`),vault=prefix+".vault",state=prefix+".state";await writeFile(vault,JSON.stringify(created.vault),{mode:0o600});
  let fail="pending",grant:any,grantWire:any,ack:any,offer:any,calls:any[]=[];
  install(async(request)=>{
   const path=new URL(request.url).pathname.replace("/api/v1/account",""),body=request.method==="POST"?await request.json():null;calls.push({path,body});assert.equal(request.headers.get("authorization"),`Bearer ${token}`);
   const json=(v:unknown)=>new Response(JSON.stringify(v),{headers:{"Content-Type":"application/json"}});
   if(!path)return json({type:"hailp.account",version:1,provider,accountId:id,did,address:"alice@example.com",migrationState:null,custodyProfile:managed?"managed":"owner-controlled",monitorVerificationMode:"strict-public-v1",managedProfileVersion:managed?"hail-managed-custody-v1":null,identityPublicKey:managed?other.vault.identity.publicDidKey:created.vault.identity.publicDidKey,ownerRecoveryPublicKey:created.vault.recovery.publicDidKey,scopes:["account:read","account:write"],credential:{credentialId:id,expiresAt:"2030-01-01T00:00:00.000Z"}});
   if(body){
    if(grantWire)assert.deepEqual(body,grantWire);else grantWire=body;
    const bytes=Buffer.from(body.payload,"base64url");grant=decodeDeterministic(bytes);
    const input=Buffer.concat([Buffer.from(grant.type+".v1\0"),bytes]),signature=Buffer.from(body.signature,"base64url");
    assert(managed?await verifySignature(created.vault.recovery.publicDidKey,input,signature):await crypto.subtle.verify("Ed25519",await crypto.subtle.importKey("raw",base58btc.decode(created.vault.identity.publicDidKey.slice(8)).slice(2),"Ed25519",false,["verify"]),signature,input));
    assert.equal(grant.destination_service_base,destination+"/hail");assert.equal(grant.did,did);
    const common={version:1,did,nonce:grant.nonce,source_service_base:provider+"/hail",destination_service_base:destination+"/hail",issued_at:grant.issued_at,expires_at:grant.expires_at};
    if(managed&&!ack)ack=await signed({...common,type:"hail.managed-transfer-acknowledgement",grant_digest:hash(bytes),source_messaging_key:peer.vault.identity.publicDidKey});
    if(!offer)offer=await signed({...common,type:managed?"hail.managed-transfer-offer":"hail.transfer-offer",transfer_id:id,grant_digest:hash(bytes),destination_rotation_key:peer.vault.recovery.publicDidKey,destination_messaging_key:peer.vault.identity.publicDidKey,...managed?{destination_identity_key:other.vault.identity.publicDidKey,acknowledgement_digest:hash(Buffer.from(ack.payload,"base64url"))}:{invitation_digest:new Uint8Array(32),invitation_challenge:new Uint8Array(32)}});
   }
   return json({type:managed?"hailp.managed-transfer-status":"hailp.transfer-status",version:1,provider,accountId:id,did:fail==="did"?`did:plc:${"b".repeat(24)}`:did,phase:fail==="pending"?(managed?"acknowledgement-retained":"invitation-pending"):"offer-ready",nonce:grant?.nonce,destinationServiceBase:destination+"/hail",transferId:id,originConfirmed:true,...ack?{acknowledgement:ack}:{},...fail!=="pending"?{offer}:{}});
  });
  const args=["account",group,"offer","--destination",destination,"--vault",vault,"--state",state];
  async function run(selected=args,success=true,cmd=command){
   const child=Bun.spawn([...cmd,...selected],{env,stdin:new Blob([secret+"\n"]),stdout:"pipe",stderr:"pipe"});const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);assert.equal(code===0,success,err);assert(!(out+err).includes(secret));cases++;return out?JSON.parse(out):null;
  }
  assert.equal((await run()).pending,true);const saved=JSON.parse(await readFile(state,"utf8"));fail="";assert.equal((await run()).phase,"offer-ready");
  await run(args,true,command);assert.deepEqual(JSON.parse(await readFile(state,"utf8")).grant,saved.grant);
  await run(["account",group,"status"]);fail="did";await run(args,false);await run(["account",group,"status"],false);
  const n=calls.length;await run(args.map(v=>v===destination?destination+":8443":v),false);assert.equal(calls.length,n);
 }
 console.log(`Transfer Offer regression: ${cases} cases passed`);
}
