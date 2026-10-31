import assert from "node:assert/strict";
import {writeFile,readFile} from "node:fs/promises";
import {join} from "node:path";
import {createUserVault} from "../../../packages/hail-client-support/src/vault-crypto.ts";
const {decodeDeterministic,encodeDeterministic}=await import(Bun.resolveSync("@hailproto/codec",new URL("../../cli",import.meta.url).pathname));
const {verifySignature}=await import(Bun.resolveSync("@atproto/crypto",new URL("../../cli",import.meta.url).pathname));
const {encode}=await import(Bun.resolveSync("@ipld/dag-cbor",new URL("../../cli",import.meta.url).pathname));
const {cidForCbor}=await import(Bun.resolveSync("@atproto/common",new URL("../../cli",import.meta.url).pathname));
export async function custodyCases(binary:string,root:string,directory:string,provider:string,env:Record<string,string|undefined>,install:(handler:(r:Request)=>Promise<Response>)=>void){
 const id="019a0000-0000-7000-8000-000000000001",did=`did:plc:${"a".repeat(24)}`,token=`hailp_${"a".repeat(43)}`;
 const commands=[[binary]],peer=await createUserVault();let cases=0;
 for(const [index,command] of commands.entries())for(const toOwner of [false,true]){
  const created=await createUserVault();created.vault.did=did;const secret=Buffer.from(created.recoverySecret).toString("base64url");
  const prefix=join(directory,`custody-${index}-${toOwner}`),vault=prefix+".vault",state=prefix+".state";await writeFile(vault,JSON.stringify(created.vault),{mode:0o600});
  const originalKey=created.vault.identity.publicDidKey,old=toOwner?peer.vault.identity.publicDidKey:originalKey,direction=toOwner?"managed-to-owner":"owner-to-managed";
  let fail="commit",calls:any[]=[],newKey=toOwner?"":peer.vault.identity.publicDidKey,retained:any;
  const current={did,rotationKeys:[created.vault.recovery.publicDidKey,peer.vault.recovery.publicDidKey],verificationMethods:{"hail-identity":old,"hail-messaging":peer.vault.identity.publicDidKey},alsoKnownAs:[],services:{hail:{type:"HailMessaging",endpoint:provider+"/hail"}}};
  const prep=()=>({transitionId:id,accountId:id,did,direction,ownerRecoveryKey:created.vault.recovery.publicDidKey,oldIdentityKey:old,newIdentityKey:newKey,previousOperationCid:"bafyreifake",historyCheckpointDigest:Buffer.alloc(32,1).toString("base64url"),bindingDigest:Buffer.alloc(32,2).toString("base64url"),generationFrom:1,generationTo:2,expiresAt:new Date(Date.now()+120000).toISOString(),currentState:current,unsignedOperation:{type:"plc_operation",prev:"bafyreifake",rotationKeys:current.rotationKeys,verificationMethods:{...current.verificationMethods,"hail-identity":newKey},alsoKnownAs:[],services:current.services},bindingCose:"fixture"});
  install(async(request)=>{
   const path=new URL(request.url).pathname.replace("/api/v1/account",""),body=request.method==="POST"?await request.json():null;calls.push({path,body});assert.equal(request.headers.get("authorization"),`Bearer ${token}`);
   const json=(v:unknown)=>new Response(JSON.stringify(v),{headers:{"Content-Type":"application/json"}});
   if(!path)return json({type:"hailp.account",version:1,provider,accountId:id,did,address:"alice@example.com",migrationState:null,custodyProfile:toOwner?"managed":"owner-controlled",monitorVerificationMode:"strict-public-v1",managedProfileVersion:toOwner?"hail-managed-custody-v1":null,identityPublicKey:old,ownerRecoveryPublicKey:created.vault.recovery.publicDidKey,scopes:["account:read","account:write"],credential:{credentialId:id,expiresAt:"2030-01-01T00:00:00.000Z"}});
   if(path==="/custody/owner-controlled/review"){
    newKey=body.newIdentityKey;assert.notEqual(newKey,originalKey);
    const now=Math.floor(Date.now()/1000),binding={type:"hail.address-binding",version:2,address:"alice@example.com",did,issued_at:now,key_id:did+"#hail-identity"};
    return json({...prep(),binding:Buffer.from(encodeDeterministic(binding)).toString("base64url"),activeGrants:[]});
   }
   if(path==="/custody/managed"||path==="/custody/owner-controlled")return json(prep());
   assert.equal(path,"/custody/managed/commit");
   if(retained)assert.deepEqual(body,retained);else retained=body;
   const operation=JSON.parse(Buffer.from(body.operation,"base64url").toString()),{sig,...unsigned}=operation;
   assert(await verifySignature(created.vault.recovery.publicDidKey,encode(unsigned),Buffer.from(sig,"base64url")));
   const bytes=Buffer.from(body.approval,"base64url"),approval=decodeDeterministic(bytes);
   assert(await verifySignature(created.vault.recovery.publicDidKey,Buffer.concat([Buffer.from("hailp.custody-transition.v1\0"),bytes]),Buffer.from(body.signature,"base64url")));
   assert.equal(approval.operation_cid,(await cidForCbor(operation)).toString());assert.equal(approval.direction,direction);assert.equal(approval.new_identity_key,newKey);assert.equal(approval.generation_to,2);
   if(fail==="commit")return new Response("",{status:503});return json({transitionId:id,did,state:"complete",generation:fail==="ack"?3:2});
  });
  const args=["account","custody",toOwner?"owner-controlled":"managed","--vault",vault,"--state",state,...toOwner?["--backup-verified"]:[]];
  async function run(success=true,cmd=command){
   const child=Bun.spawn([...cmd,...args],{env,stdin:new Blob([secret+"\n"]),stdout:"pipe",stderr:"pipe"});const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);assert.equal(code===0,success,err);assert(!(out+err).includes(secret));cases++;return out?JSON.parse(out):null;
  }
  await run(false);const saved=await readFile(state,"utf8"),vaultBytes=await readFile(vault);
  fail="ack";await run(false);fail="";await run();await run(true,command);
  assert.equal(await readFile(state,"utf8"),saved);assert.deepEqual(await readFile(vault),vaultBytes);
  const bad=JSON.parse(saved);bad.generationTo=0;await writeFile(state,JSON.stringify(bad));const n=calls.length;await run(false);assert.equal(calls.length,n+1);
 }
 console.log(`Custody transition regression: ${cases} cases passed`);
}
