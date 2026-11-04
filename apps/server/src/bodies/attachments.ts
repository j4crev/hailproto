import {validateJpegStructure,validateWebpStructure} from './image-attachments.js';
import {createHash} from 'node:crypto';
import {HailCodecError,validatePngStructure,decodePayload,encodeBase64Url,type HailAttachment} from '@racrproto/codec';
import type {SQL} from 'bun';
import {validateBodyBytes} from './service.js';

export const ATTACHMENT_MAX_BYTES=25*1024*1024;
export function bodyAttachments(bytes:Uint8Array):HailAttachment[]{
  const profile=validateBodyBytes(bytes);
  return decodePayload(`hail.body.${profile}`,bytes).attachments??[];
}
export function validateAttachmentBytes(file:HailAttachment,bytes:Uint8Array){
  if(bytes.length!==file.size||!Buffer.from(createHash('sha256').update(bytes).digest()).equals(Buffer.from(file.digest.value)))throw new Error('Attachment integrity failure');
  if(file.media_type==='application/pdf'){
    if(Buffer.from(bytes.subarray(0,5)).toString('ascii')!=='%PDF-')throw new Error('Invalid PDF');
  }else if(file.media_type==='image/png'){
    const {width,height}=validatePngStructure(bytes);
    if(width>0x7fffffff||height>0x7fffffff)throw new Error('Invalid PNG dimensions');
  }else if(file.media_type==='image/jpeg'){
    validateJpegStructure(bytes);
  }else if(file.media_type==='image/webp'){
    validateWebpStructure(bytes);
  }else{
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    if(text.includes('\0'))throw new Error('Text attachments must be UTF-8 without NUL');
  }
}
export async function storeAttachment(tx:SQL,digest:Uint8Array,bytes:Uint8Array){
  const rows=await tx`INSERT INTO attachment_blobs(digest,bytes) VALUES(${digest},${bytes})
    ON CONFLICT(digest) DO UPDATE SET digest=EXCLUDED.digest WHERE attachment_blobs.bytes=EXCLUDED.bytes RETURNING digest`;
  if(!rows.length)throw new Error('Attachment digest collision');
}
export async function retainBodyAttachments(tx:SQL,account:string,bodyDigest:Uint8Array,bytes:Uint8Array){
  for(const file of bodyAttachments(bytes)){
    const rows=await tx<{bytes:Uint8Array}[]>`SELECT b.bytes FROM attachment_blobs b WHERE b.digest=${file.digest.value} AND (EXISTS(SELECT 1 FROM attachment_uploads u WHERE u.account_id=${account} AND u.digest=b.digest)
      OR EXISTS(SELECT 1 FROM body_attachment_refs r WHERE r.sender_account_id=${account} AND r.body_digest=${bodyDigest} AND r.digest=b.digest)) FOR SHARE OF b`;
    if(!rows[0])throw new HailCodecError('schema-violation','Attachment not uploaded by this account');
    validateAttachmentBytes(file,rows[0].bytes);
    await tx`INSERT INTO body_attachment_refs(sender_account_id,body_digest,digest) VALUES(${account},${bodyDigest},${file.digest.value}) ON CONFLICT DO NOTHING`;
  }
}
export function attachmentDiagnostic(file:HailAttachment){return {...file,digest:{algorithm:'sha-256',value:encodeBase64Url(file.digest.value)}};}

export async function publishAttachmentBody(tx:SQL,account:string,bytes:Uint8Array){
  if(!bodyAttachments(bytes).length)return;
  const digest=createHash('sha256').update(bytes).digest();
  await tx`INSERT INTO detached_bodies(digest,sender_account_id,body_bytes) VALUES(${digest},${account},${bytes}) ON CONFLICT DO NOTHING`;
  await retainBodyAttachments(tx,account,digest,bytes);
}
