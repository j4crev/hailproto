import assert from "node:assert/strict";
import {writeFile,readFile,stat} from "node:fs/promises";
import {join} from "node:path";
import {createUserVault} from "../../../packages/hail-client-support/src/vault-crypto.ts";
import {unlockUserIdentity,unlockUserVault} from "../../server/test/client-support/vault.ts";
export async function accessCases(binary:string,root:string,directory:string,provider:string,env:Record<string,string|undefined>,install:(handler:(r:Request)=>Promise<Response>)=>void){
 const id="019a0000-0000-7000-8000-000000000001",did=`did:plc:${"a".repeat(24)}`,expiresAt="2030-01-01T00:00:00.000Z";
 const created=await createUserVault();created.vault.did=did;
 const secret=Buffer.from(created.recoverySecret).toString("base64url");
 let cases=0;
 for(const [index,command] of [[binary]].entries())for(const signer of ["identity","owner-recovery"] as const)for(const operation of ["login","passkey-recover"]){
  const prefix=join(directory,`${index}-${signer}-${operation}`),vault=prefix+".vault",state=prefix+".state",output=prefix+".out";
  await writeFile(vault,JSON.stringify(created.vault),{mode:0o600});
  const scopes=operation==="login"?["account:read","messages:read"]:["credentials:write"];
  let fail="complete",calls:any[]=[],challenge:any,issued:any;
  install(async(request)=>{
   const path=new URL(request.url).pathname,body=await request.json(),token=request.headers.get("authorization")!.slice(7);
   calls.push({path,body,token});assert.equal(request.method,"POST");
   const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{"Content-Type":"application/json"}});
   if(path.endsWith("/prepare")){
    assert.deepEqual(body.scopes,scopes);assert.equal(body.did,did);assert.equal(body.signer,signer);
    const now=Math.floor(Date.now()/1000);
    challenge={...body,type:"hailp.account-access",version:1,purpose:operation==="login"?"new-api-credential":"passkey-enrollment",challengeId:id,provider,accountId:id,nonce:Buffer.alloc(32,7).toString("base64url"),issuedAt:now,expiresAt:now+120};
    if(fail==="challenge")challenge.provider="https://wrong.example";
    return json(challenge);
   }
   assert.equal(path,"/api/v1/account-access/complete");
   const owner=signer==="identity"?await unlockUserIdentity(created.vault,created.recoverySecret):await unlockUserVault(created.vault,created.recoverySecret);
   const expected=signer==="identity"?await (owner as any).signAccountAccess(challenge):await (owner as any).signAccountRecovery(challenge);
   assert.equal(body.signature,Buffer.from(expected).toString("base64url"));
   assert.equal(body.token,token);assert.equal(body.challengeId,id);
   if(fail==="complete")return new Response("",{status:503});
   issued=operation==="login"?{type:"hailp.api-credential",version:1,provider,accountId:id,credentialId:id,token,scopes,expiresAt}:{type:"hailp.passkey-enrollment",version:1,provider,accountId:id,token,url:`${provider}/auth/recover#token=${token}`,expiresAt};
   return json({[operation==="login"?"credential":"enrollment"]:fail==="ack"?{...issued,accountId:"wrong"}:issued});
  });
  const args=["account",operation,"--provider",provider,"--did",did,"--signer",signer,"--vault",vault,"--state",state,operation==="login"?"--credentials":"--output",output,...(operation==="login"?scopes.flatMap(s=>["--scope",s]):[])];
  async function run(success:boolean, input=secret, selected=args){
   const child=Bun.spawn([...command,...selected],{env:{...env,HAILP_CREDENTIAL_FILE:""},stdin:new Blob([input+"\n"]),stdout:"pipe",stderr:"pipe"});
   const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
   assert.equal(code===0,success,err);assert(!(out+err).includes(secret));
   for(const c of calls)assert(!(out+err).includes(c.token));cases++;
  }
  await run(false,Buffer.alloc(32).toString("base64url"));assert.equal(calls.length,0);
  await run(false);const saved=JSON.parse(await readFile(state,"utf8"));assert(saved.signature);
  fail="ack";await run(false);assert.equal(await Bun.file(output).exists(),false);
  fail="";await run(true);await run(true);
  assert.equal(calls.filter(c=>c.path.endsWith("/prepare")).length,1);
  assert.deepEqual(JSON.parse(await readFile(output,"utf8")),issued);assert.equal((await stat(output)).mode&0o777,0o600);
  assert.equal(JSON.parse(await readFile(state,"utf8")).signature,saved.signature);
  const before=calls.length;await writeFile(state,JSON.stringify({...saved,createdAt:0}));await run(false);assert.equal(calls.length,before);
  await writeFile(state,JSON.stringify(saved));await writeFile(output,"{}");await run(false);assert.equal(await readFile(output,"utf8"),"{}");
  const badArgs=args.map(v=>v===state?state+"-bad":v===output?output+"-bad":v);
  fail="challenge";const n=calls.length;await run(false,secret,badArgs);assert.equal(calls.length,n+1);
 }
 console.log(`Account access regression: ${cases} cases passed`);
}
