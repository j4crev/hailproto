import assert from "node:assert/strict";
import {writeFile,readFile,mkdir} from "node:fs/promises";
import {join} from "node:path";
export async function browserCases(binary:string,root:string,directory:string,provider:string,env:Record<string,string|undefined>,install:(handler:(r:Request)=>Promise<Response>)=>void){
 const id="019a0000-0000-7000-8000-000000000001",expiresAt="2030-01-01T00:00:00.000Z";
 const bin=join(directory,"bin");await mkdir(bin);
 const script=join(bin,"browser.ts");
 await writeFile(script,`const state=await Bun.file(process.env.TEST_BROWSER_STATE!).json(); const url=new URL(state.redirectUri);url.searchParams.set("state",process.env.TEST_BAD_CALLBACK?"wrong":state.state);url.searchParams.set("code",state.code);const response=await fetch(url);if(!process.env.TEST_BAD_CALLBACK&&!response.ok)process.exit(1);`);
 await writeFile(join(bin,"xdg-open"),`#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,{mode:0o700});
 let cases=0;
 for(const [index,command] of [[binary]].entries()){
  const path=join(directory,`browser-${index}.state`),output=join(directory,`browser-${index}.credential`);
  let prepared:any,fail="token",calls:any[]=[],credential:any;
  install(async(request)=>{
   assert.equal(request.headers.get("authorization"),null);assert.equal(request.headers.get("cookie"),null);
   const route=new URL(request.url).pathname,body=await request.json();calls.push({route,body});
   const json=(v:unknown)=>new Response(JSON.stringify(v),{headers:{"Content-Type":"application/json"}});
   if(route.endsWith("/prepare")){
    prepared=body;assert.equal(body.clientId,"hailp-cli-v1");assert.deepEqual(body.scopes,["account:read"]);
    return json({requestId:id,expiresAt:new Date(Date.now()+120000).toISOString(),authorizationUrl:`${fail==="origin"?"https://wrong.example":provider}/auth/authorize?request=${id}&state=${body.state}#code=${body.code}`});
   }
   assert.equal(route,"/api/v1/auth/authorization/token");
   assert.equal(body.code,prepared.code);assert.equal(body.redirectUri,prepared.redirectUri);
   assert.equal(new Bun.CryptoHasher("sha256").update(body.verifier).digest("base64url"),prepared.codeChallenge);
   if(fail==="token")return new Response("",{status:503});
   credential={type:"hailp.api-credential",version:1,provider,accountId:id,credentialId:id,token:body.token,scopes:["account:read"],expiresAt};
   return json(fail==="ack"?{...credential,scopes:["credentials:write"]}:credential);
  });
  async function run(success:boolean,state=path,out=output,bad=false,scope="account:read"){
   const child=Bun.spawn([...command,"account","browser-login","--provider",provider,"--state",state,"--credentials",out,"--scope",scope],{env:{...env,HAILP_CREDENTIAL_FILE:"",PATH:`${bin}:${env.PATH}`,TEST_BROWSER_STATE:state,TEST_BAD_CALLBACK:bad?"1":""},stdout:"pipe",stderr:"pipe"});
   const timeout=setTimeout(()=>child.kill(),10000);
   const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);clearTimeout(timeout);
   assert.equal(code===0,success,stderr);
   if(await Bun.file(state).exists()){const saved=JSON.parse(await readFile(state,"utf8"));for(const key of ["token","code","verifier"])assert(!(stdout+stderr).includes(saved[key]));}cases++;
  }
  await run(false);const state=JSON.parse(await readFile(path,"utf8"));assert.equal(state.approved,true);
  fail="ack";await run(false);assert.equal(await Bun.file(output).exists(),false);
  fail="";await run(true);await run(true);assert.deepEqual(JSON.parse(await readFile(output,"utf8")),credential);
  assert.equal(calls.filter(c=>c.route.endsWith("/prepare")).length,1);
  await run(false,path,output,false,"credentials:write");
  await writeFile(output,"{}");await run(false);assert.equal(await readFile(output,"utf8"),"{}");
  await writeFile(path,JSON.stringify({...state,createdAt:0}));const before=calls.length;await run(false);assert.equal(calls.length,before);
  fail="origin";await run(false,path+"-origin",output+"-origin");
  fail="";await run(false,path+"-bad",output+"-bad",true);assert.equal(await Bun.file(output+"-bad").exists(),false);
 }
 console.log(`Browser PKCE regression: ${cases} cases passed`);
}
