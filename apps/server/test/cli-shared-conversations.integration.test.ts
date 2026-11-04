import {expect,it} from 'vitest';
import {Hono} from 'hono';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderDatabase} from '../src/db/database.js';
import {sharedConversationFixture} from './support/shared-conversation-fixture.js';
import {createLocalTlsFixture} from './client-support/tls.js';
import {registerAccountApiRoutes} from '../src/accounts/routes.js';
import {registerConnectionRoutes} from '../src/accounts/connection-routes.js';
import {ALL_ACCOUNT_SCOPES} from '../src/accounts/repository.js';
import {OnboardingRepository} from '../src/onboarding/repository.js';
import {GrantRepository} from '../src/grants/repository.js';
import type {GrantService} from '../src/grants/service.js';
import {BodyRepository} from '../src/bodies/repository.js';
import {EnvelopeRepository} from '../src/envelopes/repository.js';
import {EnvelopeService} from '../src/envelopes/service.js';
import {EnvelopeReceiver} from '../src/envelopes/receiver.js';
import {AccountMessaging} from '../src/accounts/messaging.js';
import {AccountPublications} from '../src/accounts/publications.js';
import {DeliveryRepository} from '../src/delivery/repository.js';
import {uuidV7} from '../src/identity/uuid-v7.js';

it.skipIf(!process.env.DATABASE_URL)('native CLI participates in browser and CLI shared conversations with scoped controls and immutable retries',async()=>{
  const db=new ProviderDatabase(process.env.DATABASE_URL!),directory=await mkdtemp(join(tmpdir(),'hail-cli-shared-'));
  let server:ReturnType<typeof Bun.serve>|undefined;
  try{
    await db.migrate();
    const {a,b,c,origin,encryptor,resolver,authority,connections,accounts}=await sharedConversationFixture(db.sql);
    const onboarding=new OnboardingRepository(db.sql),grants=new GrantRepository(db.sql),envelopes=new EnvelopeRepository(db.sql);
    const receiver=new EnvelopeReceiver(onboarding,envelopes,resolver,origin+'/hail',undefined,authority);
    const service=new EnvelopeService(onboarding,grants,envelopes,encryptor,resolver,origin+'/hail',undefined,authority);
    const messaging=new AccountMessaging(db.sql,new BodyRepository(db.sql),envelopes,service,async(sender,id)=>{
      const outcome=await receiver.receive((await envelopes.sent(sender,id))!);
      if(!['accepted','duplicate'].includes(outcome))throw Error(outcome);
      return {messageId:id,state:'accepted' as const,revision:1,envelopeDigest:''};
    });
    const publications=new AccountPublications(db.sql,messaging,authority),delivery=new DeliveryRepository(db.sql,authority);
    const drain=async()=>{
      for(let n=0;n<20&&await publications.workOne();n++);
      for(let n=0;n<20;n++){
        const claim=await delivery.claimDue();if(!claim)return;
        const bytes=(await db.sql<{body_bytes:Uint8Array}[]>`SELECT body_bytes FROM detached_bodies b JOIN provider_accounts a ON a.id=b.sender_account_id
          WHERE a.did=${claim.senderDid} AND b.digest=${claim.envelope.body.digest.value}`)[0]!.body_bytes;
        expect(await delivery.deliver(claim,new Uint8Array(bytes))).toBe('delivered');
      }
      throw Error('Queue did not drain');
    };
    await createLocalTlsFixture(directory);
    const app=new Hono();let loseResponse=false;
    server=Bun.serve({hostname:'localhost',port:0,tls:{cert:Bun.file(join(directory,'cert.pem')),key:Bun.file(join(directory,'key.pem'))},async fetch(request){
      const result=await app.fetch(request);
      if(loseResponse&&request.method==='POST'&&result.ok){loseResponse=false;return new Response(null,{status:503});}
      return result;
    }});
    const provider=`https://localhost:${server.port}`;
    registerConnectionRoutes(app,connections,accounts,origin);
    registerAccountApiRoutes(app,accounts,grants,{} as GrantService,provider,messaging,undefined,undefined,undefined,undefined,undefined,undefined,origin,publications);
    const credentials=await Promise.all([a,b,c].map(user=>accounts.issue(user.address,false,undefined,[...ALL_ACCOUNT_SCOPES])));
    for(const [n,user] of [a,b,c].entries())await writeFile(join(directory,user.id),JSON.stringify({type:'racr.api-credential',version:1,provider,...credentials[n]}),{mode:0o600});
    const file=join(directory,'message.txt');await writeFile(file,'Shared from the native CLI');
    const cli=async(user:typeof a,args:string[],success=true)=>{
      const child=Bun.spawn([new URL('../../cli/target/debug/racr',import.meta.url).pathname,'--json',...args,'--credentials',join(directory,user.id)],{
        env:{...process.env,SSL_CERT_FILE:join(directory,'ca.pem'),NO_PROXY:'localhost',no_proxy:'localhost'},stdout:'pipe',stderr:'pipe'});
      const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
      expect(exit,err).toBe(success?0:1);for(const credential of credentials)expect(out+err).not.toContain(credential.token);
      return JSON.parse(success?out:err);
    };
    const targets=(await authority.targets(a.session)).map(t=>t.connectionId);
    // Browser-created source, replied to by the native CLI between non-connections.
    const browserId=uuidV7();
    const browser=await app.request(provider+'/api/v1/account/connection-messages',{method:'POST',headers:{Origin:origin,Cookie:'hail_session='+a.token,'Content-Type':'application/json'},body:JSON.stringify({publicationId:browserId,connections:targets,text:'Browser original',delivery:'shared'})});
    expect(browser.status).toBe(202);await drain();
    const root=(await messaging.inboxFeed(b.session,null,'connections')).messages[0]!;
    const replyArgs=['conversation','reply-all',a.did,root.messageId,'--file',file,'--state',join(directory,'reply.state')];
    loseResponse=true;await cli(b,replyArgs,false);
    const frozen=await readFile(join(directory,'reply.state'),'utf8');
    const reply=await cli(b,replyArgs);expect(await readFile(join(directory,'reply.state'),'utf8')).toBe(frozen);
    expect((await cli(b,replyArgs)).publicationId).toBe(reply.publicationId);await drain();
    const received=(await messaging.inboxFeed(c.session,null,'connections')).messages.find(m=>m.sender===b.did)!;
    expect(received.sharedConversation?.conversationId).toBe(browserId);
    expect((await authority.targets(b.session)).map(t=>t.recipientDid)).toEqual([a.did]);
    expect((await cli(c,['conversation','messages',b.did,received.messageId,'--offset','0'])).messages).toHaveLength(2);
    expect((await cli(c,['conversation','inbox'])).messages.length).toBeGreaterThan(0);
    const status=await cli(b,['conversation','status',reply.publicationId]);expect(status.total).toBe(2);
    const own=status.targets[0].messageId;
    expect((await cli(b,['sent','show',own])).sharedConversation.conversationId).toBe(browserId);
    expect((await cli(b,['sent','list'])).messages.length).toBeGreaterThan(0);
    await cli(b,['conversation','reply-all',b.did,own,'--file',file,'--state',join(directory,'own.state')]);await drain();
    await writeFile(file,'Changed');await cli(b,replyArgs,false);await writeFile(file,'Shared from the native CLI');
    await cli(c,replyArgs,false); // State cannot move across accounts.
    // CLI-created group is visible to browser readers; cancelling preserves per-recipient results.
    const startArgs=['conversation','start',...targets.flatMap(id=>['--connection',id]),'--file',file,'--state',join(directory,'start.state')];
    const start=await cli(a,startArgs);expect((await cli(a,startArgs)).publicationId).toBe(start.publicationId);await drain();
    expect((await messaging.inboxFeed(c.session,null,'connections')).messages.some(m=>m.sharedConversation?.conversationId===start.publicationId)).toBe(true);
    const queued=await cli(a,[...startArgs.slice(0,-1),join(directory,'cancel.state')]);
    expect((await cli(a,['conversation','cancel',queued.publicationId])).state).toBe('cancelled');
    const identity=[a.did,browserId];
    await db.sql`UPDATE conversation_memberships SET last_activity_at=now()-interval '2 hours' WHERE account_id=${c.id} AND conversation_id=${browserId}`;
    const before=(await cli(c,['conversation','inspect',...identity])).expiresAt;
    await cli(c,['conversation','messages',b.did,received.messageId]);
    expect((await cli(c,['conversation','inspect',...identity])).expiresAt).toBe(before);
    expect((await cli(c,['conversation','open',...identity])).state).toBe('active');
    expect((await cli(c,['conversation','leave',...identity])).state).toBe('left');
    await cli(c,['conversation','reply-all',b.did,received.messageId,'--file',file,'--state',join(directory,'left.state')],false);
    expect((await cli(c,['conversation','rejoin',...identity])).state).toBe('active');
    await db.sql`UPDATE conversation_memberships SET expires_at=now()-interval '1 second' WHERE account_id=${c.id} AND conversation_id=${browserId}`;
    expect((await cli(c,['conversation','open',...identity])).state).toBe('expired');
    await cli(c,['conversation','rejoin',...identity],false);
    await cli(b,['conversation','revive',browserId,'--state',join(directory,'noncreator.state')],false);
    const revivalArgs=['conversation','revive',browserId,'--state',join(directory,'revival.state')];
    const revival=await cli(a,revivalArgs);for(let n=0;n<10&&await connections.workConversationRevival();n++);
    expect((await cli(a,revivalArgs)).operationId).toBe(revival.operationId);
    expect((await cli(c,['conversation','inspect',...identity])).state).toBe('active');
    await cli(c,['conversation','preferences','set','--allow','false']);
    expect((await cli(c,['conversation','preferences','show'])).allowIntroductions).toBe(false);
    const peer=(await authority.targets(c.session))[0]!;
    await cli(c,['conversation','preferences','set','--allow','true','--connection',peer.connectionId,'--epoch',String(peer.epoch)]);
    expect((await cli(c,['conversation','preferences','show'])).connections[0].override).toBe(true);
    await cli(c,['conversation','preferences','set','--allow','default','--connection',peer.connectionId,'--epoch',String(peer.epoch)]);
    await cli(c,['conversation','preferences','set','--allow','true','--connection',peer.connectionId,'--epoch',String(peer.epoch+1)],false);
    // Scope and transactional credential checks, including a credential revoked after authentication.
    const readonly=await accounts.issue(c.address,false,undefined,['messages:read']);
    const limited=(await accounts.authenticate('Bearer '+readonly.token))!;
    await expect(connections.conversationMembership(limited,{creator:a.did,conversationId:browserId,action:'leave'})).rejects.toMatchObject({code:'MISSING_SCOPE'});
    await expect(connections.conversationPreferences(limited)).rejects.toMatchObject({code:'MISSING_SCOPE'});
    await expect(connections.conversationMembership({...limited,scopes:['messages:read','messages:write']},{creator:a.did,conversationId:browserId,action:'leave'})).rejects.toMatchObject({status:403});
    // The new conversation authority must not authorize managed identity consent.
    await expect(connections.prepare((await accounts.authenticate('Bearer '+credentials[0]!.token))!,{requestId:crypto.randomUUID(),action:'create',label:'Forbidden identity consent',personal:false,expiresAt:Math.floor(Date.now()/1000)+3600})).rejects.toMatchObject({status:403});
    const path='/api/v1/account/connections/cli-conversation-membership';
    const request={method:'POST',headers:{Authorization:'Bearer '+readonly.token,'Content-Type':'application/json'},body:JSON.stringify({creator:a.did,conversationId:browserId,action:'inspect'})};
    expect((await app.request(provider+path,request)).status).toBe(200);
    expect((await app.request(provider+path,{...request,headers:{...request.headers,Origin:origin}})).status).toBe(403);
    expect((await app.request(provider+path,{...request,body:JSON.stringify({creator:a.did,conversationId:uuidV7(),action:'inspect'})})).status).toBe(404);
    await accounts.revoke(readonly.credentialId);
    await expect(connections.conversationMembership(limited,{creator:a.did,conversationId:browserId,action:'inspect'})).rejects.toMatchObject({status:403});
    const expiring=await accounts.issue(c.address,false,undefined,['messages:read']);
    const expiredSession=(await accounts.authenticate('Bearer '+expiring.token))!;
    await db.sql`UPDATE account_api_credentials SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=${expiring.credentialId}`;
    await expect(connections.conversationMembership(expiredSession,{creator:a.did,conversationId:browserId,action:'inspect'})).rejects.toMatchObject({status:403});
    const full=(await accounts.authenticate('Bearer '+credentials[2]!.token))!;
    await expect(connections.conversationMembership({...full,serving_generation:2},{creator:a.did,conversationId:browserId,action:'leave'})).rejects.toMatchObject({status:403});

  }finally{server?.stop(true);await db.close();await rm(directory,{recursive:true,force:true});}
},90_000);
