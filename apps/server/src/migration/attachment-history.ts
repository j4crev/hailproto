import type {SQL} from 'bun';
import {createHash} from 'node:crypto';
import {bodyAttachments,storeAttachment,validateAttachmentBytes} from '../bodies/attachments.js';

export const ATTACHMENT_TABLES=['attachment_blobs','attachment_uploads','body_attachment_refs','received_attachment_refs'] as const;
export async function collectAttachmentHistory(tx:SQL,account:string,did:string){
  const collect=async(p:Promise<{row:Record<string,unknown>}[]>)=>(await p).map(x=>x.row);
  const attachment_uploads=await collect(tx`SELECT to_jsonb(t) AS row FROM attachment_uploads t WHERE account_id=${account} ORDER BY digest`);
  const body_attachment_refs=await collect(tx`SELECT to_jsonb(t) AS row FROM body_attachment_refs t WHERE sender_account_id=${account} ORDER BY body_digest,digest`);
  const received_attachment_refs=await collect(tx`SELECT to_jsonb(t) AS row FROM received_attachment_refs t WHERE recipient_did=${did} ORDER BY sender_did,body_digest,digest`);
  const attachment_blobs=await collect(tx`SELECT to_jsonb(b) AS row FROM attachment_blobs b WHERE digest IN(
    SELECT digest FROM attachment_uploads WHERE account_id=${account} UNION SELECT digest FROM body_attachment_refs WHERE sender_account_id=${account}
    UNION SELECT digest FROM received_attachment_refs WHERE recipient_did=${did}) ORDER BY digest`);
  return {attachment_blobs,attachment_uploads,body_attachment_refs,received_attachment_refs};
}
const unhex=(value:unknown)=>{
  if(typeof value!=='string'||!value.startsWith('\\x')||value.length%2!==0||/[^0-9a-f]/.test(value.slice(2)))throw new Error('Invalid attachment history bytes');
  return Buffer.from(value.slice(2),'hex');
};
export function validateAttachmentHistory(manifest:{accountId:string;did:string;tables:Record<string,Record<string,unknown>[]>}){
  const t=manifest.tables,blobs=new Map<string,Uint8Array>();
  for(const row of t.attachment_blobs!){
    if(Object.keys(row).sort().join(',')!=='bytes,digest')throw new Error('Invalid attachment blob fields');
    const bytes=unhex(row.bytes),digest=unhex(row.digest);
    if(bytes.length<1||bytes.length>25*1024*1024||!createHash('sha256').update(bytes).digest().equals(digest)||blobs.has(String(row.digest)))throw new Error('Invalid attachment history blob');
    blobs.set(String(row.digest),bytes);
  }
  const used=new Set<string>();
  for(const row of t.attachment_uploads!){
    if(Object.keys(row).sort().join(',')!=='account_id,created_at,digest'||row.account_id!==manifest.accountId||!blobs.has(String(row.digest)))throw new Error('Invalid attachment upload owner');
    used.add(String(row.digest));
  }
  for(const [table,bodies,owner] of [['body_attachment_refs','detached_bodies','sender_account_id'],['received_attachment_refs','verified_body_provenance','recipient_did']] as const){
    for(const row of t[table]!){
      const fields=owner==='recipient_did'?'body_digest,digest,media_type,profile,recipient_did,sender_did':'body_digest,digest,sender_account_id';
      if(Object.keys(row).sort().join(',')!==fields)throw new Error('Invalid attachment reference fields');
      if(row[owner]!== (owner==='recipient_did'?manifest.did:manifest.accountId)||!blobs.has(String(row.digest)))throw new Error('Invalid attachment owner');
      const body=t[bodies]!.find(b=>b.digest===row.body_digest&&(owner!=='recipient_did'||b.sender_did===row.sender_did&&b.media_type===row.media_type&&b.profile===row.profile));
      const file=body&&bodyAttachments(unhex(body.body_bytes)).find(f=>Buffer.from(f.digest.value).equals(unhex(row.digest)));
      if(!file)throw new Error('Attachment reference is not authenticated by body');
      validateAttachmentBytes(file,blobs.get(String(row.digest))!);used.add(String(row.digest));
    }
    for(const body of t[bodies]!){
      for(const file of bodyAttachments(unhex(body.body_bytes))){
        if(!t[table]!.some(r=>r.body_digest===body.digest&&Buffer.from(file.digest.value).equals(unhex(r.digest))&&(owner!=='recipient_did'||r.sender_did===body.sender_did&&r.media_type===body.media_type&&r.profile===body.profile)))throw new Error('Missing required attachment history');
      }
    }
  }
  if(used.size!==blobs.size)throw new Error('Unowned attachment history');
}
export async function importAttachmentBlobs(tx:SQL,tables:Record<string,Record<string,unknown>[]>){
  for(const row of tables.attachment_blobs!)await storeAttachment(tx,unhex(row.digest),unhex(row.bytes));
}
