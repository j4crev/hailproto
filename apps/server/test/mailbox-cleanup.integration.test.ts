import {randomBytes,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {ProviderDatabase} from '../src/db/database.js';
import {MessageTrash} from '../src/accounts/message-trash.js';
import {sentSends} from '../src/accounts/sent-sends.js';
import {outboundBody} from '../src/accounts/messaging.js';
import {uuidV7} from '../src/identity/uuid-v7.js';
import type {AccountApiSession} from '../src/accounts/repository.js';

it.skipIf(!process.env.DATABASE_URL)('cleans all completed sends, preserves active work and protocol evidence, and restores only live Trash',async()=>{
  const db=new ProviderDatabase(process.env.DATABASE_URL!);
  try{
    await db.migrate();
    const account_id=randomUUID(),did='did:plc:'+'a'.repeat(24),otherId=randomUUID(),otherDid='did:plc:'+'b'.repeat(24);
    for(const [id,owner] of [[account_id,did],[otherId,otherDid]])await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${id!},${randomUUID()},${id!+'@example.com'},${owner!},'active',now(),${randomBytes(32)},'public')`;
    const session={account_id,did} as AccountApiSession,trash=new MessageTrash(db.sql),body=outboundBody({text:'Mailbox cleanup test'}),digest=randomBytes(32);
    for(const owner of [account_id,otherId])await db.sql`INSERT INTO detached_bodies(digest,sender_account_id,body_bytes) VALUES(${digest},${owner},${body})`;
    async function send(state:string|null,owner=account_id,sender=did){
      const id=uuidV7();
      await db.sql`INSERT INTO sent_envelopes(sender_did,message_id,recipient_did,grant_id,envelope_cose,envelope_digest,body_digest,sender_account_id)
        VALUES(${sender},${id},${otherDid},${randomUUID()},${new Uint8Array([1])},${randomBytes(32)},${digest},${owner})`;
      if(state)await db.sql`INSERT INTO sent_delivery_status(sender_did,message_id,recipient_did,current_revision,current_state,payload_bytes,cose,signing_public_key,signing_plc_document,signing_plc_data,signing_plc_operation_log)
        VALUES(${sender},${id},${otherDid},1,${state},${new Uint8Array([1])},${new Uint8Array([1])},'fixture','{}','{}','[]')`;
      return id;
    }
    const completed=[];for(let i=0;i<8;i++)completed.push(await send(i%2?'delivered':'failed'));
    const active=[await send('accepted'),await send('on-hold'),await send(null)];
    await send('delivered',otherId,otherDid);
    expect((await sentSends(db.sql,session,null)).next).not.toBeNull();
    expect(await trash.clearSent(session,true)).toEqual({affected:8,state:'trashed'});
    expect(await trash.clearSent(session,true)).toEqual({affected:0,state:'trashed'});
    expect((await sentSends(db.sql,session,null)).messages.map(m=>m.messageId).sort()).toEqual(active.sort());
    expect((await sentSends(db.sql,{...session,account_id:otherId,did:otherDid},null)).messages).toHaveLength(1);
    const page=await sentSends(db.sql,session,null,undefined,true);
    expect(page.messages).toHaveLength(5);expect(page.next).not.toBeNull();
    expect((await sentSends(db.sql,session,page.next,undefined,true)).messages).toHaveLength(3);
    expect(await trash.restoreSent({...session,account_id:otherId,did:otherDid},'message',completed[0])).toEqual({restored:0});
    expect(await trash.restoreSent(session,'message',completed[0])).toEqual({restored:1});
    expect((await sentSends(db.sql,session,null,{kind:'message',id:completed[0]!})).messages).toHaveLength(1);
    expect(await trash.clearSent(session,true)).toEqual({affected:1,state:'trashed'});
    await db.sql`UPDATE account_sent_dispositions SET trashed_at=clock_timestamp()-interval '31 days' WHERE account_id=${account_id} AND send_id=${completed[0]!}`;
    expect(await trash.restoreSent(session,'message',completed[0])).toEqual({restored:0});
    expect((await sentSends(db.sql,session,null,{kind:'message',id:completed[0]!},true)).messages).toHaveLength(0);
    expect(await trash.empty(session)).toEqual({deleted:8});
    expect(await trash.empty(session)).toEqual({deleted:0});
    expect(await trash.restoreSent(session,'message',completed[1])).toEqual({restored:0});
    expect((await sentSends(db.sql,session,null,undefined,true)).messages).toHaveLength(0);
    const later=await send('cancelled');
    await trash.saveSettings(session,false);
    await expect(trash.clearSent(session,true)).rejects.toThrow('Trash settings changed');
    expect(await trash.clearSent(session,false)).toEqual({affected:1,state:'deleted'});
    expect(await trash.restoreSent(session,'message',later)).toEqual({restored:0});
    await trash.saveSettings(session,true);
    const last=await send('delivered');await trash.clearSent(session,true);await trash.saveSettings(session,false);
    expect(await trash.restoreSent(session,'message',last)).toEqual({restored:0});
    // Cleanup must not remove signed delivery/reply evidence or shared bodies.
    expect(Number((await db.sql`SELECT count(*) AS n FROM sent_envelopes WHERE sender_account_id=${account_id}`)[0].n)).toBe(13);
    expect((await db.sql`SELECT hail_sent_visible(${account_id}::uuid,${completed[0]!}::uuid) AS visible`)[0].visible).toBe(false);
    expect((await db.sql`SELECT hail_sent_visible(${account_id}::uuid,${active[0]!}::uuid) AS visible`)[0].visible).toBe(true);
    await trash.saveSettings(session,true);
    const batch=uuidV7(),batchDone=await send('delivered'),batchActive=await send('accepted');
    await db.sql`INSERT INTO connection_message_batches(account_id,id,sender_did,serving_generation,body_bytes,manifest,request_digest,sealed)
      VALUES(${account_id},${batch},${did},1,${body},${new Uint8Array([1])},${randomBytes(32)},false)`;
    for(const [id,peer] of [[batchDone,'did:plc:'+'c'.repeat(24)],[batchActive,'did:plc:'+'d'.repeat(24)]])await db.sql`INSERT INTO connection_message_targets(account_id,publication_id,connection_id,connection_epoch,recipient_did,message_id,state)
      VALUES(${account_id},${batch},${uuidV7()},1,${peer!},${id!},'submitted')`;
    await db.sql`UPDATE connection_message_batches SET sealed=true WHERE account_id=${account_id} AND id=${batch}`;
    expect(await trash.clearSent(session,true)).toEqual({affected:0,state:'trashed'});
    // The completed recipient cannot be hidden separately while its batch is active.
    expect((await sentSends(db.sql,session,null,{kind:'connections',id:batch})).messages).toHaveLength(1);
    await db.sql`UPDATE sent_delivery_status SET current_state='delivered',current_revision=2 WHERE sender_did=${did} AND message_id=${batchActive}`;
    expect(await trash.clearSent(session,true)).toEqual({affected:1,state:'trashed'});
    expect((await db.sql`SELECT hail_sent_visible(${account_id}::uuid,${batchDone}::uuid) AS visible`)[0].visible).toBe(false);
    expect(await trash.restoreSent(session,'connections',batch)).toEqual({restored:1});
    expect((await db.sql`SELECT hail_sent_visible(${account_id}::uuid,${batchDone}::uuid) AS visible`)[0].visible).toBe(true);
    // Rollback refuses to resurrect removed mail.
    await expect(db.sql.begin(async tx=>{await tx.unsafe(await Bun.file(new URL('../migrations/rollback/0100_sent_mailbox.sql',import.meta.url)).text());})).rejects.toThrow('Sent disposition');
  }finally{await db.close();}
});
