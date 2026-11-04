import {randomBytes,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {ProviderDatabase} from '../src/db/database.js';
import {MessageTrash} from '../src/accounts/message-trash.js';
import type {AccountApiSession} from '../src/accounts/repository.js';
it.skipIf(!process.env.DATABASE_URL)('preserves Trash, imports once, isolates accounts, and merges concurrent display updates',async()=>{
  const db=new ProviderDatabase(process.env.DATABASE_URL!);
  try {
    await db.migrate();
    const account_id=randomUUID(),did='did:plc:'+Array.from(randomBytes(24),b=>'abcdefghijklmnopqrstuvwxyz234567'[b%32]).join('');
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${account_id},${randomUUID()},${account_id+'@example.com'},${did},'active',now(),${randomBytes(32)},'public')`;
    const session={account_id,did} as AccountApiSession,preferences=new MessageTrash(db.sql);
    expect(await preferences.settings(session)).toEqual({trashEnabled:true,theme:null,showHeaderImages:null,startScreen:'feed'});
    await preferences.saveSettings(session,false);
    await preferences.saveDisplaySettings(session,{theme:'dark',showHeaderImages:false,initialize:true});
    await preferences.saveDisplaySettings(session,{theme:'light',showHeaderImages:true,initialize:true});
    expect(await preferences.settings(session)).toEqual({trashEnabled:false,theme:'dark',showHeaderImages:false,startScreen:'feed'});
    await Promise.all([preferences.saveDisplaySettings(session,{theme:'light'}),preferences.saveDisplaySettings(session,{showHeaderImages:true})]);
    expect(await preferences.settings(session)).toEqual({trashEnabled:false,theme:'light',showHeaderImages:true,startScreen:'feed'});
    await preferences.saveSettings(session,true);
    expect(await preferences.settings(session)).toEqual({trashEnabled:true,theme:'light',showHeaderImages:true,startScreen:'feed'});
    expect(await preferences.settings({...session,account_id:randomUUID()})).toEqual({trashEnabled:true,theme:null,showHeaderImages:null,startScreen:'feed'});
    await preferences.saveDisplaySettings(session,{startScreen:'inbox'});
    await preferences.saveDisplaySettings(session,{theme:'dark',startScreen:'feed',initialize:true});
    await preferences.saveDisplaySettings(session,{showHeaderImages:false});
    await preferences.saveSettings(session,false);
    expect((await preferences.settings(session)).startScreen).toBe('inbox');
    await preferences.saveSettings(session,true);
    await preferences.saveDisplaySettings(session,{startScreen:'feed'});
    expect((await preferences.settings(session)).startScreen).toBe('feed');
    await expect(db.sql.begin(async tx=>{
      await tx.unsafe(await Bun.file(new URL('../migrations/rollback/0103_start_screen.sql',import.meta.url)).text());
      expect((await tx`SELECT theme,trash_enabled FROM account_message_preferences WHERE account_id=${account_id}`)[0]).toMatchObject({theme:'light',trash_enabled:true});
      throw Error('rollback verified');
    })).rejects.toThrow('rollback verified');
    for(const input of [{theme:'invalid'},{theme:null},{showHeaderImages:'false'},{initialize:true},{startScreen:null},{startScreen:'invalid'},{theme:'dark',trashEnabled:false}])
      await expect(preferences.saveDisplaySettings(session,input)).rejects.toThrow('Invalid display preferences');
    await expect(db.sql.begin(async tx=>{
      await tx.unsafe(await Bun.file(new URL('../migrations/rollback/0085_display_preferences.sql',import.meta.url)).text());
      expect((await tx`SELECT trash_enabled FROM account_message_preferences WHERE account_id=${account_id}`)[0].trash_enabled).toBe(true);
      throw Error('rollback verified');
    })).rejects.toThrow('rollback verified');
    expect((await preferences.settings(session)).theme).toBe('light');
  } finally {await db.close();}
});
