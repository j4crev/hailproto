import {randomBytes,randomUUID} from "node:crypto";
import {expect,it} from "vitest";
import {ProviderDatabase} from "../src/db/database.js";
import {withServingGeneration} from "../src/db/serving.js";
import {conversationPreferences,saveConversationPreferences} from "../src/accounts/conversation-preferences.js";
import type {AccountApiSession} from "../src/accounts/repository.js";

it.skipIf(!process.env.DATABASE_URL)("preserves introduction choices across restart and rejects fenced and stale-generation writes",async()=>{
  const db=new ProviderDatabase(process.env.DATABASE_URL!);
  try{
    await db.migrate();
    const account_id=randomUUID(),did="did:plc:"+"z".repeat(24),session={account_id,did} as AccountApiSession;
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${account_id},${randomUUID()},${account_id+'@example.com'},${did},'active',now(),${randomBytes(32)},'public')`;
    await db.sql`INSERT INTO account_message_preferences(account_id,trash_enabled,theme) VALUES(${account_id},false,'dark')`;
    expect(await conversationPreferences(db.sql,session)).toMatchObject({allowIntroductions:true,configured:false});
    await db.sql.begin(tx=>saveConversationPreferences(tx,session,{allowIntroductions:false}));
    expect(await conversationPreferences(db.sql,session)).toMatchObject({allowIntroductions:false,configured:true});
    // Reads of an unset default never materialize a choice or rewrite denials.
    expect((await db.sql`SELECT allow_introductions FROM account_conversation_preferences WHERE account_id=${account_id}`)[0].allow_introductions).toBe(false);
    const save=()=>db.sql.begin(tx=>saveConversationPreferences(tx,session,{allowIntroductions:true}));
    await withServingGeneration(account_id,1,save);
    await expect(withServingGeneration(account_id,2,save)).rejects.toThrow();
    const restarted=new ProviderDatabase(process.env.DATABASE_URL!);
    try{expect(await conversationPreferences(restarted.sql,session)).toEqual({allowIntroductions:true,configured:true,truncated:false,connections:[]});}
    finally{await restarted.close();}
    expect((await db.sql`SELECT trash_enabled,theme FROM account_message_preferences WHERE account_id=${account_id}`)[0]).toEqual({trash_enabled:false,theme:'dark'});
    await db.sql`INSERT INTO provider_migration_fences(did,account_id,transfer_id,destination_service_base,state)
      VALUES(${did},${account_id},${randomUUID()},'https://destination.example.com/hail','fenced')`;
    await expect(save()).rejects.toThrow('migration-fenced');
    await expect(db.sql`DELETE FROM account_conversation_preferences WHERE account_id=${account_id}`).rejects.toThrow('migration-fenced');
    await expect(db.sql`INSERT INTO connection_conversation_preferences(account_id,connection_id,epoch,allow_introductions)
      VALUES(${account_id},${randomUUID()},1,true)`).rejects.toThrow('migration-fenced');
  }finally{await db.close();}
});
