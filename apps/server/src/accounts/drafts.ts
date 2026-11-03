import type {SQL} from 'bun';
import type {AccountApiSession} from './repository.js';
import {UserGrantError} from '../grants/service.js';
import {draftIdPattern,parseDraftContent,type Draft} from '@racrproto/client-support/drafts';
type Row={id:string;revision:number;content:Draft['content'];updated_at:Date;trashed_at:Date|null};
const present=(r:Row):Draft=>({id:r.id,revision:r.revision,content:r.content,updatedAt:r.updated_at.toISOString(),trashedAt:r.trashed_at?.toISOString()??null});
export class AccountDrafts {
  constructor(private readonly sql:SQL){}
  async read(session:AccountApiSession,id:string|null,trash=false,after:string|null=null){
    if(id!==null&&!draftIdPattern.test(id)||after!==null&&!draftIdPattern.test(after))throw new UserGrantError(400,'Invalid draft ID');
    const rows=await this.sql<Row[]>`SELECT d.* FROM account_message_drafts d WHERE account_id=${session.account_id}
      AND (${id}::uuid IS NULL OR id=${id}::uuid) AND (${after}::uuid IS NULL OR id<${after}::uuid)
      AND (CASE WHEN ${trash} THEN trashed_at>clock_timestamp()-interval '30 days' ELSE trashed_at IS NULL END)
      AND NOT EXISTS(SELECT 1 FROM account_sent_items s WHERE s.account_id=d.account_id AND s.id=d.id)
      ORDER BY id DESC LIMIT 51`;
    if(id)return rows[0]?present(rows[0]):null;
    return {drafts:rows.slice(0,50).map(present),next:rows.length>50?rows[49]!.id:null};
  }
  async mutate(session:AccountApiSession,id:string,operation:string,input:Record<string,unknown>){
    if(!draftIdPattern.test(id))throw new UserGrantError(400,'Invalid draft ID');
    if(operation==='save'){
      if(Object.keys(input).sort().join(',')!=='content,revision'||!Number.isSafeInteger(input.revision)||Number(input.revision)<0)throw new UserGrantError(400,'Invalid draft revision');
      try{parseDraftContent(input.content);}catch{throw new UserGrantError(400,'Invalid draft content');}
    }else if(!['delete','restore'].includes(operation)||Object.keys(input).length)throw new UserGrantError(400,'Invalid draft operation');
    return this.sql.begin(async tx=>{
      const owner=await tx`SELECT id FROM provider_accounts WHERE id=${session.account_id} AND did=${session.did} AND onboarding_state='active' FOR UPDATE`;
      if(!owner.length)throw new UserGrantError(409,'Account unavailable');
      await tx`SELECT hail_assert_unfenced_account(${session.account_id}::uuid)`;
      const sent=await tx`SELECT 1 FROM account_sent_items WHERE account_id=${session.account_id} AND id=${id}::uuid`;
      if(sent.length)throw new UserGrantError(409,'Draft already sent');
      if(operation==='save'){
        const current=await tx<Row[]>`SELECT * FROM account_message_drafts WHERE account_id=${session.account_id} AND id=${id}::uuid`;
        if(current[0]?.trashed_at||(current[0]?.revision??0)!==input.revision)throw new UserGrantError(409,'Draft changed on another device');
        const rows=await tx<Row[]>`INSERT INTO account_message_drafts(account_id,id,content) VALUES(${session.account_id},${id}::uuid,${JSON.stringify(input.content)}::text::jsonb)
          ON CONFLICT(account_id,id) DO UPDATE SET content=EXCLUDED.content,revision=account_message_drafts.revision+1,updated_at=clock_timestamp() RETURNING *`;
        return present(rows[0]!);
      }
      if(operation==='restore'){
        const rows=await tx`UPDATE account_message_drafts SET trashed_at=NULL,revision=revision+1 WHERE account_id=${session.account_id} AND id=${id}::uuid AND trashed_at>clock_timestamp()-interval '30 days' RETURNING id`;
        return {restored:rows.length};
      }
      const settings=await tx`SELECT trash_enabled FROM account_message_preferences WHERE account_id=${session.account_id}`;
      if(settings[0]?.trash_enabled===false){await tx`DELETE FROM account_message_drafts WHERE account_id=${session.account_id} AND id=${id}::uuid`;return {state:'deleted'};}
      await tx`UPDATE account_message_drafts SET trashed_at=COALESCE(trashed_at,clock_timestamp()),revision=revision+1 WHERE account_id=${session.account_id} AND id=${id}::uuid AND trashed_at IS NULL`;
      return {state:'trashed'};
    });
  }
}

/** Called inside publication acceptance: rollback preserves the draft on failure. */
export async function consumeDraft(tx:SQL,session:AccountApiSession,id:string,revision:unknown){
  await tx`SELECT id FROM provider_accounts WHERE id=${session.account_id} FOR UPDATE`;
  const rows=await tx`SELECT revision,trashed_at FROM account_message_drafts WHERE account_id=${session.account_id} AND id=${id}::uuid`;
  if(rows.length||revision!==undefined){
    if(!session.passkey_credential_id||!rows.length||rows[0]!.trashed_at||rows[0]!.revision!==revision)throw new UserGrantError(409,'Draft changed; reload before sending');
    await tx`DELETE FROM account_message_drafts WHERE account_id=${session.account_id} AND id=${id}::uuid`;
  }
}
export function validateDraftRevision(value:unknown){
  if(value!==undefined&&(!Number.isSafeInteger(value)||Number(value)<1))throw new UserGrantError(400,'Invalid draft revision');
}
