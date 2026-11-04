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
    const rows=await this.sql<{trash_enabled:boolean;theme:string|null;show_header_images:boolean|null;start_screen:string}[]>`SELECT trash_enabled,theme,show_header_images,start_screen FROM account_message_preferences WHERE account_id=${session.account_id}`;
    return {trashEnabled:rows[0]?.trash_enabled??true,theme:rows[0]?.theme??null,showHeaderImages:rows[0]?.show_header_images??null,startScreen:rows[0]?.start_screen??"feed"};
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
        await tx`DELETE FROM account_message_drafts WHERE account_id=${session.account_id} AND trashed_at IS NOT NULL`;
        await tx`UPDATE account_sent_dispositions SET deleted=true WHERE account_id=${session.account_id} AND NOT deleted`;
        const removed=await tx<BodyReference[]>`DELETE FROM delivered_messages WHERE recipient_did=${session.did} AND trashed_at IS NOT NULL RETURNING sender_did,body_digest,media_type,profile`;
        await this.cleanBodies(tx as SQL,session.did,removed);
      }
      return {trashEnabled:enabled};
    });
  }
  async saveDisplaySettings(session:AccountApiSession,input:Record<string,unknown>){
    const {theme,showHeaderImages,startScreen,initialize=false}=input;
    if(Object.keys(input).some(k=>!['theme','showHeaderImages','startScreen','initialize'].includes(k)) ||
      (theme===undefined&&showHeaderImages===undefined&&startScreen===undefined) ||
      ('theme' in input && !['system','light','dark'].includes(theme as string)) ||
      ('startScreen' in input && !['feed','inbox'].includes(startScreen as string)) ||
      ('showHeaderImages' in input && typeof showHeaderImages!=='boolean') || typeof initialize!=='boolean')
      throw new UserGrantError(400,"Invalid display preferences");
    return this.sql.begin(async tx=>{
      await this.lock(tx as SQL,session);
      const rows=await tx`INSERT INTO account_message_preferences(account_id,theme,show_header_images,start_screen)
        VALUES(${session.account_id},${theme??null},${showHeaderImages??null},${startScreen??"feed"})
        ON CONFLICT(account_id) DO UPDATE SET
          theme=CASE WHEN ${initialize} THEN COALESCE(account_message_preferences.theme,EXCLUDED.theme)
            ELSE COALESCE(EXCLUDED.theme,account_message_preferences.theme) END,
          show_header_images=CASE WHEN ${initialize} THEN COALESCE(account_message_preferences.show_header_images,EXCLUDED.show_header_images)
            ELSE COALESCE(EXCLUDED.show_header_images,account_message_preferences.show_header_images) END,
          start_screen=CASE WHEN ${initialize} OR ${startScreen===undefined} THEN account_message_preferences.start_screen
            ELSE EXCLUDED.start_screen END
        RETURNING theme,show_header_images,start_screen`;
      return {theme:rows[0]!.theme,showHeaderImages:rows[0]!.show_header_images,startScreen:rows[0]!.start_screen};
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
  async empty(session:AccountApiSession){
    return this.sql.begin(async tx=>{
      await this.lock(tx as SQL,session);
      const removed=await tx<BodyReference[]>`DELETE FROM delivered_messages WHERE recipient_did=${session.did} AND trashed_at IS NOT NULL RETURNING sender_did,body_digest,media_type,profile`;
      await this.cleanBodies(tx as SQL,session.did,removed);
      const sent=await tx`UPDATE account_sent_dispositions SET deleted=true WHERE account_id=${session.account_id} AND NOT deleted RETURNING send_id`;
      const drafts=await tx`DELETE FROM account_message_drafts WHERE account_id=${session.account_id} AND trashed_at IS NOT NULL RETURNING id`;
      return {deleted:removed.length+sent.length+drafts.length};
    });
  }
  async clearSent(session:AccountApiSession,expectedTrashEnabled:unknown){
    if(typeof expectedTrashEnabled!=="boolean")throw new UserGrantError(400,"Invalid Trash preference");
    return this.sql.begin(async tx=>{
      await this.lock(tx as SQL,session);
      const settings=await tx`SELECT trash_enabled FROM account_message_preferences WHERE account_id=${session.account_id}`;
      const enabled=settings[0]?.trash_enabled!==false;
      if(enabled!==expectedTrashEnabled)throw new UserGrantError(409,"Trash settings changed. Reload and try again.");
      const removed=await tx`INSERT INTO account_sent_dispositions(account_id,kind,send_id,deleted)
        SELECT item.account_id,item.kind,item.id,${!enabled} FROM account_sent_items item
        WHERE item.account_id=${session.account_id} AND item.sender_did=${session.did}
          AND EXISTS(SELECT 1 FROM account_sent_members m WHERE m.account_id=item.account_id AND m.kind=item.kind AND m.send_id=item.id AND m.submitted)
          AND NOT EXISTS(SELECT 1 FROM account_sent_members m WHERE m.account_id=item.account_id AND m.kind=item.kind AND m.send_id=item.id AND m.completed IS NOT TRUE)
        ON CONFLICT DO NOTHING RETURNING send_id`;
      return {affected:removed.length,state:enabled?"trashed":"deleted"};
    });
  }
  async restoreSent(session:AccountApiSession,kind:unknown,id:unknown){
    if(typeof kind!=="string"||!["category","connections","message"].includes(kind)||typeof id!=="string"||!ID.test(id))throw new UserGrantError(400,"Invalid sent message");
    return this.sql.begin(async tx=>{
      await this.lock(tx as SQL,session);
      const rows=await tx`DELETE FROM account_sent_dispositions WHERE account_id=${session.account_id} AND kind=${kind} AND send_id=${id}
        AND NOT deleted AND trashed_at>clock_timestamp()-interval '30 days' RETURNING send_id`;
      return {restored:rows.length};
    });
  }
  async purgeExpired(){
    const accounts=await this.sql<{id:string;did:string;generation:number}[]>`SELECT a.id,a.did,g.generation FROM provider_accounts a
      JOIN account_serving_generations g ON g.account_id=a.id WHERE a.onboarding_state='active'
      AND NOT EXISTS(SELECT 1 FROM provider_migration_fences f WHERE f.account_id=a.id)
      AND (EXISTS(SELECT 1 FROM delivered_messages m WHERE m.recipient_did=a.did AND m.trashed_at<=clock_timestamp()-interval '30 days')
        OR EXISTS(SELECT 1 FROM account_message_drafts d WHERE d.account_id=a.id AND d.trashed_at<=clock_timestamp()-interval '30 days')
        OR EXISTS(SELECT 1 FROM attachment_uploads u WHERE u.account_id=a.id AND u.created_at<clock_timestamp()-interval '24 hours'
          AND NOT EXISTS(SELECT 1 FROM account_message_drafts d,jsonb_array_elements(COALESCE(d.content->'attachments','[]'::jsonb)) f
            WHERE d.account_id=u.account_id AND f->'digest'->>'value'=rtrim(translate(encode(u.digest,'base64'),'+/','-_'),'='))))
      ORDER BY a.id LIMIT 100`;
    let deleted=0;
    for(const account of accounts)await withServingGeneration(account.id,Number(account.generation),()=>this.sql.begin(async tx=>{
      await tx`SELECT id FROM provider_accounts WHERE id=${account.id} FOR UPDATE`;
      if((await tx`SELECT 1 FROM provider_migration_fences WHERE account_id=${account.id}`).length)return;
      const rows=await tx<BodyReference[]>`DELETE FROM delivered_messages WHERE (sender_did,message_id) IN
        (SELECT sender_did,message_id FROM delivered_messages WHERE recipient_did=${account.did}
          AND trashed_at<=clock_timestamp()-interval '30 days' ORDER BY trashed_at LIMIT 500) RETURNING sender_did,body_digest,media_type,profile`;
      const drafts=await tx`DELETE FROM account_message_drafts WHERE account_id=${account.id} AND trashed_at<=clock_timestamp()-interval '30 days' RETURNING id`;
      await tx`DELETE FROM attachment_uploads u WHERE u.account_id=${account.id} AND u.created_at<clock_timestamp()-interval '24 hours'
        AND NOT EXISTS(SELECT 1 FROM account_message_drafts d,jsonb_array_elements(COALESCE(d.content->'attachments','[]'::jsonb)) f
          WHERE d.account_id=u.account_id AND f->'digest'->>'value'=rtrim(translate(encode(u.digest,'base64'),'+/','-_'),'='))`;
      await this.cleanBodies(tx as SQL,account.did,rows);deleted+=rows.length+drafts.length;
    }));
    await this.sql`SELECT hail_collect_received_blobs(500)`;
    await this.sql`DELETE FROM attachment_blobs b WHERE digest IN(SELECT digest FROM attachment_blobs a
      WHERE NOT EXISTS(SELECT 1 FROM attachment_uploads u WHERE u.digest=a.digest)
      AND NOT EXISTS(SELECT 1 FROM body_attachment_refs r WHERE r.digest=a.digest)
      AND NOT EXISTS(SELECT 1 FROM received_attachment_refs r WHERE r.digest=a.digest)
      LIMIT 500 FOR UPDATE SKIP LOCKED)
      AND NOT EXISTS(SELECT 1 FROM attachment_uploads u WHERE u.digest=b.digest)
      AND NOT EXISTS(SELECT 1 FROM body_attachment_refs r WHERE r.digest=b.digest)
      AND NOT EXISTS(SELECT 1 FROM received_attachment_refs r WHERE r.digest=b.digest)`;
    return {deleted};
  }
}
