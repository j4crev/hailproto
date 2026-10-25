import {createHash} from "node:crypto";
import {decodeDeterministic,decodePayload,encodeDeterministic,HailCodecError} from "@hailproto/codec";
import type {SQL} from "bun";
import {validateBodyBytes} from "../bodies/service.js";
import {withServingGeneration} from "../db/serving.js";
import {UserGrantError} from "../grants/service.js";
import {uuidV7} from "../identity/uuid-v7.js";
import {bodyDocument,outboundBody,type AccountMessaging} from "./messaging.js";
import type {AccountApiSession} from "./repository.js";
import type {ConnectionMessagingAuthority,ConnectionMessageTarget} from "./connection-authorization.js";

const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CATEGORY=/^[a-z0-9][a-z0-9._-]{0,63}$/;
const LOCK=684245163;
type Kind="category"|"connections";
type Publication={account_id:string;id:string;sender_did:string;serving_generation:number|string;category:string|null;
  manifest:Uint8Array|null;kind:Kind;
  body_bytes:Uint8Array;request_digest:Uint8Array;reply_until:number|string|null;created_at:Date;expires_at:Date;cancelled_at:Date|null};
const digest=(category:string,body:Uint8Array,replies:boolean)=>new Uint8Array(createHash("sha256")
  .update(encodeDeterministic({category,body,allowReplies:replies})).digest());
const connectionDigest=(ids:string[],body:Uint8Array)=>new Uint8Array(createHash("sha256").update(encodeDeterministic({connections:ids,body})).digest());

export class AccountPublications {
  constructor(private readonly sql:SQL,private readonly messaging:Pick<AccountMessaging,"send">,private readonly connections?:ConnectionMessagingAuthority){}

  async connectionTargets(session:AccountApiSession,sql=this.sql){
    if(!this.connections)throw new UserGrantError(409,"Connection messaging is unavailable");
    return {maxRecipients:100,connections:await this.connections.targets(session,sql)};
  }
  async createConnections(session:AccountApiSession,input:Record<string,unknown>){
    if(Object.keys(input).some(k=>!["publicationId","connections","text","body"].includes(k))||typeof input.publicationId!=="string"||!ID.test(input.publicationId)||
      !Array.isArray(input.connections)||!input.connections.length||input.connections.length>100||input.connections.some(id=>typeof id!=="string"||!ID.test(id))||
      new Set(input.connections).size!==input.connections.length||("text" in input)===("body" in input))throw new UserGrantError(400,"Choose between 1 and 100 distinct connections and one message body");
    const id=input.publicationId,ids=[...input.connections as string[]].sort(),body=outboundBody(input),requestDigest=connectionDigest(ids,body);
    await this.sql.begin(async tx=>{
      await tx`SELECT hail_assert_unfenced_account(${session.account_id}::uuid)`;
      if(!(await tx`SELECT a.id FROM provider_accounts a JOIN account_serving_generations g ON g.account_id=a.id WHERE a.id=${session.account_id}
        AND a.did=${session.did} AND a.onboarding_state='active' AND a.activation_verification_mode='public' AND g.generation=${session.serving_generation??1}`).length)throw new UserGrantError(409,"Current serving account is required");
      const prior=(await tx<Publication[]>`SELECT * FROM connection_message_batches WHERE account_id=${session.account_id} AND id=${id}`)[0];
      if(prior){if(Number(prior.serving_generation)!==(session.serving_generation??1)||!Buffer.from(prior.request_digest).equals(Buffer.from(requestDigest)))throw new UserGrantError(409,"Message batch ID already has another intent");return;}
      const active=await tx`SELECT publication_id,'category' AS kind FROM publication_targets WHERE account_id=${session.account_id} AND state='pending'
        UNION SELECT publication_id,'connections' FROM connection_message_targets WHERE account_id=${session.account_id} AND state='pending' LIMIT 5`;
      if(active.length>=5)throw new UserGrantError(409,"Finish or cancel open message batches first");
      const targets=(await this.connectionTargets(session,tx as SQL)).connections.filter(c=>ids.includes(c.connectionId));
      if(targets.length!==ids.length)throw new UserGrantError(409,"A selected connection is no longer active. Review the recipient list again");
      if(new Set(targets.map(t=>t.recipientDid)).size!==targets.length)throw new UserGrantError(400,"Choose each recipient only once");
      targets.sort((a,b)=>a.connectionId.localeCompare(b.connectionId));
      const manifest=encodeDeterministic(targets as never);
      await tx`INSERT INTO connection_message_batches(account_id,id,sender_did,serving_generation,body_bytes,manifest,request_digest)
        VALUES(${session.account_id},${id},${session.did},${session.serving_generation??1},${body},${manifest},${requestDigest})`;
      for(const target of targets)await tx`INSERT INTO connection_message_targets(account_id,publication_id,connection_id,connection_epoch,recipient_did,message_id)
        VALUES(${session.account_id},${id},${target.connectionId},${target.epoch},${target.recipientDid},${uuidV7()})`;
      await tx`UPDATE connection_message_batches SET sealed=true WHERE account_id=${session.account_id} AND id=${id}`;
    });
    return (await this.status(session,id,"connections"))!;
  }

  private async subscribers(session:Pick<AccountApiSession,"account_id"|"did">,category:string|null,sql=this.sql){
    return sql<{grant_id:string;recipient_did:string;scope_payload:any}[]>`
      SELECT lineage.grant_id,lineage.grantor_did AS recipient_did,selected.scope AS scope_payload
      FROM grant_lineages lineage JOIN grant_revisions revision ON revision.grant_id=lineage.grant_id
        AND revision.revision=lineage.current_revision
      CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(revision.scope_payload)='string'
        THEN (revision.scope_payload#>>'{}')::jsonb ELSE revision.scope_payload END AS scope) selected
      WHERE lineage.grantee_did=${session.did} AND lineage.current_status='active'
        AND (revision.expires_at IS NULL OR revision.expires_at>extract(epoch FROM clock_timestamp()))
        AND selected.scope->0->>'type'='categories'
        AND (${category}::text IS NULL OR (selected.scope->0->'values') ? ${category})
        AND ((lineage.local_account_id=${session.account_id} AND lineage.local_role='grantee') OR EXISTS (
          SELECT 1 FROM collocated_grant_receivers local WHERE local.grant_id=lineage.grant_id AND local.grantee_account_id=${session.account_id}))
      ORDER BY lineage.grant_id LIMIT ${category===null?10001:101}`;
  }

  async audiences(session:AccountApiSession){
    const rows=await this.subscribers(session,null);
    if(rows.length>10000)throw new UserGrantError(409,"Audience exceeds the alpha inventory limit");
    const counts=new Map<string,number>();
    for(const row of rows){const scope=typeof row.scope_payload==="string"?JSON.parse(row.scope_payload):row.scope_payload;
      for(const category of scope[0].values as string[])counts.set(category,(counts.get(category)??0)+1);}
    return {maxRecipients:100,categories:[...counts].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([category,subscribers])=>({category,subscribers}))};
  }

  async create(session:AccountApiSession,input:Record<string,unknown>){
    if(Object.keys(input).some(key=>!["publicationId","category","text","body","allowReplies"].includes(key))||
      typeof input.publicationId!=="string"||!ID.test(input.publicationId)||typeof input.category!=="string"||!CATEGORY.test(input.category)||
      typeof input.allowReplies!=="boolean"||("text" in input)===("body" in input))throw new UserGrantError(400,"Invalid publication intent");
    const id=input.publicationId,category=input.category,body=outboundBody(input),requestDigest=digest(category,body,input.allowReplies);
    await this.sql.begin(async tx=>{
      await tx`SELECT hail_assert_unfenced_account(${session.account_id}::uuid)`;
      const account=await tx`SELECT a.id FROM provider_accounts a JOIN account_serving_generations g ON g.account_id=a.id
        WHERE a.id=${session.account_id} AND a.did=${session.did} AND a.onboarding_state='active'
          AND a.activation_verification_mode='public' AND g.generation=${session.serving_generation??1}`;
      if(!account.length)throw new UserGrantError(409,"Current serving account is required");
      const prior=(await tx<Publication[]>`SELECT * FROM account_publications WHERE account_id=${session.account_id} AND id=${id}`)[0];
      if(prior){if(Number(prior.serving_generation)!==(session.serving_generation??1)||!Buffer.from(prior.request_digest).equals(Buffer.from(requestDigest)))
        throw new UserGrantError(409,"Publication ID already has another intent");return;}
      // ponytail: five open publications and 100 recipients each; qualify a higher-throughput queue before expanding the alpha.
      const active=await tx`SELECT publication_id,'category' AS kind FROM publication_targets WHERE account_id=${session.account_id} AND state='pending'
        UNION SELECT publication_id,'connections' FROM connection_message_targets WHERE account_id=${session.account_id} AND state='pending' LIMIT 5`;
      if(active.length>=5)throw new UserGrantError(409,"Finish or cancel open publications first");
      const targets=await this.subscribers(session,category,tx as SQL);
      if(!targets.length||targets.length>100)throw new UserGrantError(409,"Publication requires between 1 and 100 active category subscribers");
      await tx`INSERT INTO account_publications(account_id,id,sender_did,serving_generation,category,body_bytes,request_digest,reply_until)
        VALUES(${session.account_id},${id},${session.did},${session.serving_generation??1},${category},${body},${requestDigest},
          ${input.allowReplies?Math.floor(Date.now()/1000)+7*86400:null})`;
      for(const target of targets)await tx`INSERT INTO publication_targets(account_id,publication_id,grant_id,recipient_did,message_id)
        VALUES(${session.account_id},${id},${target.grant_id},${target.recipient_did},${uuidV7()})`;
      await tx`UPDATE account_publications SET sealed=true WHERE account_id=${session.account_id} AND id=${id}`;
    });
    return (await this.status(session,id))!;
  }

  async status(session:Pick<AccountApiSession,"account_id">,id:string,kind:Kind="category"){
    if(!ID.test(id))throw new UserGrantError(400,"Invalid publication ID");
    const parent=(await this.sql<Publication[]>`SELECT account_id,id,sender_did,serving_generation,category,body_bytes,request_digest,reply_until,created_at,expires_at,cancelled_at,NULL::bytea AS manifest,'category' AS kind
      FROM account_publications WHERE account_id=${session.account_id} AND id=${id} AND sealed AND ${kind}='category'
      UNION ALL SELECT account_id,id,sender_did,serving_generation,NULL::text,body_bytes,request_digest,NULL::bigint,created_at,expires_at,cancelled_at,manifest,'connections'
      FROM connection_message_batches WHERE account_id=${session.account_id} AND id=${id} AND sealed AND ${kind}='connections'`)[0];
    if(!parent)return null;
    const targets=await this.sql<{message_id:string;recipient_did:string;state:string;delivery:string|null}[]>`
      SELECT target.message_id,target.recipient_did,target.state,CASE WHEN sent.message_id IS NOT NULL THEN COALESCE(status.current_state,'indeterminate') END AS delivery
      FROM (SELECT account_id,publication_id,message_id,recipient_did,state FROM publication_targets WHERE ${kind}='category'
        UNION ALL SELECT account_id,publication_id,message_id,recipient_did,state FROM connection_message_targets WHERE ${kind}='connections') target
      LEFT JOIN sent_envelopes sent ON sent.sender_did=${parent.sender_did} AND sent.message_id=target.message_id
      LEFT JOIN sent_delivery_status status ON status.sender_did=sent.sender_did AND status.message_id=sent.message_id
      WHERE target.account_id=${session.account_id} AND target.publication_id=${id} ORDER BY target.recipient_did`;
    const counts={pending:0,submitted:0,blocked:0,cancelled:0,expired:0,indeterminate:0};
    const delivery={accepted:0,delivered:0,"on-hold":0,failed:0,cancelled:0,indeterminate:0};
    for(const target of targets){counts[target.state as keyof typeof counts]++;if(target.delivery)delivery[target.delivery as keyof typeof delivery]++;}
    return {publicationId:id,category:parent.category,...(kind==="connections"?{kind}:{}),total:targets.length,counts,delivery,
      targets:targets.map(row=>({messageId:row.message_id,recipient:row.recipient_did,state:row.state,delivery:row.delivery})),
      state:counts.pending?(parent.cancelled_at?"cancelling":"publishing"):(parent.cancelled_at?"cancelled":"finished"),
      createdAt:parent.created_at.toISOString(),expiresAt:parent.expires_at.toISOString()};
  }

  async recent(session:Pick<AccountApiSession,"account_id">,kind:Kind="category"){
    const rows=await this.sql<{id:string;category:string|null;created_at:Date;pending:boolean}[]>`
      SELECT publication.id,publication.category,publication.created_at,EXISTS (
        SELECT 1 FROM publication_targets target WHERE target.account_id=publication.account_id
          AND target.publication_id=publication.id AND target.state='pending') AS pending
       FROM account_publications publication WHERE publication.account_id=${session.account_id} AND sealed AND ${kind}='category'
       UNION ALL SELECT publication.id,NULL::text,publication.created_at,EXISTS(SELECT 1 FROM connection_message_targets target
         WHERE target.account_id=publication.account_id AND target.publication_id=publication.id AND target.state='pending') AS pending
       FROM connection_message_batches publication WHERE publication.account_id=${session.account_id} AND sealed AND ${kind}='connections'
      ORDER BY pending DESC,created_at DESC,id DESC LIMIT 20`;
    return {publications:rows.map(row=>({publicationId:row.id,category:row.category,createdAt:row.created_at.toISOString(),pending:row.pending}))};
  }

  private async exclusive<T>(operation:()=>Promise<T>){
    const connection=await this.sql.reserve();let locked=false;
    try{locked=(await connection<{locked:boolean}[]>`SELECT pg_try_advisory_lock(${LOCK}) AS locked`)[0]!.locked;
      if(!locked)return {busy:true as const};return {busy:false as const,value:await operation()};
    }finally{try{if(locked)await connection`SELECT pg_advisory_unlock(${LOCK})`;}finally{connection.release();}}
  }

  async cancel(session:AccountApiSession,id:string,kind:Kind="category"){
    if(!ID.test(id))throw new UserGrantError(400,"Invalid publication ID");
    const result=await this.exclusive(async()=>{
      if(!await this.status(session,id,kind))return null;
      await this.sql.begin(async tx=>{
        if(kind==="connections"){
          await tx`UPDATE connection_message_batches SET cancelled_at=COALESCE(cancelled_at,clock_timestamp()) WHERE account_id=${session.account_id} AND id=${id}
            AND EXISTS(SELECT 1 FROM connection_message_targets WHERE account_id=${session.account_id} AND publication_id=${id} AND state='pending')`;
          await tx`UPDATE connection_message_targets target SET state='cancelled' WHERE account_id=${session.account_id} AND publication_id=${id} AND state='pending'
            AND NOT EXISTS(SELECT 1 FROM sent_envelopes sent WHERE sent.sender_account_id=target.account_id AND sent.message_id=target.message_id)`;
          return;
        }
        await tx`UPDATE account_publications SET cancelled_at=COALESCE(cancelled_at,clock_timestamp()) WHERE account_id=${session.account_id} AND id=${id}
          AND EXISTS (SELECT 1 FROM publication_targets WHERE account_id=${session.account_id} AND publication_id=${id} AND state='pending')`;
        // Already-created envelopes retain their durable submission attempt, even after cancellation.
        await tx`UPDATE publication_targets target SET state='cancelled' WHERE account_id=${session.account_id} AND publication_id=${id} AND state='pending'
          AND NOT EXISTS (SELECT 1 FROM sent_envelopes sent WHERE sent.sender_account_id=target.account_id AND sent.message_id=target.message_id)`;
      });return this.status(session,id,kind);
    });
    if(result.busy)throw new UserGrantError(409,"Publication work is in progress; retry cancellation");return result.value;
  }

  async workOne(){
    // ponytail: one provider-wide worker/cancellation lock, held across one bounded network attempt. Use fenced leases when alpha volume outgrows it.
    const result=await this.exclusive(async()=>{
      const row=(await this.sql<(Publication&{message_id:string;grant_id:string|null;connection_id:string|null;connection_epoch:number|string|null;recipient_did:string;attempts:number;expired:boolean})[]>`
        SELECT publication.account_id,publication.id,publication.sender_did,publication.serving_generation,publication.category,publication.body_bytes,
          publication.request_digest,publication.reply_until,publication.created_at,publication.expires_at,publication.cancelled_at,NULL::bytea AS manifest,'category' AS kind,
          target.message_id,target.grant_id,NULL::uuid AS connection_id,NULL::bigint AS connection_epoch,target.recipient_did,target.attempts,publication.expires_at<=clock_timestamp() AS expired,target.next_attempt_at
        FROM account_publications publication JOIN publication_targets target ON target.account_id=publication.account_id AND target.publication_id=publication.id
        WHERE publication.sealed AND target.state='pending' AND (target.next_attempt_at<=clock_timestamp() OR publication.expires_at<=clock_timestamp())
        UNION ALL SELECT publication.account_id,publication.id,publication.sender_did,publication.serving_generation,NULL::text,publication.body_bytes,
          publication.request_digest,NULL::bigint,publication.created_at,publication.expires_at,publication.cancelled_at,publication.manifest,'connections',
          target.message_id,NULL::uuid,target.connection_id,target.connection_epoch,target.recipient_did,target.attempts,publication.expires_at<=clock_timestamp(),target.next_attempt_at
        FROM connection_message_batches publication JOIN connection_message_targets target ON target.account_id=publication.account_id AND target.publication_id=publication.id
        WHERE publication.sealed AND target.state='pending' AND (target.next_attempt_at<=clock_timestamp() OR publication.expires_at<=clock_timestamp())
        ORDER BY expires_at,next_attempt_at,message_id LIMIT 1`)[0];
      if(!row)return false;
      return withServingGeneration(row.account_id,Number(row.serving_generation),async()=>{
        if(row.expired){
          if(row.kind==="connections"){
            await this.sql`UPDATE connection_message_targets target SET state=CASE WHEN EXISTS(SELECT 1 FROM sent_envelopes sent WHERE sent.sender_account_id=target.account_id AND sent.message_id=target.message_id)
              THEN 'indeterminate' ELSE 'expired' END WHERE account_id=${row.account_id} AND publication_id=${row.id} AND state='pending'`;return true;
          }
          await this.sql`UPDATE publication_targets target SET state=CASE WHEN EXISTS (
            SELECT 1 FROM sent_envelopes sent WHERE sent.sender_account_id=target.account_id AND sent.message_id=target.message_id)
            THEN 'indeterminate' ELSE 'expired' END WHERE account_id=${row.account_id} AND publication_id=${row.id} AND state='pending'`;
          return true;
        }
        const manifest=row.kind==="connections"?decodeDeterministic(new Uint8Array(row.manifest!)) as unknown as ConnectionMessageTarget[]:null;
        const expected=manifest?connectionDigest(manifest.map(t=>t.connectionId).sort(),new Uint8Array(row.body_bytes)):digest(row.category!,new Uint8Array(row.body_bytes),row.reply_until!==null);
        if(!Buffer.from(expected).equals(Buffer.from(row.request_digest))||manifest&&!manifest.some(t=>t.connectionId===row.connection_id&&t.recipientDid===row.recipient_did&&t.epoch===Number(row.connection_epoch)))
          throw new Error("Persisted publication intent digest does not match");
        let state="submitted";
        try{
          const bytes=new Uint8Array(row.body_bytes),profile=validateBodyBytes(bytes);
          const content=profile==="spt-1"?{text:decodePayload("hail.body.spt-1",bytes).blocks[0]!.children[0]!.text}:{body:bodyDocument(bytes)};
          await this.messaging.send({did:row.sender_did},{messageId:row.message_id,...content,...(row.kind==="connections"?
            {connectionId:row.connection_id,connectionEpoch:Number(row.connection_epoch),recipientDid:row.recipient_did}:
            {grantId:row.grant_id,category:row.category,...(row.reply_until===null?{}:{replyUntil:Number(row.reply_until)})})});
        }catch(error){
          if(error instanceof UserGrantError||error instanceof HailCodecError)state="blocked";
          else{
            const retry=Math.min(300,5*2**Math.min(row.attempts,6));
            if(row.kind==="connections")await this.sql`UPDATE connection_message_targets SET attempts=attempts+1,next_attempt_at=clock_timestamp()+${retry}*interval '1 second'
              WHERE account_id=${row.account_id} AND publication_id=${row.id} AND message_id=${row.message_id} AND state='pending'`;
            else await this.sql`UPDATE publication_targets SET attempts=attempts+1,next_attempt_at=clock_timestamp()+${retry}*interval '1 second'
              WHERE account_id=${row.account_id} AND publication_id=${row.id} AND message_id=${row.message_id} AND state='pending'`;
            return true;
          }
        }
        if(row.kind==="connections")await this.sql`UPDATE connection_message_targets SET state=${state},attempts=attempts+1
          WHERE account_id=${row.account_id} AND publication_id=${row.id} AND message_id=${row.message_id} AND state='pending'`;
        else await this.sql`UPDATE publication_targets SET state=${state},attempts=attempts+1
          WHERE account_id=${row.account_id} AND publication_id=${row.id} AND message_id=${row.message_id} AND state='pending'`;
        return true;
      });
    });return result.busy?false:result.value;
  }
}
