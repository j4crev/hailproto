import assert from "node:assert/strict";
import {writeFile,readFile} from "node:fs/promises";
import {join} from "node:path";
import {createUserVault} from "../../../packages/hail-client-support/src/vault-crypto.ts";
import {unlockUserIdentity} from "../../server/test/client-support/vault.ts";
const {fromDiagnosticJson,inspectSignedPayload,toDiagnosticJson}=await import(Bun.resolveSync("@hailproto/codec",new URL("../../cli",import.meta.url).pathname));
const digest=(b:Uint8Array)=>new Bun.CryptoHasher("sha256").update(b).digest("base64url");
export async function grantBindingCases(binary:string,root:string,directory:string,provider:string,env:Record<string,string|undefined>,install:(handler:(r:Request)=>Promise<Response>)=>void){
 const id="019a0000-0000-7000-8000-000000000001",did=`did:plc:${"a".repeat(24)}`,token=`hailp_${"a".repeat(43)}`;
 const commands=[[binary]],vectors=(await Bun.file(join(root,"packages/hail-codec-ts/vectors/v0.json")).json()).positive;
 let cases=0;
 for(const [index,command] of commands.entries())for(const managed of [false,true]){
  const created=await createUserVault();created.vault.did=did;const owner=await unlockUserIdentity(created.vault,created.recoverySecret),secret=Buffer.from(created.recoverySecret).toString("base64url");
  const prefix=join(directory,`signed-write-${index}-${managed}`),vault=prefix+".vault",output=prefix+".grant",update=prefix+".update",revoked=prefix+".revoke",binding=prefix+".binding";
  await writeFile(vault,JSON.stringify(created.vault),{mode:0o600});
  const now=Math.floor(Date.now()/1000);let grant=structuredClone(vectors.find((v:any)=>v.type==="hail.grant").diagnostic),grantBytes:Uint8Array;
  grant.scope=[{type:"categories",values:["receipts"]}];grant.issued_at=now-100;grant.updated_at=now-100;grant.expires_at=now+1000;
  grantBytes=await owner.signGrant(fromDiagnosticJson("hail.grant",grant));const gid=grant.grant_id;
  let currentBinding={...vectors.find((v:any)=>v.type==="hail.address-binding").diagnostic,issued_at:now-120*86400};
  let bindingBytes=await owner.signAddressBinding(currentBinding),fail="",calls:any[]=[],proposal:any;
  const grantRecord=()=>({type:"hailp.grant",version:1,cose:Buffer.from(grantBytes).toString("base64url"),digest:digest(grantBytes),localRole:"grantor"});
  const ack=()=>({grantId:gid,revision:grant.revision,status:grant.status,digest:fail==="ack"?"A".repeat(43):digest(grantBytes),publication:"durable"});
  const bindingRecord=()=>({type:"hailp.address-binding",version:1,bindingId:id,cose:Buffer.from(bindingBytes).toString("base64url"),digest:digest(bindingBytes),status:"active"});
  install(async(request)=>{
   const path=new URL(request.url).pathname.replace("/api/v1/account",""),body=request.method==="POST"?await request.json():null;calls.push({path,body,method:request.method});assert.equal(request.headers.get("authorization"),`Bearer ${token}`);
   const json=(v:unknown)=>new Response(JSON.stringify(v),{headers:{"Content-Type":"application/json"}});
   if(!path)return json({type:"hailp.account",version:1,provider,accountId:id,did,address:currentBinding.address,migrationState:null,custodyProfile:managed?"managed":"owner-controlled",monitorVerificationMode:"strict-public-v1",managedProfileVersion:managed?"hail-managed-custody-v1":null,identityPublicKey:created.vault.identity.publicDidKey,ownerRecoveryPublicKey:created.vault.recovery.publicDidKey,scopes:["account:read","account:write","grants:write"],credential:{credentialId:id,expiresAt:"2030-01-01T00:00:00.000Z"}});
   if(path==="/binding"){
    if(body){
     assert.equal(body.signingKey,created.vault.identity.publicDidKey);
     if(managed){currentBinding=body.payload;bindingBytes=await owner.signAddressBinding(currentBinding);}else{bindingBytes=Buffer.from(body.cose,"base64url");currentBinding=toDiagnosticJson("hail.address-binding",inspectSignedPayload("hail.address-binding",bindingBytes).payload);}
     if(fail==="lost")return new Response("",{status:503});
    }
    return json(fail==="binding-ack"?{...bindingRecord(),digest:"A".repeat(43)}:bindingRecord());
   }
   if(path===`/grants/${gid}`){
    if(request.method==="PUT"){
     assert.equal(request.headers.get("content-type"),'application/cose; cose-type="cose-sign1"');
     const bytes=new Uint8Array(await request.arrayBuffer()),p=inspectSignedPayload("hail.grant",bytes).payload;
     assert.deepEqual(Buffer.from(bytes),Buffer.from(await owner.signGrant(p)));grant=toDiagnosticJson("hail.grant",p);grantBytes=bytes;
     if(fail==="lost")return new Response("",{status:503});return json(ack());
    }return json(grantRecord());
   }
   if(path==="/grants/proposals"||path==="/grants/managed"){
    grant.scope=[body.scope];grant.expires_at=body.expiresAt;grantBytes=await owner.signGrant(fromDiagnosticJson("hail.grant",grant));
    return json(path.endsWith("managed")?ack():{type:"hailp.grant-proposal",version:1,grant});
   }
   if(path===`/grants/${gid}/proposals`){
    proposal={...grant,scope:[body.scope],revision:grant.revision+1,previous:digest(grantBytes),updated_at:now,expires_at:body.expiresAt};return json({type:"hailp.grant-proposal",version:1,grant:proposal});
   }
   if(path===`/grants/${gid}/update`){grant=body.payload;grantBytes=await owner.signGrant(fromDiagnosticJson("hail.grant",grant));return json({...ack(),cose:Buffer.from(grantBytes).toString("base64url")});}
   if(path===`/grants/${gid}/revoke`){grant={...grant,status:"revoked",revision:grant.revision+1,previous:digest(grantBytes),updated_at:now+1};grantBytes=await owner.signGrant(fromDiagnosticJson("hail.grant",grant));return json(ack());}
   throw new Error(path);
  });
  const vaultArgs=managed?[]:["--vault",vault];
  async function run(args:string[],success=true,cmd=command){
   const child=Bun.spawn([...cmd,...args],{env,stdin:new Blob([secret+"\n"]),stdout:"pipe",stderr:"pipe"});const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);assert.equal(code===0,success,err);assert(!(out+err).includes(secret));cases++;return out?JSON.parse(out):null;
  }
  const create=["grant","create","updates@store.example.com","--category","receipts","--expires-at",String(now+1000),"--output",output,...vaultArgs];
  await run(create);const saved=await readFile(output);await run(create,true,command);assert.deepEqual(await readFile(output),saved);
  await run(create.map(s=>s==="receipts"?"changed":s),false);
  const updating=["grant","update",gid,"--category","receipts","--expires-at",String(now+500),"--output",update,...vaultArgs];
  fail="ack";await run(updating,false);fail="";await run(updating);const updateBytes=await readFile(update);await run(updating,true,command);assert.deepEqual(await readFile(update),updateBytes);
  const revoking=["grant","revoke",gid,...vaultArgs,...managed?[]:["--output",revoked]];
  await run(revoking);if(!managed){const b=await readFile(revoked);await run(revoking,true,command);assert.deepEqual(await readFile(revoked),b);await run(["grant","submit",revoked]);}
  const publication=["binding","publish","--output",binding,...vaultArgs];
  fail="lost";await run(publication,false);fail="";await run(publication);const b=await readFile(binding);await run(publication,true,command);assert.deepEqual(await readFile(binding),b);
  const intentPath=binding+".request.json",intent=await readFile(intentPath,"utf8");
  await writeFile(intentPath,JSON.stringify({...JSON.parse(intent),accountId:"changed"}));
  await run(publication,false);await writeFile(intentPath,intent);
  await run([...publication,"--expires-at",String(now+2000)],false);
 }
 console.log(`Grant/binding regression: ${cases} cases passed`);
}
