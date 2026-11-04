import {MessageTrash} from '../src/accounts/message-trash.js';
import {randomUUID,createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {encodePayload,fromDiagnosticJson,encodeBase64Url} from '@racrproto/codec';
import {ProviderDatabase} from '../src/db/database.js';
import {AccountAttachments} from '../src/accounts/attachments.js';
import type {AccountApiSession} from '../src/accounts/repository.js';
import {BodyRepository} from '../src/bodies/repository.js';
import {bodyDigest} from '../src/bodies/service.js';
import {receivedContentUsage} from '../src/bodies/usage.js';
import {collectAttachmentHistory,validateAttachmentHistory,importAttachmentBlobs} from '../src/migration/attachment-history.js';

it.skipIf(!process.env.DATABASE_URL)('retains exactly 25 MiB once, isolates upload ownership, authenticates downloads, and preserves recipient references',async()=>{
  const db=new ProviderDatabase(process.env.DATABASE_URL!);
  try{
    await db.migrate();
    const owner=randomUUID(),other=randomUUID(),did=`did:plc:${'a'.repeat(24)}`,peer=`did:plc:${'b'.repeat(24)}`;
    for(const [id,d,address] of [[owner,did,'a@example.com'],[other,peer,'b@example.com']])await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${id!},${randomUUID()},${address!},${d!},'active',now(),${new Uint8Array(32)},'public')`;
    const session={account_id:owner,did} as AccountApiSession,files=new AccountAttachments(db.sql),bodies=new BodyRepository(db.sql);
    const data=Buffer.alloc(25*1024*1024,97);
    const file=await files.upload(session,{filename:'large.log',data:data.toString('base64url')});
    const document=fromDiagnosticJson('hail.body.spt-2',{version:1,profile:'spt-2',blocks:[],attachments:[file]});
    const bytes=encodePayload('hail.body.spt-2',document),digest=bodyDigest(bytes);
    await expect(bodies.publish(peer,bytes)).rejects.toThrow('not uploaded');
    expect((await db.sql`SELECT 1 FROM detached_bodies WHERE sender_account_id=${other}`)).toHaveLength(0);
    await bodies.publish(did,bytes);await bodies.publish(did,bytes);
    expect((await db.sql`SELECT 1 FROM attachment_blobs`)).toHaveLength(1);
    const now=Math.floor(Date.now()/1000),token=new Uint8Array(32).fill(6);
    await bodies.authorize({senderDid:did,recipientDid:peer,messageId:'01900000-0000-7000-8000-000000000001',digest,token,availableUntil:now+31*86400,expiresAt:now+32*86400});
    const hash=createHash('sha256').update(token).digest();
    expect(await bodies.retrieveAttachment(digest,document.attachments![0]!.digest.value,new Uint8Array(32),now)).toBeNull();
    const result=await bodies.retrieveAttachment(digest,document.attachments![0]!.digest.value,hash,now);
    expect(result&&typeof result!=='string'&&Buffer.from(result.bytes).equals(data)).toBe(true);
    expect(await bodies.retrieveAttachment(digest,new Uint8Array(32),hash,now)).toBeNull();
    await db.sql`INSERT INTO verified_body_provenance(recipient_did,sender_did,digest,media_type,profile,body_bytes)
      VALUES(${peer},${did},${digest},'application/hail-body+cbor','spt-2',${bytes})`;
    await db.sql`INSERT INTO received_attachment_refs(recipient_did,sender_did,body_digest,media_type,profile,digest)
      VALUES(${peer},${did},${digest},'application/hail-body+cbor','spt-2',${document.attachments![0]!.digest.value})`;
    expect((await receivedContentUsage(db.sql,peer)).bytes).toBe(data.length+bytes.length);
    const history=await collectAttachmentHistory(db.sql,owner,did);
    const detached=(await db.sql`SELECT to_jsonb(t) AS row FROM detached_bodies t WHERE sender_account_id=${owner}`).map((r:{row:Record<string,unknown>})=>r.row);
    const manifest={accountId:owner,did,tables:{...history,detached_bodies:detached,verified_body_provenance:[]}};
    validateAttachmentHistory(manifest);await importAttachmentBlobs(db.sql,manifest.tables);
    expect(()=>validateAttachmentHistory({...manifest,tables:{...manifest.tables,body_attachment_refs:[]}})).toThrow('Missing');
    const draftId=randomUUID(),content={audience:'category',category:'',connections:[],title:'',text:'',alt:'',caption:'',allowReply:false,header:null,forward:null,attachments:[file]};
    await db.sql`INSERT INTO account_message_drafts(account_id,id,content) VALUES(${owner},${draftId},${JSON.stringify(content)}::text::jsonb)`;
    await db.sql`UPDATE attachment_uploads SET created_at=clock_timestamp()-interval '2 days' WHERE account_id=${owner}`;
    const trash=new MessageTrash(db.sql);await trash.purgeExpired();
    expect(await db.sql`SELECT 1 FROM attachment_uploads WHERE account_id=${owner}`).toHaveLength(1);
    await db.sql`DELETE FROM account_message_drafts WHERE account_id=${owner}`;
    await trash.purgeExpired();
    expect(await db.sql`SELECT 1 FROM attachment_uploads WHERE account_id=${owner}`).toHaveLength(0);
    expect(await db.sql`SELECT 1 FROM attachment_blobs`).toHaveLength(1);

    await db.sql`DELETE FROM body_authorizations WHERE sender_account_id=${owner}`;
    await db.sql`DELETE FROM detached_bodies WHERE sender_account_id=${owner}`;
    await expect(db.sql`DELETE FROM attachment_blobs`).rejects.toThrow();
    await db.sql`DELETE FROM verified_body_provenance WHERE recipient_did=${peer}`;
    await trash.purgeExpired();
    expect(await db.sql`SELECT 1 FROM attachment_blobs`).toHaveLength(0);
    expect((await receivedContentUsage(db.sql,peer)).bytes).toBe(0);
  }finally{await db.close();}
},60_000);

it.skipIf(!process.env.DATABASE_URL)('deduplicates concurrent cross-account uploads and distinct filenames without sharing authority',async()=>{
  const db=new ProviderDatabase(process.env.DATABASE_URL!);
  try{
    await db.migrate();
    const accounts=[{account_id:randomUUID(),did:`did:plc:${'c'.repeat(24)}`},{account_id:randomUUID(),did:`did:plc:${'d'.repeat(24)}`}];
    for(const [i,account] of accounts.entries())await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${account.account_id},${randomUUID()},${`dedup-${i}@example.com`},${account.did},'active',now(),${new Uint8Array(32)},'public')`;
    const files=new AccountAttachments(db.sql),bodies=new BodyRepository(db.sql),data=Buffer.from('identical content across accounts\n'),digest=bodyDigest(data);
    const metadata=await Promise.all(accounts.map((account,i)=>files.upload(account as AccountApiSession,{filename:`account-${i}.log`,data:data.toString('base64url')})));
    expect(metadata[0]!.digest).toEqual(metadata[1]!.digest);
    expect(metadata[0]!.filename).not.toBe(metadata[1]!.filename);
    const bodyBytes=metadata.map(file=>encodePayload('hail.body.spt-2',fromDiagnosticJson('hail.body.spt-2',{version:1,profile:'spt-2',blocks:[],attachments:[file]})));
    await Promise.all(accounts.map((account,i)=>bodies.publish(account.did,bodyBytes[i]!)));
    expect(await db.sql`SELECT 1 FROM attachment_blobs WHERE digest=${digest}`).toHaveLength(1);
    expect(await db.sql`SELECT 1 FROM attachment_uploads WHERE digest=${digest}`).toHaveLength(2);
    expect(await db.sql`SELECT 1 FROM body_attachment_refs WHERE digest=${digest}`).toHaveLength(2);
    // Metadata changes create distinct bodies, but never another file blob.
    expect(Buffer.from(bodyDigest(bodyBytes[0]!)).equals(Buffer.from(bodyDigest(bodyBytes[1]!)))).toBe(false);
    const first=accounts[0]!,second=accounts[1]!;
    await db.sql`DELETE FROM attachment_uploads WHERE account_id=${first.account_id}`;
    await db.sql`DELETE FROM detached_bodies WHERE sender_account_id=${first.account_id}`;
    await new MessageTrash(db.sql).purgeExpired();
    expect(await db.sql`SELECT 1 FROM attachment_blobs WHERE digest=${digest}`).toHaveLength(1);
    // Another owner's retained blob is not sufficient authority to publish it.
    await expect(bodies.publish(first.did,bodyBytes[0]!)).rejects.toThrow('not uploaded');
    await bodies.publish(second.did,bodyBytes[1]!);
    // Stored content cannot be overwritten with different bytes under a claimed digest.
    await expect(db.sql`UPDATE attachment_blobs SET bytes=${Buffer.from('different')} WHERE digest=${digest}`).rejects.toThrow();
    expect(Buffer.from((await db.sql`SELECT bytes FROM attachment_blobs WHERE digest=${digest}`)[0]!.bytes)).toEqual(data);
    await db.sql`DELETE FROM attachment_uploads WHERE account_id=${second.account_id}`;
    await db.sql`DELETE FROM detached_bodies WHERE sender_account_id=${second.account_id}`;
    await new MessageTrash(db.sql).purgeExpired();
    expect(await db.sql`SELECT 1 FROM attachment_blobs WHERE digest=${digest}`).toHaveLength(0);
  }finally{await db.close();}
},30_000);

it.skipIf(!process.env.DATABASE_URL)('uploads and publishes PNG attachments with verified bytes and image/png downloads',async()=>{
  const db=new ProviderDatabase(process.env.DATABASE_URL!);
  try{
    await db.migrate();
    const account_id=randomUUID(),did=`did:plc:${'e'.repeat(24)}`;
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${account_id},${randomUUID()},'png@example.com',${did},'active',now(),${new Uint8Array(32)},'public')`;
    const session={account_id,did} as AccountApiSession,files=new AccountAttachments(db.sql);
    const vector=await Bun.file(new URL('../../../spec/vectors/attachment-png.json',import.meta.url)).json();
    const png=Buffer.from(vector.fileHex,'hex');
    const metadata=await files.upload(session,{filename:'pixel.PNG',data:png.toString('base64url')});
    expect(metadata.media_type).toBe('image/png');
    const bytes=encodePayload('hail.body.spt-2',fromDiagnosticJson('hail.body.spt-2',{version:1,profile:'spt-2',blocks:[],attachments:[metadata]}));
    await new BodyRepository(db.sql).publish(did,bytes);
    const download=await files.download(bytes,metadata.digest.value);
    expect(download?.file.media_type).toBe('image/png');expect(Buffer.from(download!.bytes)).toEqual(png);
    await expect(files.upload(session,{filename:'fake.png',data:Buffer.from('not an image').toString('base64url')})).rejects.toThrow();
    expect(await db.sql`SELECT 1 FROM attachment_blobs WHERE digest=${bodyDigest(png)}`).toHaveLength(1);
  }finally{await db.close();}
},30_000);

it.skipIf(!process.env.DATABASE_URL)('uploads, publishes and downloads JPEG and WebP with original bytes',async()=>{
  const db=new ProviderDatabase(process.env.DATABASE_URL!);
  try{
    await db.migrate();
    const account_id=randomUUID(),did=`did:plc:${'f'.repeat(24)}`;
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${account_id},${randomUUID()},'images@example.com',${did},'active',now(),${new Uint8Array(32)},'public')`;
    const session={account_id,did} as AccountApiSession,files=new AccountAttachments(db.sql),bodies=new BodyRepository(db.sql);
    const vectors=await Bun.file(new URL('../../../spec/vectors/attachment-images.json',import.meta.url)).json();
    for(const vector of vectors.records){
      const data=Buffer.from(vector.fileHex,'hex'),file=vector.body.attachments[0];
      const metadata=await files.upload(session,{filename:file.filename,data:data.toString('base64url')});
      expect(metadata.media_type).toBe(file.media_type);
      const bytes=encodePayload('hail.body.spt-2',fromDiagnosticJson('hail.body.spt-2',{version:1,profile:'spt-2',blocks:[],attachments:[metadata]}));
      await bodies.publish(did,bytes);
      const download=await files.download(bytes,metadata.digest.value);
      expect(download?.file.media_type).toBe(file.media_type);expect(Buffer.from(download!.bytes)).toEqual(data);
      expect(await db.sql`SELECT 1 FROM attachment_blobs WHERE digest=${bodyDigest(data)}`).toHaveLength(1);
    }
    for(const ext of ['jpg','jpeg','webp'])await expect(files.upload(session,{filename:`fake.${ext}`,data:Buffer.from('not an image').toString('base64url')})).rejects.toThrow();
  }finally{await db.close();}
},30_000);
