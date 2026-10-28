import type {SQL} from "bun";
import type {AccountApiSession} from "./repository.js";
import {UserGrantError} from "../grants/service.js";
import {withServingGeneration} from "../db/serving.js";
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DID=/^did:plc:[a-z2-7]{24}$/;
type BodyReference={sender_did:string;body_digest:Uint8Array;media_type:string;profile:string};
export class MessageTrash {
  constructor(private readonly sql:SQL){}
  async settings(session:AccountApiSession){
    const rows=await this.sql<{trash_enabled:boolean}[]>`SELECT trash_enabled FROM account_message_preferences WHERE account_id=${session.account_id}`;
    return {trashEnabled:rows[0]?.trash_enabled??true};
  }
  private async lock(tx:SQL,session:AccountApiSession){
    const rows=await tx`SELECT id FROM provider_accounts WHERE id=${session.account_id} AND did=${session.did} AND onboarding_state='active' FOR UPDATE`;
    if(!rows.length)throw new UserGrantError(409,"Account is unavailable");
    await tx`SELECT hail_assert_unfenced_account(${session.account_id}::uuid)`;
  }
  private async cleanBodies(tx:SQL,did:string,removed:BodyReference[]){
    // Bodies may be shared by several delivered messages. Keep every live reference.
    for(const row of removed)await tx`DELETE FROM verified_body_provenance body WHERE recipient_did=${did}
      AND sender_did=${row.sender_did} AND digest=${row.body_digest} AND media_type=${row.media_type} AND profile=${row.profile}
      AND NOT EXISTS(SELECT 1 FROM delivered_messages m WHERE m.recipient_did=body.recipient_did
        AND m.sender_did=body.sender_did AND m.body_digest=body.digest AND m.media_type=body.media_type AND m.profile=body.profile)`;
  }
  async saveSettings(session:AccountApiSession,enabled:unknown){
    if(typeof enabled!=="boolean")throw new UserGrantError(400,"Invalid Trash preference");
    return this.sql.begin(async tx=>{
      await this.lock(tx as SQL,session);
      await tx`INSERT INTO account_message_preferences(account_id,trash_enabled) VALUES(${session.account_id},${enabled})
        ON CONFLICT(account_id) DO UPDATE SET trash_enabled=EXCLUDED.trash_enabled`;
      if(!enabled){
        const removed=await tx<BodyReference[]>`DELETE FROM delivered_messages WHERE recipient_did=${session.did} AND trashed_at IS NOT NULL RETURNING sender_did,body_digest,media_type,profile`;
        await this.cleanBodies(tx as SQL,session.did,removed);
      }
      return {trashEnabled:enabled};
    });
  }
  async remove(session:AccountApiSession,sender:string,id:string,permanent=false){
    if(!DID.test(sender)||!ID.test(id))throw new UserGrantError(400,"Invalid message identity");
    return this.sql.begin(async tx=>{
      await this.lock(tx as SQL,session);
      const preferences=await tx<{trash_enabled:boolean}[]>`SELECT trash_enabled FROM account_message_preferences WHERE account_id=${session.account_id}`;
      if(permanent||preferences[0]?.trash_enabled===false){
        const removed=await tx<BodyReference[]>`DELETE FROM delivered_messages WHERE recipient_did=${session.did} AND sender_did=${sender} AND message_id=${id} RETURNING sender_did,body_digest,media_type,profile`;
        await this.cleanBodies(tx as SQL,session.did,removed);
        return {messageId:id,state:"deleted"};
      }
      // Retrying deletion never extends the original retention period.
      const rows=await tx`UPDATE delivered_messages SET trashed_at=COALESCE(trashed_at,clock_timestamp())
        WHERE recipient_did=${session.did} AND sender_did=${sender} AND message_id=${id} RETURNING message_id`;
      return {messageId:id,state:rows.length?"trashed":"deleted"};
    });
  }
  async restore(session:AccountApiSession,items:unknown){
    if(!Array.isArray(items)||items.length<1||items.length>100||items.some(i=>!i||typeof i!=="object"||
      Object.keys(i).some(k=>k!=="sender"&&k!=="messageId")||typeof i.sender!=="string"||!DID.test(i.sender)||typeof i.messageId!=="string"||!ID.test(i.messageId)))
      throw new UserGrantError(400,"Choose 1 to 100 messages to restore");
    return this.sql.begin(async tx=>{
      await this.lock(tx as SQL,session);
      let restored=0;
      for(const item of items){
        const rows=await tx`UPDATE delivered_messages SET trashed_at=NULL WHERE recipient_did=${session.did}
          AND sender_did=${item.sender} AND message_id=${item.messageId} AND trashed_at>clock_timestamp()-interval '30 days' RETURNING message_id`;
        restored+=rows.length;
      }
      return {restored};
    });
  }
  async purgeExpired(){
    const accounts=await this.sql<{id:string;did:string;generation:number}[]>`SELECT a.id,a.did,g.generation FROM provider_accounts a
      JOIN account_serving_generations g ON g.account_id=a.id WHERE a.onboarding_state='active'
      AND NOT EXISTS(SELECT 1 FROM provider_migration_fences f WHERE f.account_id=a.id)
      AND EXISTS(SELECT 1 FROM delivered_messages m WHERE m.recipient_did=a.did AND m.trashed_at<=clock_timestamp()-interval '30 days')
      ORDER BY a.id LIMIT 100`;
    let deleted=0;
    for(const account of accounts)await withServingGeneration(account.id,Number(account.generation),()=>this.sql.begin(async tx=>{
      await tx`SELECT id FROM provider_accounts WHERE id=${account.id} FOR UPDATE`;
      if((await tx`SELECT 1 FROM provider_migration_fences WHERE account_id=${account.id}`).length)return;
      const rows=await tx<BodyReference[]>`DELETE FROM delivered_messages WHERE (sender_did,message_id) IN
        (SELECT sender_did,message_id FROM delivered_messages WHERE recipient_did=${account.did}
          AND trashed_at<=clock_timestamp()-interval '30 days' ORDER BY trashed_at LIMIT 500) RETURNING sender_did,body_digest,media_type,profile`;
      await this.cleanBodies(tx as SQL,account.did,rows);deleted+=rows.length;
    }));
    await this.sql`SELECT hail_collect_received_blobs(500)`;
    return {deleted};
  }
}
