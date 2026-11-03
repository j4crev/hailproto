import {randomBytes,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {ProviderDatabase} from '../src/db/database.js';
import {AccountDrafts,consumeDraft} from '../src/accounts/drafts.js';
import {MessageTrash} from '../src/accounts/message-trash.js';
import {uuidV7} from '../src/identity/uuid-v7.js';
import type {AccountApiSession} from '../src/accounts/repository.js';
import type {SQL} from 'bun';
const content={audience:'connections',connections:[],category:'',title:'Unfinished',text:'',alt:'',caption:'',header:null,forward:null,allowReply:false};
it.skipIf(!process.env.DATABASE_URL)('persists drafts across sessions, isolates accounts, rejects stale edits, and preserves Trash and atomic send semantics',async()=>{
  const db=new ProviderDatabase(process.env.DATABASE_URL!);
  try{
    await db.migrate();
    const sessions:AccountApiSession[]=[];
    for(const letter of ['a','b']){
      const id=randomUUID(),did='did:plc:'+letter.repeat(24);
      await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
        VALUES(${id},${randomUUID()},${id+'@example.com'},${did},'active',now(),${randomBytes(32)},'public')`;
      sessions.push({account_id:id,did,passkey_credential_id:'fixture'} as AccountApiSession);
    }
    const [session,other]=sessions as [AccountApiSession,AccountApiSession],drafts=new AccountDrafts(db.sql),trash=new MessageTrash(db.sql),id=uuidV7();
    const first=await drafts.mutate(session,id,'save',{revision:0,content});
    expect(first).toMatchObject({id,revision:1,content});
    expect(await new AccountDrafts(db.sql).read({...session,passkey_credential_id:'second-device'},id)).toEqual(first);
    expect(await drafts.read(other,id)).toBeNull();
    await expect(drafts.mutate(other,id,'save',{revision:1,content})).rejects.toThrow('changed');
    const edits=await Promise.allSettled([drafts.mutate(session,id,'save',{revision:1,content:{...content,text:'Device A'}}),drafts.mutate(session,id,'save',{revision:1,content:{...content,text:'Device B'}})]);
    expect(edits.filter(e=>e.status==='fulfilled')).toHaveLength(1);
    expect(edits.filter(e=>e.status==='rejected')).toHaveLength(1);
    await expect(db.sql.begin(async tx=>{await consumeDraft(tx as SQL,session,id,1);})).rejects.toThrow('changed');
    await expect(db.sql.begin(async tx=>{await consumeDraft(tx as SQL,session,id,2);throw Error('publication rejected');})).rejects.toThrow('publication rejected');
    expect(await drafts.read(session,id)).toMatchObject({revision:2});
    await drafts.mutate(session,id,'delete',{});
    expect(await drafts.read(session,id)).toBeNull();
    expect(await drafts.read(session,null,true)).toMatchObject({drafts:[{id,revision:3}]});
    await expect(drafts.mutate(session,id,'save',{revision:3,content})).rejects.toThrow('changed');
    await expect(db.sql.begin(async tx=>{await consumeDraft(tx as SQL,session,id,3);})).rejects.toThrow('changed');
    expect(await drafts.mutate(other,id,'restore',{})).toEqual({restored:0});
    expect(await drafts.mutate(session,id,'restore',{})).toEqual({restored:1});
    await db.sql.begin(async tx=>{await consumeDraft(tx as SQL,session,id,4);});
    expect(await drafts.read(session,id)).toBeNull();
    const create=async()=>{const next=uuidV7();await drafts.mutate(session,next,'save',{revision:0,content});return next;};
    const expired=await create();await drafts.mutate(session,expired,'delete',{});
    await db.sql`UPDATE account_message_drafts SET trashed_at=clock_timestamp()-interval '31 days' WHERE account_id=${session.account_id} AND id=${expired}`;
    expect(await drafts.mutate(session,expired,'restore',{})).toEqual({restored:0});
    expect(await drafts.read(session,null,true)).toMatchObject({drafts:[]});
    await trash.purgeExpired();expect((await db.sql`SELECT id FROM account_message_drafts WHERE account_id=${session.account_id}`)).toHaveLength(0);
    const removed=await create();await drafts.mutate(session,removed,'delete',{});expect(await trash.empty(session)).toEqual({deleted:1});
    expect(await drafts.mutate(session,removed,'restore',{})).toEqual({restored:0});
    const disabled=await create();await drafts.mutate(session,disabled,'delete',{});await trash.saveSettings(session,false);
    expect(await drafts.mutate(session,disabled,'restore',{})).toEqual({restored:0});
    const permanent=await create();expect(await drafts.mutate(session,permanent,'delete',{})).toEqual({state:'deleted'});
    expect(await drafts.mutate(session,permanent,'restore',{})).toEqual({restored:0});
    for(let i=0;i<51;i++)await create();
    const page=await drafts.read(session,null) as {drafts:unknown[];next:string};expect(page.drafts).toHaveLength(50);
    expect(await drafts.read(session,null,false,page.next)).toMatchObject({drafts:[expect.any(Object)],next:null});
  }finally{await db.close();}
});
