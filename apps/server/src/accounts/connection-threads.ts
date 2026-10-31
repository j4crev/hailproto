import type {SQL} from 'bun';
import type {AccountApiSession} from './repository.js';
import type {AccountMessaging} from './messaging.js';
import {UserGrantError} from '../grants/service.js';
import {bodyDocument} from './messaging.js';
import {threadBodyPreview} from './message-threads.js';

export type ConnectionNode={sender:string;messageId:string;recipient:string;sent:boolean;visible:boolean;isRead:boolean;at:string;parentSender:string|null;parentId:string|null;batch:string|null};
export const connectionKey=(m:{sender:string;messageId:string})=>m.sender+'/'+m.messageId;
// Union only authenticated envelope links and this account's own batch targets.
// Metadata-only, linear-space grouping happens before pagination/body loading.
export function groupConnectionMessages(nodes:ConnectionNode[]) {
  const parents=new Map<string,string>();
  const find=(key:string):string=>{
    if(!parents.has(key))parents.set(key,key);
    let root=key;
    while(parents.get(root)!==root)root=parents.get(root)!;
    while(key!==root){const next=parents.get(key)!;parents.set(key,root);key=next;}
    return root;
  };
  const join=(a:string,b:string)=>{const x=find(a),y=find(b);if(x!==y)parents.set(x<y?y:x,x<y?x:y);};
  const known=new Set(nodes.map(connectionKey));
  for(const node of nodes){
    const key=connectionKey(node);find(key);
    // Missing parents cannot connect unrelated peers by an unverified reference.
    const parent=node.parentSender&&node.parentId?node.parentSender+'/'+node.parentId:null;
    if(parent&&known.has(parent))join(key,parent);
    if(node.sent&&node.batch)join(key,'batch/'+node.batch);
  }
  const grouped=new Map<string,ConnectionNode[]>();
  for(const node of nodes){const key=find(connectionKey(node));const group=grouped.get(key)??[];group.push(node);grouped.set(key,group);}
  return [...grouped].map(([id,all])=>{
    const visible=all.filter(m=>m.visible).sort((a,b)=>b.at.localeCompare(a.at)||connectionKey(b).localeCompare(connectionKey(a)));
    const received=visible.filter(m=>!m.sent),unread=received.filter(m=>!m.isRead);
    const representative=received.length?(unread.at(-1)??visible[0]):undefined;
    // A multi-recipient send is one visible original, with all recipient labels.
    const seen=new Set<string>();
    const messages=visible.filter(m=>{const key=m.sent&&m.batch?'batch/'+m.batch:connectionKey(m);if(seen.has(key))return false;seen.add(key);return true;});
    return {id,all,messages,received,unread:unread.length,representative,activity:visible[0]?.at??''};
  });
}

async function graph(sql:SQL,session:AccountApiSession) {
  const rows=await sql<{sender:string;message_id:string;recipient:string;sent:boolean;visible:boolean;is_read:boolean;at:Date;parent_sender:string|null;parent_id:string|null;batch:string|null}[]>`
    SELECT e.sender_did AS sender,e.message_id,e.recipient_did AS recipient,true AS sent,true AS visible,true AS is_read,e.created_at AS at,
      e.parent_sender,e.parent_message_id AS parent_id,t.publication_id::text AS batch
    FROM sent_envelopes e LEFT JOIN connection_message_targets t ON t.account_id=e.sender_account_id AND t.message_id=e.message_id
    WHERE e.sender_account_id=${session.account_id} AND e.sender_did=${session.did} AND e.authorization_type='connection'
    UNION ALL
    SELECT e.sender_did,e.message_id,e.recipient_did,false,d.message_id IS NOT NULL AND d.trashed_at IS NULL,COALESCE(d.is_read,true),
      COALESCE(d.delivered_at,e.created_at),e.parent_sender,e.parent_message_id,NULL
    FROM received_envelopes e LEFT JOIN delivered_messages d ON d.recipient_did=e.recipient_did AND d.sender_did=e.sender_did AND d.message_id=e.message_id
    WHERE e.local_account_id=${session.account_id} AND e.recipient_did=${session.did} AND e.authorization_type='connection' AND e.outcome='accepted'`;
  return groupConnectionMessages(rows.map(r=>({sender:r.sender,messageId:r.message_id,recipient:r.recipient,sent:r.sent,visible:r.visible,isRead:r.is_read,
    at:r.at.toISOString(),parentSender:r.parent_sender,parentId:r.parent_id,batch:r.batch})));
}

export async function connectionInbox(sql:SQL,session:AccountApiSession,messaging:AccountMessaging,after:string|null) {
  let cursor:{activity:string;id:string}|null=null;
  if(after){try{cursor=JSON.parse(Buffer.from(after,'base64url').toString());if(!cursor||typeof cursor.id!=='string'||typeof cursor.activity!=='string'||!Number.isFinite(Date.parse(cursor.activity)))throw Error();}catch{throw new UserGrantError(400,'Invalid conversation cursor');}}
  const groups=(await graph(sql,session)).filter(g=>g.representative).sort((a,b)=>b.activity.localeCompare(a.activity)||b.id.localeCompare(a.id))
    .filter(g=>!cursor||g.activity<cursor.activity||g.activity===cursor.activity&&g.id<cursor.id);
  const page=groups.slice(0,5);
  return {messages:await Promise.all(page.map(async g=>({...await (g.representative!.sent?messaging.sentMessage(session,g.representative!.messageId):messaging.read(session,g.representative!.sender,g.representative!.messageId)),
    sender:g.representative!.sender,messageId:g.representative!.messageId,deliveredAt:g.representative!.at,isRead:g.representative!.isRead,
    conversation:{unreadCount:g.unread,lastActivity:g.activity,messages:g.received.map(m=>({sender:m.sender,messageId:m.messageId,isRead:m.isRead}))}}))),
    next:groups.length>5?Buffer.from(JSON.stringify({activity:page[4]!.activity,id:page[4]!.id})).toString('base64url'):null};
}

export async function connectionThread(sql:SQL,session:AccountApiSession,root:{sender:string;messageId:string},offset:string|null) {
  const groups=await graph(sql,session),group=groups.find(g=>g.all.some(m=>m.visible&&connectionKey(m)===connectionKey(root)));
  if(!group)return null;
  const original=group.all.find(m=>connectionKey(m)===connectionKey(root))!;
  const selected=group.messages.find(m=>connectionKey(m)===connectionKey(root)||original.sent&&original.batch&&m.batch===original.batch)!;
  const initial=Math.max(0,group.messages.indexOf(selected)-2);
  if(offset!==null&&!/^\d{1,9}$/.test(offset))throw new UserGrantError(400,'Invalid conversation offset');
  const start=offset===null?initial:Number(offset),page=group.messages.slice(start,start+30);
  const refs=JSON.stringify(page.map(m=>({sender:m.sender,messageId:m.messageId})));
  const bodies=await sql<{sender:string;message_id:string;body_bytes:Uint8Array}[]>`
    WITH refs AS (SELECT value->>'sender' AS sender,(value->>'messageId')::uuid AS id FROM jsonb_array_elements(${refs}::text::jsonb))
    SELECT e.sender_did AS sender,e.message_id,b.body_bytes FROM sent_envelopes e JOIN refs r ON r.sender=e.sender_did AND r.id=e.message_id
    JOIN detached_bodies b ON b.sender_account_id=e.sender_account_id AND b.digest=e.body_digest WHERE e.sender_account_id=${session.account_id}
    UNION ALL
    SELECT e.sender_did,e.message_id,b.body_bytes FROM received_envelopes e JOIN refs r ON r.sender=e.sender_did AND r.id=e.message_id
    JOIN delivered_messages d USING(sender_did,message_id)
    JOIN verified_body_contents b ON b.recipient_did=d.recipient_did AND b.sender_did=d.sender_did AND b.digest=d.body_digest AND b.media_type=d.media_type AND b.profile=d.profile
    WHERE e.local_account_id=${session.account_id} AND d.recipient_did=${session.did} AND d.trashed_at IS NULL`;
  const addresses=await sql<{did:string;address:string}[]>`SELECT peer_did AS did,peer_address AS address FROM federated_connection_pairs WHERE account_id=${session.account_id}`;
  const address=new Map(addresses.map(a=>[a.did,a.address]));
  const content=new Map(bodies.map(b=>[b.sender+'/'+b.message_id,bodyDocument(b.body_bytes) as {blocks?:{style?:string;children?:{text?:string}[]}[]}]));
  return {selected:{sender:selected.sender,messageId:selected.messageId,sent:selected.sent},total:group.messages.length,start,
    newerUnread:group.messages.slice(0,start).filter(m=>!m.sent&&!m.isRead).length,
    messages:page.map(m=>{const body=content.get(connectionKey(m))??{};
      return {sender:m.sender,messageId:m.messageId,sent:m.sent,isRead:m.isRead,createdAt:m.at,senderAddress:address.get(m.sender)??null,
        title:body.blocks?.[0]?.style==='h1'?body.blocks[0].children?.map(s=>s.text??'').join('')??'':'',preview:threadBodyPreview(body),
        recipients:m.sent?group.all.filter(n=>n.sent&&(m.batch?n.batch===m.batch:connectionKey(n)===connectionKey(m))).map(n=>({did:n.recipient,address:address.get(n.recipient)??null})):[]};})};
}
