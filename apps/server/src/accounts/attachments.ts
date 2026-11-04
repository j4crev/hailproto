import {createHash} from 'node:crypto';
import {decodeBase64Url,encodeBase64Url,encodePayload,type HailAttachment} from '@racrproto/codec';
import type {SQL} from 'bun';
import {ATTACHMENT_MAX_BYTES,attachmentDiagnostic,bodyAttachments,storeAttachment,validateAttachmentBytes} from '../bodies/attachments.js';
import {UserGrantError} from '../grants/service.js';
import type {AccountApiSession} from './repository.js';

export class AccountAttachments {
  constructor(private readonly sql:SQL){}
  async upload(session:AccountApiSession,input:Record<string,unknown>){
    if(Object.keys(input).sort().join(',')!=='data,filename'||typeof input.data!=='string'||typeof input.filename!=='string'||input.data.length>Math.ceil(ATTACHMENT_MAX_BYTES*4/3))throw new UserGrantError(400,'Invalid attachment');
    let bytes:Uint8Array,file:HailAttachment;
    try{
      bytes=decodeBase64Url(input.data);
      if(encodeBase64Url(bytes)!==input.data)throw new Error();
      file={filename:input.filename,media_type:/\.pdf$/i.test(input.filename)?'application/pdf':/\.png$/i.test(input.filename)?'image/png':/\.jpe?g$/i.test(input.filename)?'image/jpeg':/\.webp$/i.test(input.filename)?'image/webp':'text/plain',size:bytes.length,digest:{algorithm:'sha-256',value:createHash('sha256').update(bytes).digest()}};
      encodePayload('hail.body.spt-1',{version:1,profile:'spt-1',blocks:[],attachments:[file]});
      validateAttachmentBytes(file,bytes);
    }catch{throw new UserGrantError(400,'Use PNG, JPEG, WebP, PDF, or UTF-8 TXT/LOG files, up to 25 MiB total');}
    await this.sql.begin(async tx=>{
      await tx`SELECT id FROM provider_accounts WHERE id=${session.account_id} FOR UPDATE`;
      await tx`SELECT hail_assert_unfenced_account(${session.account_id}::uuid)`;
      const [usage]=await tx<{size:number}[]>`SELECT COALESCE(sum(octet_length(b.bytes)),0)::float8 AS size FROM attachment_uploads u JOIN attachment_blobs b USING(digest)
        WHERE u.account_id=${session.account_id} AND u.digest<>${file.digest.value}`;
      if((usage?.size??0)+bytes.length>250*1024*1024)throw new UserGrantError(409,'Attachment upload allowance exceeded');
      await storeAttachment(tx as SQL,file.digest.value,bytes);
      await tx`INSERT INTO attachment_uploads(account_id,digest) VALUES(${session.account_id},${file.digest.value}) ON CONFLICT(account_id,digest) DO UPDATE SET created_at=clock_timestamp()`;
    });
    return attachmentDiagnostic(file);
  }
  async download(body:Uint8Array,digest:string,index?:number){
    const files=bodyAttachments(body);
    const file=index===undefined?files.find(f=>encodeBase64Url(f.digest.value)===digest):files[index];
    if(file&&encodeBase64Url(file.digest.value)!==digest)return null;
    if(!file)return null;
    const rows=await this.sql<{bytes:Uint8Array}[]>`SELECT bytes FROM attachment_blobs WHERE digest=${file.digest.value}`;
    if(!rows[0])return null;
    validateAttachmentBytes(file,rows[0].bytes);
    return {file,bytes:rows[0].bytes};
  }
}
