import assert from "node:assert/strict";
import {writeFile,readFile} from "node:fs/promises";
import {join} from "node:path";
import {createUserVault} from "../../../packages/hail-client-support/src/vault-crypto.ts";
import {unlockUserVault} from "../../server/test/client-support/vault.ts";
const {cidForCbor}=await import(Bun.resolveSync("@atproto/common",new URL("../../cli",import.meta.url).pathname));
export async function signupCases(binary:string,root:string,directory:string,provider:string,env:Record<string,string|undefined>,install:(handler:(r:Request)=>Promise<Response>)=>void){
 const id="019a0000-0000-7000-8000-000000000001",expiresAt="2030-01-01T00:00:00.000Z";
 const peer=await createUserVault(), messaging=await createUserVault();
 let cases=0;
 for(const [index,command] of [[binary]].entries())for(const custody of ["owner-controlled","managed"])for(const monitor of [false,true]){
  const created=await createUserVault(),secret=Buffer.from(created.recoverySecret).toString("base64url"),owner=await unlockUserVault(created.vault,created.recoverySecret);
  const prefix=join(directory,`signup-${index}-${custody}-${monitor}`),vault=prefix+".vault",state=prefix+".state",output=prefix+".credential",enrollment=prefix+".enrollment",attestation=prefix+".attestation";
  await writeFile(vault,JSON.stringify(created.vault),{mode:0o600});
  await writeFile(attestation,JSON.stringify({monitorDidKey:peer.vault.identity.publicDidKey,payload:"reviewed",signature:"fixture"}),{mode:0o600});
  let fail="complete",calls:any[]=[],first:any,did="";
  install(async(request)=>{
   const path=new URL(request.url).pathname,body=await request.json(),token=request.headers.get("authorization")!.slice(7);calls.push({path,body,token});
   const json=(v:unknown)=>new Response(JSON.stringify(v),{headers:{"Content-Type":"application/json"}});
   if(path==="/api/v1/onboarding"){
    assert.equal(body.backupVerified,true);assert.equal(body.custody,custody);assert.equal(body.recoveryKey,created.vault.recovery.publicDidKey);
    return json({address:"alice@example.com",userRecoveryKey:body.recoveryKey,custodyProfile:custody,managedProfileVersion:custody==="managed"?"hail-managed-custody-v1":null,userIdentityKey:custody==="managed"?peer.vault.identity.publicDidKey:body.identityKey,sourceServiceBase:provider+"/hail",accountId:id,providerRotationKey:peer.vault.recovery.publicDidKey,providerMessagingKey:messaging.vault.identity.publicDidKey,...monitor?{monitorOrigin:"https://monitor.example",monitorPublicKey:peer.vault.identity.publicDidKey}:{}});
   }
   assert.equal(path,`/api/v1/onboarding/${id}`);
   const {sig,...unsigned}=body.operation;
   const expected=custody==="managed"?await owner.signManagedGenesis(unsigned):await owner.signPlcOperation(unsigned);
   assert.deepEqual(body.operation,expected.operation);did=expected.did;
   if(first){assert.deepEqual(body.operation,first.operation);assert.equal(body.binding,first.binding);}else first=body;
   if(custody==="managed")assert.equal(body.binding,null);else assert.equal(typeof body.binding,"string");
   if(fail==="complete")return new Response("",{status:503});
   if(monitor&&!body.monitor)return json({did,monitorRequired:true,operationCid:(await cidForCbor(body.operation)).toString()});
   if(monitor)assert.deepEqual(body.monitor,{payload:"reviewed",signature:"fixture"});
   return json({did:fail==="ack"?"did:plc:bbbbbbbbbbbbbbbbbbbbbbbb":did,credential:{type:"hailp.api-credential",version:1,provider,accountId:id,credentialId:id,token,scopes:["account:read"],expiresAt},enrollment:{type:"hailp.passkey-enrollment",version:1,provider,accountId:id,token:body.enrollmentToken,url:`${provider}/auth/recover#token=${body.enrollmentToken}`,expiresAt}});
  });
  const base=["account","create","--provider",provider,"--address","alice@example.com","--custody",custody,"--vault",vault,"--state",state,"--credentials",output,"--backup-verified","--passkey-enrollment",enrollment,...monitor?["--monitor-origin","https://monitor.example","--monitor-key",peer.vault.identity.publicDidKey]:[]];
  async function run(success:boolean,args=base){
   const child=Bun.spawn([...command,...args],{env:{...env,HAILP_CREDENTIAL_FILE:""},stdin:new Blob([secret+"\n"]),stdout:"pipe",stderr:"pipe"});
   const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
   assert.equal(code===0,success,err);assert(!(out+err).includes(secret));for(const c of calls)assert(!(out+err).includes(c.token));cases++;return out?JSON.parse(out):null;
  }
  await run(false);assert.equal(JSON.parse(await readFile(vault,"utf8")).did,did);
  const retained=JSON.parse(await readFile(state,"utf8"));assert.equal(retained.did,did);
  fail="";let args=base;
  if(monitor){const checkpoint=await run(true);assert.equal(checkpoint.monitorRequired,true);assert.equal(await Bun.file(output).exists(),false);args=[...base,"--monitor-attestation",attestation];}
  fail="ack";await run(false,args);assert.equal(await Bun.file(output).exists(),false);
  fail="";await run(true,args);await run(true,args);
  assert.equal(calls.filter(c=>c.path==="/api/v1/onboarding").length,1);
  assert.equal(JSON.parse(await readFile(enrollment,"utf8")).token,retained.enrollmentToken);
  await writeFile(state,JSON.stringify({...retained,operation:{...retained.operation,alsoKnownAs:["changed"]}}));const n=calls.length;await run(false,args);assert.equal(calls.length,n);
  await writeFile(state,JSON.stringify(retained));await writeFile(output,"{}");await run(false,args);assert.equal(await readFile(output,"utf8"),"{}");
 }
 console.log(`Account signup regression: ${cases} cases passed`);
}
