import assert from "node:assert/strict";
import {writeFile,readFile,stat,rm} from "node:fs/promises";
import {join} from "node:path";
export async function credentialCases(binary:string,root:string,directory:string,provider:string,env:Record<string,string|undefined>,install:(handler:(r:Request)=>Promise<Response>)=>void){
  const id="019a0000-0000-7000-8000-000000000001", next="019a0000-0000-7000-8000-000000000002";
  const scopes=["account:read","credentials:write"], expiry="2030-01-01T00:00:00.000Z";
  let cases=0;
  for(const [index,command] of [[binary]].entries()){
    const source=join(directory,`source-${index}.json`), output=join(directory,`created-${index}.json`), rotated=join(directory,`rotated-${index}.json`);
    const original={type:"hailp.api-credential",version:1,provider,accountId:id,credentialId:id,token:`hailp_${"b".repeat(43)}`,scopes,expiresAt:expiry};
    await writeFile(source,JSON.stringify(original),{mode:0o600});
    let issued=new Map<string,any>([[original.token,original]]), fail="", calls:any[]=[], revoked=false;
    install(async(request)=>{
      assert.equal(request.headers.get("cache-control"),"no-store");
      assert.equal(request.headers.get("cookie"),null);
      const token=request.headers.get("authorization")?.slice(7)??"", record=issued.get(token);
      const path=new URL(request.url).pathname.replace("/api/v1/account","");
      const body=request.method==="POST"?await request.json():null;
      calls.push({path,token,body});
      const json=(v:unknown)=>new Response(JSON.stringify(v),{headers:{"Content-Type":"application/json"}});
      if(!record||revoked&&token===original.token)return new Response("",{status:401});
      if(!path)return json({type:"hailp.account",version:1,provider,accountId:id,did:`did:plc:${"a".repeat(24)}`,address:"alice@localhost",migrationState:fail==="fenced"?"fenced":null,custodyProfile:"managed",monitorVerificationMode:"strict-public-v1",managedProfileVersion:"hail-managed-custody-v1",identityPublicKey:"did:key:z123",ownerRecoveryPublicKey:null,scopes:record.scopes,credential:{credentialId:record.credentialId,expiresAt:expiry}});
      assert.equal(path,"/credentials");assert.equal(request.method,"POST");
      if(body.revoke){assert.equal(body.revoke,id);if(fail==="revoke")return new Response("",{status:503});revoked=true;return json({revoked:true});}
      assert.match(body.token,/^hailp_[A-Za-z0-9_-]{43}$/);
      const replacement={...original,token:body.token,credentialId:next,scopes:body.scopes??scopes};
      issued.set(body.token,replacement);
      if(fail==="issue")return new Response("",{status:503});
      return json(fail==="ack"?{...replacement,token:original.token}:replacement);
    });
    async function run(args:string[],success=true){
      const proc=Bun.spawn([...command,...args],{env:{...env,HAILP_CREDENTIAL_FILE:source},stdout:"pipe",stderr:"pipe"});
      const [code,out,err]=await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()]);
      assert.equal(code===0,success,err);for(const token of issued.keys())assert(!(out+err).includes(token));cases++;
      return out?JSON.parse(out):null;
    }
    fail="issue";await run(["credential","create","--output",output,"--scope","account:read"],false);
    const pending=JSON.parse(await readFile(output,"utf8"));assert.deepEqual(pending.scopes,["account:read"]);
    fail="";await run(["credential","create","--output",output,"--scope","account:read"]);
    assert.equal(JSON.parse(await readFile(output,"utf8")).token,pending.token);
    assert.equal((await stat(output)).mode&0o777,0o600);
    let before=calls.length;await run(["credential","create","--output",output,"--scope","credentials:write"],false);
    assert.equal(calls.length,before+1);
    await run(["credential","create","--output",output,"--scope","account:read","--scope","account:read"],false);
    await run(["credential","create","--output",output,"--scope","messages:write"],false);
    fail="fenced";await run(["credential","create","--output",output],false);fail="";
    await run(["credential","rotate","--output",source],false);
    fail="ack";const bad=join(directory,`bad-ack-${index}.json`);await run(["credential","create","--output",bad],false);
    assert.equal(JSON.parse(await readFile(bad,"utf8")).credentialId,undefined);fail="";
    // A lost issue acknowledgement retains exact token; a failed revocation retains replacement and sidecar.
    fail="issue";await run(["credential","rotate","--output",rotated],false);assert.equal(revoked,false);
    const state=await readFile(rotated+".rotation.json","utf8"), retained=JSON.parse(await readFile(rotated,"utf8"));
    fail="revoke";await run(["credential","rotate","--output",rotated],false);assert.equal(revoked,false);
    fail="";const result=await run(["credential","rotate","--output",rotated]);assert.equal(result.revoked,true);
    assert.equal(await readFile(rotated+".rotation.json","utf8"),state);
    assert.equal(JSON.parse(await readFile(rotated,"utf8")).token,retained.token);
    await run(["credential","rotate","--output",rotated]); // Works even after original revocation.
    const revokeIndex=calls.findIndex(c=>c.body?.revoke);assert(revokeIndex>0);
    assert.equal(calls[revokeIndex-1].token,retained.token);assert.equal(calls[revokeIndex-1].path,"");
    assert(calls.filter(c=>c.body?.revoke).every(c=>c.token===retained.token));
    revoked=false;await run(["credential","revoke",id]);
    await rm(rotated+".rotation.json");revoked=false;await run(["credential","rotate","--output",rotated],false);
  }
  console.log(`Credential workflow regression: ${cases} cases passed`);
}
