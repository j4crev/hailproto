import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {decodeBase64Url,decodeDeterministic,encodeDeterministic,inspectSignedPayload,type HailValue} from '@hailproto/codec';
import type {SQL} from 'bun';
import {PLC_READ_EVIDENCE_POLICY_VERSION} from '../identity/managed-profile.js';
import {PUBLIC_EVIDENCE_LIMITS} from '../plc/read-evidence.js';
import type {ConnectionHistoryOwner} from './connection-history.js';

// Separate versioned checkpoint: older connection-history bytes keep their domain.
export const CONVERSATION_COLUMNS={
  public_plc_resolution_evidence:'evidence_digest did operation_cid verified_at bundle_bytes',
  account_conversation_preferences:'account_id allow_introductions updated_at',
  connection_conversation_preferences:'account_id connection_id epoch allow_introductions updated_at',
  conversation_descriptors:'creator_did conversation_id descriptor_hash descriptor_cose participants created_at admission_until signing_key signing_evidence',
  conversation_memberships:'account_id creator_did conversation_id state admitted_at expires_at last_activity_at left_at',
  conversation_revival_receipts:'account_id creator_did conversation_id request_id request_hash expires_at outcome',
  conversation_revival_batches:'account_id id creator_did conversation_id serving_generation created_at',
  conversation_revival_targets:'account_id batch_id recipient_did request_id request_cose connection_id connection_epoch outcome expires_at next_attempt_at attempts',
  connection_message_batches:'account_id id sender_did serving_generation body_bytes manifest request_digest created_at expires_at cancelled_at sealed conversation_context',
  connection_message_targets:'account_id publication_id connection_id connection_epoch recipient_did message_id state attempts next_attempt_at',
} as const;
type Table=keyof typeof CONVERSATION_COLUMNS;
type Row=Record<string,any>;
export interface ConversationHistory extends ConnectionHistoryOwner {type:'hail.conversation-history';version:1;capturedAt:string;tables:Record<Table,Row[]>;}
const hash=(b:Uint8Array)=>new Uint8Array(createHash('sha256').update(b).digest());
const same=(a:Uint8Array,b:Uint8Array)=>Buffer.from(a).equals(Buffer.from(b));
const fail=():never=>{throw Error('Invalid portable conversation state');};
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(v);
const did=(v:unknown)=>typeof v==='string'&&/^did:plc:[a-z2-7]{24}$/.test(v);
const date=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const positive=(v:unknown)=>/^[1-9][0-9]*$/.test(String(v))&&Number.isSafeInteger(Number(v));
const bytes=(v:unknown,max=262144)=>{if(typeof v!=='string'||!/^\\x(?:[0-9a-f]{2})+$/.test(v)||v.length>2+max*2)return fail();return new Uint8Array(Buffer.from(v.slice(2),'hex'));};
const identity=(r:Row)=>r.creator_did+'/'+r.conversation_id;
const keys:Record<Table,string[]>={public_plc_resolution_evidence:['evidence_digest'],account_conversation_preferences:['account_id'],connection_conversation_preferences:['account_id','connection_id','epoch'],
  conversation_descriptors:['creator_did','conversation_id'],conversation_memberships:['account_id','creator_did','conversation_id'],
  conversation_revival_receipts:['account_id','creator_did','request_id'],conversation_revival_batches:['account_id','id'],
  conversation_revival_targets:['account_id','batch_id','recipient_did'],connection_message_batches:['account_id','id'],connection_message_targets:['account_id','publication_id','recipient_did']};
export function validateConversationHistory(h:ConversationHistory,owner:ConnectionHistoryOwner,capturedAt:string){
  if(!h||h.type!=='hail.conversation-history'||h.version!==1||h.capturedAt!==capturedAt||!date(capturedAt)||
    Object.keys(h).sort().join(',')!=='accountId,capturedAt,did,sourceGeneration,sourceServiceBase,tables,type,version'||
    Object.entries(owner).some(([k,v])=>h[k as keyof ConversationHistory]!==v)||!h.tables||Object.keys(h.tables).sort().join(',')!==Object.keys(CONVERSATION_COLUMNS).sort().join(','))return fail();
  for(const t of Object.keys(CONVERSATION_COLUMNS) as Table[]){
    const rows=h.tables[t],columns=CONVERSATION_COLUMNS[t].split(' ');if(!Array.isArray(rows))return fail();const seen=new Set<string>();
    for(const r of rows){
      if(!r||Object.keys(r).length!==columns.length||columns.some(k=>!Object.hasOwn(r,k))||t!=='conversation_descriptors'&&t!=='public_plc_resolution_evidence'&&r.account_id!==owner.accountId)return fail();
      const key=JSON.stringify(keys[t].map(k=>r[k]));if(seen.has(key))return fail();seen.add(key);
      for(const [k,v] of Object.entries(r)){
        if((k==='id'||k.endsWith('_id'))&&v!==null&&!uuid(v))return fail();
        if(k.endsWith('_did')&&!did(v))return fail();
        if(k.endsWith('_at')&&v!==null&&!date(v))return fail();
      }
      if('serving_generation' in r&&(!positive(r.serving_generation)||Number(r.serving_generation)>owner.sourceGeneration))return fail();
    }
  }
  for(const r of [...h.tables.account_conversation_preferences,...h.tables.connection_conversation_preferences])if(typeof r.allow_introductions!=='boolean'||'epoch' in r&&!positive(r.epoch))return fail();
  const descriptors=new Map(h.tables.conversation_descriptors.map(r=>[identity(r),r]));
  for(const r of descriptors.values()){
    const p=inspectSignedPayload('hail.conversation',bytes(r.descriptor_cose,16384)).payload;
    if(p.from!==r.creator_did||p.conversation_id!==r.conversation_id||!p.participants.includes(owner.did)||!isDeepStrictEqual(p.participants,r.participants)||
      Date.parse(r.created_at)!==p.created_at*1000||Date.parse(r.admission_until)!==p.admission_until*1000||!same(hash(bytes(r.descriptor_cose)),bytes(r.descriptor_hash,32)))return fail();
  }
  const refs=new Set([...descriptors.values()].flatMap(r=>r.signing_evidence?.verification?.profile==='strict-public-v1'?['\\x'+Buffer.from(decodeBase64Url(r.signing_evidence.verification.digest)).toString('hex')]:[]));
  if(refs.size!==h.tables.public_plc_resolution_evidence.length)return fail();
  for(const r of h.tables.public_plc_resolution_evidence)if(!refs.has(r.evidence_digest)||!same(hash(bytes(r.bundle_bytes,16777216)),bytes(r.evidence_digest,32)))return fail();
  const memberships=new Map(h.tables.conversation_memberships.map(r=>[identity(r),r]));
  if(memberships.size!==descriptors.size)return fail();
  for(const r of memberships.values())if(!descriptors.has(identity(r))||!['active','left'].includes(r.state)||(r.state==='left')!==(r.left_at!==null)||!date(r.admitted_at)||!date(r.expires_at))return fail();
  for(const r of h.tables.conversation_revival_receipts)if(!memberships.has(identity(r))||!['renewed','active','left','denied'].includes(r.outcome)||bytes(r.request_hash,32).length!==32)return fail();
  const revivals=new Map(h.tables.conversation_revival_batches.map(r=>[r.id,r]));
  for(const r of revivals.values())if(r.creator_did!==owner.did||!memberships.has(identity(r)))return fail();
  for(const r of h.tables.conversation_revival_targets){
    const batch=revivals.get(r.batch_id),p=inspectSignedPayload('hail.conversation-revival',bytes(r.request_cose,16384)).payload;
    if(!batch||!['renewed','active','left','denied','expired'].includes(r.outcome)||p.from!==owner.did||p.to!==r.recipient_did||p.request_id!==r.request_id||p.conversation_id!==batch.conversation_id||
      Date.parse(r.expires_at)!==p.expires_at*1000||!same(p.descriptor_hash.value,bytes(descriptors.get(identity(batch))!.descriptor_hash,32))||
      !descriptors.get(identity(batch))!.participants.includes(p.to)||(r.connection_id===null)!==(r.connection_epoch===null)||r.connection_epoch!==null&&!positive(r.connection_epoch))return fail();
  }
  const batches=new Map(h.tables.connection_message_batches.map(r=>[r.id,r]));
  for(const r of batches.values()){
    const context=decodeDeterministic(bytes(r.conversation_context)) as any,audience=decodeDeterministic(bytes(r.manifest)) as any[];
    const d=descriptors.get(context.creator+'/'+context.conversationId),targets=h.tables.connection_message_targets.filter(t=>t.publication_id===r.id);
    if(!d||r.sender_did!==owner.did||r.sealed!==true||context.logicalId!==r.id||typeof context.introduction!=='boolean'||
      context.introduction&&(context.creator!==owner.did||context.conversationId!==r.id)||!Array.isArray(audience)||audience.length!==d.participants.length-1||targets.length!==audience.length||
      new Set(audience.map(t=>t.recipientDid)).size!==audience.length||audience.some(t=>t.recipientDid===owner.did||!d.participants.includes(t.recipientDid)||!targets.some(r=>r.recipient_did===t.recipientDid&&r.connection_id===t.connectionId&&Number(r.connection_epoch)===Number(t.epoch)))||
      !same(hash(encodeDeterministic({context:bytes(r.conversation_context),manifest:bytes(r.manifest),body:bytes(r.body_bytes)})),bytes(r.request_digest,32)))return fail();
  }
  for(const r of h.tables.connection_message_targets)if(!batches.has(r.publication_id)||!['submitted','blocked','cancelled','expired','indeterminate'].includes(r.state)||(r.connection_id===null)!==(r.connection_epoch===null)||r.connection_epoch!==null&&!positive(r.connection_epoch))return fail();
  return h;
}
export const conversationHistoryDigest=(h:ConversationHistory)=>hash(encodeDeterministic(h as unknown as HailValue,{...PUBLIC_EVIDENCE_LIMITS,maximumBytes:67108864,maximumTextBytes:16777216,maximumArrayLength:100000,maximumItems:2000000}));
export async function collectConversationHistory(tx:SQL,owner:ConnectionHistoryOwner,capturedAt:string):Promise<ConversationHistory>{
  const tables={} as ConversationHistory['tables'];
  for(const t of Object.keys(CONVERSATION_COLUMNS) as Table[]){
    if(t==='public_plc_resolution_evidence')continue;
    const projection=CONVERSATION_COLUMNS[t].split(' ').map(k=>`'${k}',t."${k}"`).join(',');
    const where=t==='conversation_descriptors'?'EXISTS(SELECT 1 FROM conversation_memberships m WHERE m.account_id=$1::uuid AND m.creator_did=t.creator_did AND m.conversation_id=t.conversation_id)':
      't.account_id=$1::uuid'+(t==='connection_message_batches'?' AND t.conversation_context IS NOT NULL':t==='connection_message_targets'?' AND EXISTS(SELECT 1 FROM connection_message_batches b WHERE b.account_id=t.account_id AND b.id=t.publication_id AND b.conversation_context IS NOT NULL)':'');
    tables[t]=(await tx.unsafe<{row:Row}[]>(`SELECT jsonb_build_object(${projection}) AS row FROM "${t}" t WHERE ${where} ORDER BY ${keys[t].map(k=>`t."${k}"`).join(',')}`,[owner.accountId])).map(r=>r.row);
  }
  tables.public_plc_resolution_evidence=[];
  const digests=[...new Set(tables.conversation_descriptors.flatMap(r=>r.signing_evidence?.verification?.profile==='strict-public-v1'?[r.signing_evidence.verification.digest as string]:[]))].sort();
  for(const digest of digests){
    const r=(await tx<{row:Row}[]>`SELECT jsonb_build_object('evidence_digest',evidence_digest,'did',did,'operation_cid',operation_cid,'verified_at',verified_at,'bundle_bytes',bundle_bytes) AS row
      FROM public_plc_resolution_contents WHERE evidence_digest=${decodeBase64Url(digest)}`)[0];
    if(!r)return fail();tables.public_plc_resolution_evidence.push(r.row);
  }
  return validateConversationHistory({type:'hail.conversation-history',version:1,...owner,capturedAt,tables},owner,capturedAt);
}
export async function reconstructConversations(sql:SQL,h:ConversationHistory){
  // The authenticated current source owns mutable recipient policy. A returning
  // provider's cached choices must neither override opt-outs nor restore grants.
  await sql`DELETE FROM account_conversation_preferences WHERE account_id=${h.accountId}`;
  await sql`DELETE FROM connection_conversation_preferences WHERE account_id=${h.accountId}`;
  const identities=JSON.stringify(h.tables.conversation_memberships.map(r=>({creator:r.creator_did,id:r.conversation_id})));
  await sql`UPDATE conversation_memberships m SET state='left',left_at=COALESCE(left_at,clock_timestamp()) WHERE account_id=${h.accountId}
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${identities}::text::jsonb) v WHERE v->>'creator'=m.creator_did AND v->>'id'=m.conversation_id::text)`;
  for(const t of Object.keys(CONVERSATION_COLUMNS) as Table[]){
    // Table ordering above places descriptors before memberships and immutable intents before targets.
    for(const row of h.tables[t]){
      const value=t==='connection_message_batches'?{...row,sealed:false}:t==='public_plc_resolution_evidence'?{...row,record_version:1,read_evidence_policy_version:PLC_READ_EVIDENCE_POLICY_VERSION}:row;
      const prior=(await sql.unsafe<{row:Row}[]>(`SELECT to_jsonb(t) AS row FROM "${t==='public_plc_resolution_evidence'?'public_plc_resolution_contents':t}" t WHERE ${keys[t].map((k,i)=>`to_jsonb(t)->'${k}'=(($${i+1}::text)::jsonb)`).join(' AND ')}`,keys[t].map(k=>JSON.stringify(row[k]))))[0]?.row;
      if(prior){
        if(t==='conversation_memberships'){
          if(new Date(prior.admitted_at).getTime()!==new Date(row.admitted_at).getTime())throw Error('Conversation admission history conflicts');
          await sql`UPDATE conversation_memberships SET state=${row.state},expires_at=${row.expires_at},last_activity_at=${row.last_activity_at},left_at=${row.left_at}
            WHERE account_id=${h.accountId} AND creator_did=${row.creator_did} AND conversation_id=${row.conversation_id}`;
          continue;
        }
        const normalize=(k:string,v:any)=>k.endsWith('_at')&&v!==null?new Date(v).toISOString():v;
        if(Object.keys(row).some(k=>!isDeepStrictEqual(normalize(k,row[k]),normalize(k,prior[k]))))throw Error('Portable conversation state conflicts with retained '+t);
        continue;
      }
      await sql.unsafe(`INSERT INTO "${t}" SELECT * FROM jsonb_populate_record(NULL::"${t}",($1::text)::jsonb)`,[JSON.stringify(value)]);
    }
  }
  for(const r of h.tables.connection_message_batches)await sql`UPDATE connection_message_batches SET sealed=true WHERE account_id=${h.accountId} AND id=${r.id}`;
}
