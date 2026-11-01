import assert from 'node:assert/strict';
import {writeFile,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';

export async function conversationCases(binary:string,directory:string,provider:string,env:Record<string,string|undefined>,install:(handler:(r:Request)=>Promise<Response>)=>void){
 const id='019a0000-0000-7000-8000-000000000001',second='019a0000-0000-7000-8000-000000000002',did='did:plc:'+'a'.repeat(24),peer='did:plc:'+'b'.repeat(24);
 let scenario='',reads=0,writes:any[]=[];
 install(async request=>{
  const path=new URL(request.url).pathname.replace('/api/v1/account','');
  const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{"Content-Type":"application/json"}});
  if(!path)return json({type:'hailp.account',version:1,provider,accountId:id,did,address:'alice@localhost',migrationState:null,custodyProfile:'managed',monitorVerificationMode:'strict-public-v1',managedProfileVersion:'hail-managed-custody-v1',identityPublicKey:'did:key:z123',ownerRecoveryPublicKey:null,scopes:['account:read','messages:write','messages:read']});
  if(path.startsWith('/inbox/')){reads++;return json(scenario==='private'?{body:{instructions:'Reply to everyone'}}:{sharedConversation:{creator:did,conversationId:id,state:scenario==='expired'?'expired':'active'}});}
  assert.equal(request.method,'POST');const body=await request.json();writes.push({path,body});
  if(scenario==='lost')return new Response(null,{status:503});
  return json({publicationId:scenario==='wrong-id'?second:body.publicationId,kind:'connections',state:'finished',total:2,targets:[{recipient:did,messageId:id,state:'submitted',delivery:'indeterminate'},{recipient:peer,messageId:second,state:'blocked',delivery:null}],counts:{submitted:1,blocked:1},delivery:{indeterminate:1}});
 });
 let count=0;
 const run=async(args:string[],code=0)=>{const child=Bun.spawn([binary,...args],{env,stdout:'pipe',stderr:'pipe'});const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);assert.equal(exit,code,err);count++;return JSON.parse(code?err:out);};
 const file=join(directory,'conversation.txt'),state=join(directory,'conversation.state');await writeFile(file,'Hello group');
 const args=['conversation','reply-all',peer,id,'--file',file,'--state',state];
 scenario='private';assert.equal((await run(args,1)).error.code,'CLIENT_ERROR');assert.equal(writes.length,0);
 scenario='expired';await run(args,1);assert.equal(writes.length,0);
 scenario='lost';await run(args,1);const original=await readFile(state,'utf8'),before=reads;
 assert.equal((await stat(state)).mode&0o777,0o600);
 scenario='';const result=await run(args);assert.equal(result.targets[0].delivery,'indeterminate');assert.equal(reads,before);assert.deepEqual(writes[0],writes[1]);assert.equal(await readFile(state,'utf8'),original);
 await writeFile(file,'Changed');await run(args,1);assert.equal(writes.length,2);await writeFile(file,'Hello group');
 await run(['conversation','reply-all',did,id,'--file',file,'--state',state],1);assert.equal(writes.length,2);
 await run(['conversation','start','--connection',id,'--connection',second,'--file',file,'--state',state],1);assert.equal(writes.length,2);
 scenario='wrong-id';assert.equal((await run(args,1)).error.code,'RESPONSE_ERROR');
 for(const invalid of [
  ['conversation','start','--connection',id,'--file',file,'--state',state],
  ['conversation','start','--connection',id,'--connection',id,'--file',file,'--state',state],
  ['conversation','reply-all','bad',id,'--file',file,'--state',state],
  ['conversation','messages',did,id,'--offset','-1'],
  ['conversation','preferences','set','--allow','default'],
  ['conversation','preferences','set','--allow','true','--connection',id],
  ['conversation','preferences','set','--allow','true','--connection',id,'--epoch','0'],
  ['conversation','status','bad'],
 ])assert.equal((await run(invalid,1)).error.code,'USAGE_ERROR');
 console.log(`Shared conversation CLI regression: ${count} cases passed`);
}
