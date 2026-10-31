import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {createWebCryptoSigner,createWebCryptoVerifier,signPayload,verifySignedPayload,inspectSignedPayload} from '@hailproto/codec';
import {ProviderDatabase} from '../src/db/database.js';
import {sharedConversationFixture} from './support/shared-conversation-fixture.js';
import {OnboardingRepository} from '../src/onboarding/repository.js';
import {GrantRepository} from '../src/grants/repository.js';
import {BodyRepository} from '../src/bodies/repository.js';
import {EnvelopeRepository} from '../src/envelopes/repository.js';
import {EnvelopeService} from '../src/envelopes/service.js';
import {EnvelopeReceiver} from '../src/envelopes/receiver.js';
import {AccountMessaging} from '../src/accounts/messaging.js';
import {AccountPublications} from '../src/accounts/publications.js';
import {DeliveryRepository} from '../src/delivery/repository.js';
import {conversationState,changeConversationMembership,reviveConversation,pruneConversationState} from '../src/accounts/conversation-memberships.js';
import {collectConversationHistory,validateConversationHistory,reconstructConversations} from '../src/migration/conversation-history.js';
import {uuidV7} from '../src/identity/uuid-v7.js';
import {ed25519PublicKeyFromDidKey} from '../src/identity/did-key.js';
import {importEd25519PrivateKey} from '../src/identity/keys.js';

it.skipIf(!process.env.DATABASE_URL)('delivers shared replies between non-connections, enforces leave and expiry, and revives only expired consent',async()=>{
  const db=new ProviderDatabase(process.env.DATABASE_URL!);
  try{
    await db.migrate();
    await expect(db.sql.begin(async tx=>{
      for(const migration of ['0096_conversation_revival_outbox','0095_conversation_batches','0094_conversation_envelopes','0093_conversation_memberships','0092_conversation_introduction_preferences'])
        await tx.unsafe(await Bun.file(new URL('../migrations/rollback/'+migration+'.sql',import.meta.url)).text());
      throw Error('Empty rollback verified');
    })).rejects.toThrow('Empty rollback verified');
    const {a,b,c,origin,encryptor,resolver,authority,connections}=await sharedConversationFixture(db.sql);
    const accounts=new OnboardingRepository(db.sql),envelopes=new EnvelopeRepository(db.sql),bodies=new BodyRepository(db.sql);
    const receiver=new EnvelopeReceiver(accounts,envelopes,resolver,origin+'/hail',undefined,authority);
    const service=new EnvelopeService(accounts,new GrantRepository(db.sql),envelopes,encryptor,resolver,origin+'/hail',undefined,authority);
    let genericReceipts=1;
    const messaging=new AccountMessaging(db.sql,bodies,envelopes,service,async(sender,id)=>{
      const outcome=await receiver.receive((await envelopes.sent(sender,id))!);
      if(outcome!=='accepted'&&outcome!=='duplicate')throw Error('Pending admission: '+outcome);
      if(genericReceipts-->0)return {messageId:id,accepted:false,outcome:'received',envelopeDigest:''};
      return {messageId:id,state:'accepted' as const,revision:1,envelopeDigest:''};
    });
    const publications=new AccountPublications(db.sql,messaging,authority),delivery=new DeliveryRepository(db.sql,authority);
    const deliver=async()=>{for(let i=0;i<10;i++){
      const claim=await delivery.claimDue();if(!claim)return;
      const bytes=(await db.sql<{body_bytes:Uint8Array}[]>`SELECT body_bytes FROM detached_bodies b JOIN provider_accounts a ON a.id=b.sender_account_id
        WHERE a.did=${claim.senderDid} AND b.digest=${claim.envelope.body.digest.value}`)[0]!.body_bytes;
      expect(await delivery.deliver(claim,new Uint8Array(bytes))).toBe('delivered');
    }throw Error('Delivery queue did not drain');};
    const id=uuidV7(),targets=(await publications.connectionTargets(a.session)).connections;
    expect((await authority.targets(b.session)).map(t=>t.recipientDid)).toEqual([a.did]);
    await publications.createConnections(a.session,{publicationId:id,connections:targets.map(t=>t.connectionId),text:'Shared original'});
    expect(await publications.workOne()).toBe(true);expect(await publications.workOne()).toBe(true);await deliver();
    expect((await publications.status(a.session,id,'connections'))!.counts.pending).toBe(1);
    await db.sql`UPDATE connection_message_targets SET next_attempt_at=now() WHERE state='pending'`;
    expect(await publications.workOne()).toBe(true);
    expect((await publications.status(a.session,id,'connections'))!.counts.submitted).toBe(2);
    const identity={creator:a.did,conversationId:id};
    for(const user of [a,b,c])expect((await conversationState(db.sql,user.session,identity))?.state).toBe('active');
    const originals=await db.sql<{message_id:string;recipient_did:string;envelope_cose:Uint8Array}[]>`SELECT message_id,recipient_did,envelope_cose FROM sent_envelopes WHERE conversation_id=${id}`;
    expect(originals.length).toBe(2);expect(new Set(originals.map(r=>inspectSignedPayload('hail.envelope',r.envelope_cose).payload.conversation_message_id)).size).toBe(1);
    const bobRoot=originals.find(r=>r.recipient_did===b.did)!;
    await publications.replyConversation(a.session,{publicationId:uuidV7(),...identity,sender:a.did,messageId:bobRoot.message_id,text:'Creator follows up on their own sent message'});
    await publications.workOne();await publications.workOne();await deliver();
    const replyId=uuidV7();
    await publications.replyConversation(b.session,{publicationId:replyId,...identity,sender:a.did,messageId:bobRoot.message_id,text:'Bob replies to everyone'});
    expect(await publications.workOne()).toBe(true);expect(await publications.workOne()).toBe(true);await deliver();
    expect((await db.sql`SELECT message_id FROM delivered_messages WHERE recipient_did=${c.did} AND sender_did=${b.did}`).length).toBe(1);
    expect((await authority.targets(b.session)).map(t=>t.recipientDid)).toEqual([a.did]);
    // Retrying frozen batch IDs cannot change semantics or the roster.
    await expect(publications.createConnections(a.session,{publicationId:id,connections:targets.map(t=>t.connectionId),text:'Shared original',delivery:'private'})).rejects.toThrow('private');
    await expect(publications.replyConversation(b.session,{publicationId:replyId,...identity,sender:a.did,messageId:bobRoot.message_id,text:'changed'})).rejects.toThrow('another intent');
    const before=(await conversationState(db.sql,c.session,identity))!.expiresAt;
    const queuedReply=uuidV7();
    await publications.replyConversation(b.session,{publicationId:queuedReply,...identity,sender:a.did,messageId:bobRoot.message_id,text:'Accepted before leave, delivered afterward'});
    await publications.workOne();await publications.workOne();
    await db.sql.begin(tx=>changeConversationMembership(tx,c.session,identity,'leave'));
    for(let n=0;n<2;n++){
      const claim=(await delivery.claimDue())!;
      const bytes=(await db.sql<{body_bytes:Uint8Array}[]>`SELECT body_bytes FROM detached_bodies WHERE digest=${claim.envelope.body.digest.value}`)[0]!.body_bytes;
      if(claim.envelope.to===c.did)expect(await delivery.authorizeConnection(claim)).toBe(false);
      expect(await delivery.deliver(claim,new Uint8Array(bytes))).toBe(claim.envelope.to===c.did?'unauthorized':'delivered');
    }
    const carolRoot=originals.find(r=>r.recipient_did===c.did)!;
    expect(await receiver.receive(carolRoot.envelope_cose)).toBe('duplicate');
    expect((await conversationState(db.sql,c.session,identity))?.state).toBe('left');
    await expect(publications.replyConversation(c.session,{publicationId:uuidV7(),...identity,sender:a.did,messageId:carolRoot.message_id,text:'not allowed'})).rejects.toThrow('Rejoin');
    // A fresh creator-signed request cannot override a manual leave.
    const descriptor=(await envelopes.conversationForSender(a.did,a.did,id))!,now=Math.floor(Date.now()/1000);
    const request={type:'hail.conversation-revival' as const,version:1 as const,conversation_id:id,
      descriptor_hash:{algorithm:'sha-256' as const,value:new Uint8Array(createHash('sha256').update(descriptor.descriptor_cose).digest())},
      from:a.did,to:c.did,request_id:uuidV7(),issued_at:now,expires_at:now+3600};
    const key=await accounts.getKey(a.id,'hail-messaging'),raw=await encryptor.decrypt(a.id,key.role,key.algorithm,key.publicKey,key);
    const privateKey=await importEd25519PrivateKey(raw);raw.fill(0);
    const altered={...descriptor.descriptor,participants:[a.did,b.did,'did:plc:'+'d'.repeat(24)].sort()};
    const alteredBytes=await signPayload('hail.conversation',altered,createWebCryptoSigner(a.did+'#hail-messaging',privateKey));
    const rootPayload=inspectSignedPayload('hail.envelope',bobRoot.envelope_cose).payload;
    if(rootPayload.authorization.type!=='conversation')throw Error('Expected conversation root');
    const forgedRoot=await signPayload('hail.envelope',{...rootPayload,message_id:uuidV7(),authorization:{...rootPayload.authorization,
      descriptor_hash:{algorithm:'sha-256',value:new Uint8Array(createHash('sha256').update(alteredBytes).digest())}},
      conversation_introduction:{...rootPayload.conversation_introduction!,descriptor:alteredBytes}},createWebCryptoSigner(a.did+'#hail-messaging',privateKey));
    expect(await receiver.receive(forgedRoot)).toBe('ignored');
    expect((await conversationState(db.sql,b.session,identity))!.participants).toEqual(descriptor.descriptor.participants);

    const verify=async(r:typeof request)=>verifySignedPayload('hail.conversation-revival',await signPayload('hail.conversation-revival',r,
      createWebCryptoSigner(a.did+'#hail-messaging',privateKey)),createWebCryptoVerifier(async()=>ed25519PublicKeyFromDidKey(a.keys.messagingDidKey)));
    const ac=targets.find(t=>t.recipientDid===c.did)!,connection={type:'connection' as const,connection_id:ac.connectionId,epoch:ac.epoch};
    const leftRequest=await verify(request);
    expect(await db.sql.begin(tx=>reviveConversation(tx,c.session,leftRequest,connection))).toEqual({outcome:'left'});
    expect((await conversationState(db.sql,c.session,identity))!.expiresAt).toBe(before);
    await db.sql.begin(tx=>changeConversationMembership(tx,c.session,identity,'rejoin'));
    await db.sql`UPDATE conversation_memberships SET expires_at=clock_timestamp()-interval '1 second' WHERE account_id=${c.id}`;
    await db.sql.begin(tx=>changeConversationMembership(tx,c.session,identity,'open'));
    expect((await conversationState(db.sql,c.session,identity))?.state).toBe('expired');
    await expect(db.sql.begin(tx=>changeConversationMembership(tx,c.session,identity,'rejoin'))).rejects.toThrow('creator revival');
    const renewedRequest=await verify({...request,request_id:uuidV7()});
    expect(await db.sql.begin(tx=>reviveConversation(tx,c.session,renewedRequest,connection))).toEqual({outcome:'renewed'});
    const renewed=(await conversationState(db.sql,c.session,identity))!.expiresAt;
    expect(await db.sql.begin(tx=>reviveConversation(tx,c.session,renewedRequest,connection))).toEqual({outcome:'renewed'});
    expect((await conversationState(db.sql,c.session,identity))!.expiresAt).toBe(renewed);
    // Exercise the durable creator control path, including restart-safe status.
    await db.sql`UPDATE conversation_memberships SET expires_at=clock_timestamp()-interval '1 second' WHERE account_id=${b.id}`;
    await db.sql.begin(tx=>changeConversationMembership(tx,c.session,identity,'leave'));
    const operationId=uuidV7();
    const queued=await connections.conversationRevival(a.session,{conversationId:id,operationId});
    expect(queued.targets.map(t=>t.outcome)).toEqual(['pending','pending']);
    await expect(connections.conversationRevival(b.session,{conversationId:id,operationId:uuidV7()})).rejects.toThrow('Only the original creator');
    expect(await connections.workConversationRevival()).toBe(true);expect(await connections.workConversationRevival()).toBe(true);
    const status=await connections.conversationRevival(a.session,{conversationId:id,operationId});
    expect(status.targets.find(t=>t.recipient===b.did)?.outcome).toBe('renewed');
    expect(status.targets.find(t=>t.recipient===c.did)?.outcome).toBe('left');
    expect((await connections.conversationRevival(a.session,{conversationId:id,operationId:uuidV7()})).operationId).toBe(operationId);
    expect((await conversationState(db.sql,c.session,identity))?.state).toBe('left');
    await db.sql`INSERT INTO account_conversation_preferences(account_id,allow_introductions) VALUES(${c.id},false)`;
    // Portable checkpoints retain explicit denial, leaves, exact descriptors and outbox intent.
    for(const user of [a,b,c]){
      const owner={accountId:user.id,did:user.did,sourceGeneration:1,sourceServiceBase:origin+'/hail'},captured=new Date().toISOString();
      const history=await collectConversationHistory(db.sql,owner,captured);
      expect(validateConversationHistory(history,owner,captured)).toEqual(history);
      await db.sql.begin(tx=>reconstructConversations(tx,history));
      const tampered=structuredClone(history);tampered.tables.conversation_memberships[0]!.account_id=uuidV7();
      expect(()=>validateConversationHistory(tampered,owner,captured)).toThrow('portable conversation');
      if(user===c){expect(history.tables.account_conversation_preferences[0]!.allow_introductions).toBe(false);expect(history.tables.conversation_memberships[0]!.state).toBe('left');}
    }
    for(const migration of ['0096_conversation_revival_outbox','0095_conversation_batches','0094_conversation_envelopes','0093_conversation_memberships','0092_conversation_introduction_preferences'])
      await expect(db.sql.begin(async tx=>tx.unsafe(await Bun.file(new URL('../migrations/rollback/'+migration+'.sql',import.meta.url)).text()))).rejects.toThrow();
    // Denied introductions do not silently grant non-connection participants access.
    const deniedId=uuidV7();
    await publications.createConnections(a.session,{publicationId:deniedId,connections:targets.map(t=>t.connectionId),text:'Introduction under recipient policy'});
    for(let n=0;n<2;n++)await publications.workOne();await deliver();
    expect(await conversationState(db.sql,c.session,{creator:a.did,conversationId:deniedId})).toBeNull();
    const deniedTargets=(await publications.status(a.session,deniedId,'connections'))!.targets;
    const bSource=deniedTargets.find(t=>t.recipient===b.did)!;
    const racingReply=uuidV7();
    await publications.replyConversation(b.session,{publicationId:racingReply,creator:a.did,conversationId:deniedId,sender:a.did,messageId:bSource.messageId,text:'Reply before Carol admission'});
    for(let n=0;n<2;n++)await publications.workOne();await deliver();
    expect(await conversationState(db.sql,c.session,{creator:a.did,conversationId:deniedId})).toBeNull();
    await db.sql`UPDATE account_conversation_preferences SET allow_introductions=true WHERE account_id=${c.id}`;
    for(let n=0;n<4;n++){
      await db.sql`UPDATE connection_message_targets SET next_attempt_at=now() WHERE state='pending'`;
      for(let j=0;j<2;j++)await publications.workOne();
    }
    await deliver();
    expect((await publications.status(b.session,racingReply,'connections'))!.counts.submitted).toBe(2);
    expect((await conversationState(db.sql,c.session,{creator:a.did,conversationId:deniedId}))?.state).toBe('active');
    // Collect unused expired authority; neither the old introduction nor a fresh
    // creator revival can reconstruct the deleted grant. Saved leaves survive.
    const oldId=uuidV7(),oldDescriptor={...descriptor.descriptor,conversation_id:oldId,created_at:now-15*86400,admission_until:now-8*86400};
    const oldBytes=await signPayload('hail.conversation',oldDescriptor,createWebCryptoSigner(a.did+'#hail-messaging',privateKey));
    const oldHash=new Uint8Array(createHash('sha256').update(oldBytes).digest());
    await db.sql`INSERT INTO conversation_descriptors(creator_did,conversation_id,descriptor_hash,descriptor_cose,participants,created_at,admission_until,signing_key,signing_evidence)
      SELECT creator_did,${oldId},${oldHash},${oldBytes},participants,${new Date(oldDescriptor.created_at*1000)},${new Date(oldDescriptor.admission_until*1000)},signing_key,signing_evidence
      FROM conversation_descriptors WHERE creator_did=${a.did} AND conversation_id=${id}`;
    await db.sql`INSERT INTO conversation_memberships(account_id,creator_did,conversation_id,state,expires_at) VALUES(${c.id},${a.did},${oldId},'active',clock_timestamp()-interval '1 day')`;
    await pruneConversationState(db.sql);
    expect((await db.sql`SELECT 1 FROM conversation_descriptors WHERE conversation_id=${oldId}`).length).toBe(0);
    expect((await conversationState(db.sql,c.session,identity))?.state).toBe('left');
    const expiredRoot=await signPayload('hail.envelope',{...rootPayload,to:c.did,message_id:uuidV7(),conversation_message_id:oldId,
      authorization:{...rootPayload.authorization,conversation_id:oldId,descriptor_hash:{algorithm:'sha-256',value:oldHash}},
      conversation_introduction:{descriptor:oldBytes,connection_id:ac.connectionId,epoch:ac.epoch}},createWebCryptoSigner(a.did+'#hail-messaging',privateKey));
    expect(await receiver.receive(expiredRoot)).not.toBe('accepted');
    const cleanedRevival=await verify({...request,conversation_id:oldId,descriptor_hash:{algorithm:'sha-256',value:oldHash},request_id:uuidV7()});
    await expect(db.sql.begin(tx=>reviveConversation(tx,c.session,cleanedRevival,connection))).rejects.toThrow('Unknown conversation');
    expect(await conversationState(db.sql,c.session,{creator:a.did,conversationId:oldId})).toBeNull();
    // Capacity rejection is atomic: no unused creator grant or descriptor survives.
    for(let n=0;n<5;n++)await publications.createConnections(a.session,{publicationId:uuidV7(),connections:[targets[0]!.connectionId],delivery:'private',text:'Queued capacity test'});
    const rejectedId=uuidV7();
    await expect(publications.createConnections(a.session,{publicationId:rejectedId,connections:targets.map(t=>t.connectionId),text:'Over capacity'})).rejects.toThrow('Finish or cancel');
    expect((await db.sql`SELECT 1 FROM conversation_descriptors WHERE conversation_id=${rejectedId}`).length).toBe(0);
  }finally{await db.close();}
},60_000);
