import assert from "node:assert/strict";
import {writeFile,readFile} from "node:fs/promises";
import {join} from "node:path";
import {createUserVault} from "../../../packages/hail-client-support/src/vault-crypto.ts";
import {unlockUserIdentity} from "../../server/test/client-support/vault.ts";
const {fromDiagnosticJson}=await import(Bun.resolveSync("@hailproto/codec",new URL("../../cli",import.meta.url).pathname));
export async function connectionCases(binary:string,root:string,directory:string,provider:string,env:Record<string,string|undefined>,install:(handler:(r:Request)=>Promise<Response>)=>void){
 const id="019a0000-0000-7000-8000-000000000001",did=`did:plc:${"a".repeat(24)}`,peer=`did:plc:${"b".repeat(24)}`,token=`hailp_${"a".repeat(43)}`,admission=Buffer.alloc(32,21).toString("base64url");
 const commands=[[binary]],fixtures=(await Bun.file(join(root,"packages/hail-codec-ts/vectors/connections-draft.json")).json()).positive;
 let cases=0;
 for(const [index,command] of commands.entries())for(const create of [true,false]){
  const created=await createUserVault();created.vault.did=did;const owner=await unlockUserIdentity(created.vault,created.recoverySecret),secret=Buffer.from(created.recoverySecret).toString("base64url");
  const prefix=join(directory,`connection-${index}-${create}`),vault=prefix+".vault",state=prefix+".state",output=prefix+".output",file=prefix+".invitation";
  await writeFile(vault,JSON.stringify(created.vault),{mode:0o600});await writeFile(file,JSON.stringify({type:"hailp.connection-invitation",version:1,id,did:peer,token:admission}),{mode:0o600});
  const now=Math.floor(Date.now()/1000),expires=now+120;let fail="commit",proposal:any,intent:any,calls:any[]=[],committed=false;
  const summary=()=>({requestId:intent.requestId,action:intent.action,review:create?{label:"Test",expiresAt:expires,personal:false}:{id,did:peer},result:committed?(create?{invitationId:id}:{attemptId:id,state:"connecting",connectionId:null}):null,...create&&committed?{invitation:{type:"hailp.connection-invitation",version:1,id,did,token:fail==="token"?Buffer.alloc(32,22).toString("base64url"):admission}}:{},ownerSigning:proposal});
  install(async(request)=>{
   const path=new URL(request.url).pathname.replace("/api/v1/account",""),body=request.method==="POST"?await request.json():null;calls.push({path,body});assert.equal(request.headers.get("authorization"),`Bearer ${token}`);
   const json=(v:unknown)=>new Response(JSON.stringify(v),{headers:{"Content-Type":"application/json"}});
   if(!path)return json({type:"hailp.account",version:1,provider,accountId:id,did,address:"alice@localhost",migrationState:null,custodyProfile:"owner-controlled",monitorVerificationMode:"strict-public-v1",managedProfileVersion:null,identityPublicKey:created.vault.identity.publicDidKey,ownerRecoveryPublicKey:created.vault.recovery.publicDidKey,scopes:["account:read","account:write"],credential:{credentialId:id,expiresAt:"2030-01-01T00:00:00.000Z"}});
   if(path==="/connections/cli-prepare"){
    if(intent)assert.deepEqual(body,intent);else intent=body;
    if(!proposal){
     const payload=structuredClone(fixtures.find((v:any)=>v.type===(create?"hail.connection-invitation":"hail.connection-confirmation")).diagnostic);
     payload.from=did;payload.key_id=did+"#hail-identity";payload.issued_at=now;payload.expires_at=expires;payload.invitation_id=id;
     if(create)payload.token_hash.value=new Bun.CryptoHasher("sha256").update(Buffer.from(admission,"base64url")).digest("base64url");else payload.to=peer;
     proposal={type:"hailp.connection-signing",version:1,provider,requestId:intent.requestId,expiresAt:new Date((now+120)*1000).toISOString(),payload};
    }
    return json(summary());
   }
   if(path==="/connections/cli-status")return json(summary());
   assert.equal(path,"/connections/cli-commit");assert.equal(body.requestId,intent.requestId);
   const signed=await owner.signConnectionConsent(fromDiagnosticJson(proposal.payload.type,proposal.payload));assert.equal(body.cose,Buffer.from(signed).toString("base64url"));
   if(fail==="commit")return new Response("",{status:503});committed=true;return json(summary());
  });
  const args=["connection",create?"invite":"accept",...create?["--label","Test","--expires-at",String(expires),"--output",output]:["--file",file,"--expected-did",peer],"--vault",vault,"--state",state];
  async function run(selected=args,success=true,cmd=command){
   const child=Bun.spawn([...cmd,...selected],{env,stdin:new Blob([secret+"\n"]),stdout:"pipe",stderr:"pipe"});const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);assert.equal(code===0,success,err);assert(!(out+err).includes(admission));assert(!(out+err).includes(secret));cases++;return out?JSON.parse(out):null;
  }
  await run(args,false);const retained=await readFile(state+".cose");fail="";
  const result=await run();if(!create)assert.equal(result.state,"connecting");
  await run(args,true,command);assert.deepEqual(await readFile(state+".cose"),retained);
  await run(["connection","status","--state",state]);
  if(create){assert.equal(JSON.parse(await readFile(output,"utf8")).token,admission);fail="token";await run(args,false);assert.equal(JSON.parse(await readFile(output,"utf8")).token,admission);}
  const before=calls.length;await run(args.map(v=>v==="Test"?"Changed":v===peer?did:v),false);assert.equal(calls.length,before+(create?1:0));
 }
 console.log(`Connection consent regression: ${cases} cases passed`);
}
