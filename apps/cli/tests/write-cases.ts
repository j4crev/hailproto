import assert from "node:assert/strict";
import {writeFile,readFile} from "node:fs/promises";
import {join} from "node:path";
export async function writeCases(binary:string,root:string,directory:string,provider:string,env:Record<string,string|undefined>,install:(handler:(r:Request)=>Promise<Response>)=>void){
 const id="019a0000-0000-7000-8000-000000000001",did=`did:plc:${"a".repeat(24)}`,token=`hailp_${"a".repeat(43)}`;
 const commands=[[binary]];
 const vector=(await Bun.file(join(root,"packages/hail-codec-ts/vectors/v0.json")).json()).positive.find((v:any)=>v.id==="sender-profile-basic");
 const profile={type:"hailp.sender-profile",version:1,revision:vector.diagnostic.revision,digest:vector.representation_sha256_base64url,cose:Buffer.from(vector.cose_sign1_hex,"hex").toString("base64url")};
 let cases=0;
 for(const [index,command] of commands.entries()){
  let fail="",calls:any[]=[],text="Hello, this is text.\n";
  install(async(request)=>{
   assert.equal(request.headers.get("authorization"),`Bearer ${token}`);
   const path=new URL(request.url).pathname.replace("/api/v1/account",""),body=request.method==="POST"?await request.json():null;calls.push({path,body});
   const json=(v:unknown)=>new Response(JSON.stringify(v),{headers:{"Content-Type":"application/json"}});
   if(!path)return json({type:"hailp.account",version:1,provider,accountId:id,did,address:"alice@localhost",migrationState:fail==="fenced"?"fenced":null,custodyProfile:"managed",monitorVerificationMode:"strict-public-v1",managedProfileVersion:"hail-managed-custody-v1",identityPublicKey:"did:key:z123",ownerRecoveryPublicKey:null,scopes:["account:read","messages:write"],credential:{credentialId:id,expiresAt:"2030-01-01T00:00:00.000Z"}});
   if(path==="/connections/cli-list")return json({connections:[{id,epoch:3,did}]});
   if(path==="/profile")return json(fail==="digest"?{...profile,digest:"A".repeat(43)}:profile);
   assert.equal(path,"/messages");assert.equal(body.text,text);assert.match(body.messageId,/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
   if(fail==="lost")return new Response("",{status:503});
   return json({messageId:body.messageId,state:"indeterminate"});
  });
  async function run(args:string[],success=true,cmd=command){
   const child=Bun.spawn([...cmd,...args],{env,stdout:"pipe",stderr:"pipe"});const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);assert.equal(code===0,success,err);assert(!(out+err).includes(token));cases++;return out?JSON.parse(out):null;
  }
  const file=join(directory,`message-${index}.txt`);await writeFile(file,text);
  for(const mode of ["send","reply","connection"]){
   const state=join(directory,`${index}-${mode}.state`);
   const args=[...(mode==="send"?["send","--grant",id,"--category","general"]:mode==="reply"?["reply",id]:["connection","send",id]),"--file",file,"--state",state];
   fail="lost";await run(args,false);const saved=await readFile(state,"utf8");fail="";
   const first=await run(args);assert.equal(first.state,"indeterminate");assert.equal((await run(args,true,command)).messageId,first.messageId);
   assert.equal(await readFile(state,"utf8"),saved);
   if(mode==="connection")assert.equal(calls.filter(c=>c.path==="/connections/cli-list").length,1);
   await writeFile(file,"Changed text");let n=calls.filter(c=>c.path==="/messages").length;await run(args,false);assert.equal(calls.filter(c=>c.path==="/messages").length,n);await writeFile(file,text);
   fail="fenced";await run(args,false);fail="";
  }
  const definition=join(directory,`profile-${index}.json`);await writeFile(definition,JSON.stringify({display_name:"Example",offers_uncategorized:false,categories:[]}),{mode:0o600});
  await run(["profile","create","--file",definition]);assert.equal(calls.at(-1).body.expectedRevision,0);
  await run(["profile","update","--file",definition]);assert.equal(calls.at(-1).body.expectedRevision,profile.revision);
  fail="digest";await run(["profile","create","--file",definition],false);fail="";
  await writeFile(definition,JSON.stringify({display_name:"Example",offers_uncategorized:false,categories:[],extra:true}));let n=calls.length;await run(["profile","create","--file",definition],false);assert.equal(calls.length,n);
 }
 console.log(`Messaging/profile regression: ${cases} cases passed`);
}
