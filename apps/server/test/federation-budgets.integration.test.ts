import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createWebCryptoSigner, signPayload, inspectSignedPayload } from '@racrproto/codec';
import type { HailEnvelope } from '@racrproto/codec';
import { ProviderDatabase } from '../src/db/database.js';
import { EnvelopeRepository, type EnvelopeDecision } from '../src/envelopes/repository.js';
import { ENVELOPE_ADMISSION } from '../src/envelopes/admission.js';
import { DeliveryRepository } from '../src/delivery/repository.js';
import { uuidV7 } from '../src/identity/uuid-v7.js';

const integration = process.env.DATABASE_URL ? describe : describe.skip;
const did = () => 'did:plc:' + Array.from(randomBytes(24), x=>'abcdefghijklmnopqrstuvwxyz234567'[x%32]).join('');
integration('federation budgets and fair queue', () => {
  let db: ProviderDatabase, repository: EnvelopeRepository, key: CryptoKey;
  beforeAll(async()=>{
    db=new ProviderDatabase(process.env.DATABASE_URL!);await db.migrate();repository=new EnvelopeRepository(db.sql);
    key=((await crypto.subtle.generateKey('Ed25519',false,['sign','verify'])) as CryptoKeyPair).privateKey;
  });
  afterAll(async()=>{await db?.close();});
  beforeEach(async()=>{
    await db.sql`DELETE FROM received_envelopes WHERE outcome <> 'accepted'`;
    await db.sql`UPDATE delivery_work SET state='failed',reason='receiver-policy-rejected',lease_token=NULL,lease_expires_at=NULL
      WHERE state IN ('accepted','on-hold')`;
  });
  async function recipient() {
    const id=randomUUID(), to=did();
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,
      activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${id},${randomUUID()},${id+'@example.com'},${to},'active',now(),${randomBytes(32)},'public')`;
    return {id,to};
  }
  async function sender(owner:Awaited<ReturnType<typeof recipient>>, from=did()) {
    const grantId=uuidV7(), digest=randomBytes(32), now=Math.floor(Date.now()/1000);
    await db.sql`INSERT INTO grant_lineages(grant_id,local_account_id,local_role,grantor_did,grantee_did,current_revision,current_digest,current_status)
      VALUES(${grantId},${owner.id},'grantor',${owner.to},${from},1,${digest},'active')`;
    await db.sql`INSERT INTO grant_revisions(grant_id,revision,status,issued_at,updated_at,expires_at,scope_payload,
      consent_address_binding_sha256,consent_sender_profile_sha256,cose,representation_digest,signing_public_key,
      signing_plc_document,signing_plc_data,signing_plc_operation_log)
      VALUES(${grantId},1,'active',${now},${now},NULL,'[{"type":"categories","values":["updates"]}]'::jsonb,
      ${digest},${digest},${new Uint8Array([1])},${digest},'fixture','{}','{}','[]')`;
    return async(category='updates', evidenceBytes=0):Promise<EnvelopeDecision>=>{
      const payload:HailEnvelope={type:'hail.envelope',version:1,message_id:uuidV7(),from,to:owner.to,
        authorization:{type:'grant',grant_id:grantId},category,created_at:now,expires_at:now+3600,
        body:{digest:{algorithm:'sha-256',value:randomBytes(32)},size:100,media_type:'application/hail-body+cbor',profile:'spt-1',
          available_until:now+31*86400,access:{type:'bearer',token:randomBytes(32),expires_at:now+31*86400}},reply:{allowed:false}};
      const representation=await signPayload('hail.envelope',payload,createWebCryptoSigner(from+'#hail-messaging',key));
      const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(inspectSignedPayload('hail.envelope',representation).payloadBytes)));
      return {payload,representation,payloadDigest:digest,envelopeDigest:digest,localAccountId:owner.id,
        signingPublicKey:'fixture',evidence:{document:{padding:'x'.repeat(evidenceBytes)},data:{},log:[]},now};
    };
  }
  it('serializes racing admission and lets an exact retry recover state when full',async()=>{
    const make=await sender(await recipient());
    const inputs=await Promise.all(Array.from({length:ENVELOPE_ADMISSION.pendingSender+5},()=>make()));
    const results=await Promise.all(inputs.map(input=>repository.accept(input)));
    expect(results.filter(x=>x==='accepted')).toHaveLength(ENVELOPE_ADMISSION.pendingSender);
    expect(results.filter(x=>x==='rate-limited')).toHaveLength(5);
    const accepted=inputs[results.indexOf('accepted')]!,refused=inputs[results.indexOf('rate-limited')]!;
    expect(await repository.accept(accepted)).toBe('duplicate');
    expect(await db.sql`SELECT 1 FROM received_envelopes WHERE message_id=${refused.payload.message_id}`).toHaveLength(0);
    await db.sql`UPDATE delivery_work SET state='failed',reason='receiver-policy-rejected'
      WHERE sender_did=${accepted.payload.from} AND message_id=${accepted.payload.message_id}`;
    expect(await repository.accept(refused)).toBe('accepted');
  });
  it('bounds revoked-sender rejection records, including evidence bytes, without blocking valid acceptance',async()=>{
    const owner=await recipient(),make=await sender(owner), first=await make();
    const id=(first.payload.authorization as {grant_id:string}).grant_id;
    await db.sql`UPDATE grant_lineages SET current_status='revoked' WHERE grant_id=${id}`;
    const inputs=await Promise.all(Array.from({length:ENVELOPE_ADMISSION.rejectedSender+4},()=>make()));
    const results=await Promise.all(inputs.map(input=>repository.accept(input)));
    expect(results.filter(x=>x==='unauthorized')).toHaveLength(ENVELOPE_ADMISSION.rejectedSender);
    expect(results.filter(x=>x==='rate-limited')).toHaveLength(4);
    expect(await repository.accept(inputs[results.indexOf('unauthorized')]!)).toBe('duplicate');
    const other=await sender(owner);
    expect(await repository.accept(await other('wrong',ENVELOPE_ADMISSION.rejectedSenderBytes))).toBe('rate-limited');
    expect(await repository.accept(await other())).toBe('accepted');
  });
  it('shares the recipient cap across senders',async()=>{
    const owner=await recipient();
    for(let group=0;group<ENVELOPE_ADMISSION.pendingRecipient/ENVELOPE_ADMISSION.pendingSender;group++){
      const make=await sender(owner);
      for(let i=0;i<ENVELOPE_ADMISSION.pendingSender;i++)expect(await repository.accept(await make())).toBe('accepted');
    }
    const make=await sender(owner);
    expect(await repository.accept(await make())).toBe('rate-limited');
  });
  it('bounds active leases and gives a new recipient a turn ahead of a sender backlog',async()=>{
    const owner=await recipient(),make=await sender(owner),other=await sender(owner),third=await sender(owner);
    const input=await make();expect(await repository.accept(input)).toBe('accepted');
    expect(await repository.accept(await make())).toBe('accepted');
    const queue=new DeliveryRepository(db.sql),first=await queue.claimDue();expect(first?.senderDid).toBe(input.payload.from);
    expect(await queue.claimDue()).toBeNull(); // same sender already running
    expect(await repository.accept(await other())).toBe('accepted');
    expect(await queue.claimDue()).not.toBeNull();
    expect(await repository.accept(await third())).toBe('accepted');
    expect(await queue.claimDue()).toBeNull(); // recipient has two active leases
    const fresh=await sender(await recipient()),freshInput=await fresh();
    expect(await repository.accept(freshInput)).toBe('accepted');
    expect((await queue.claimDue())?.senderDid).toBe(freshInput.payload.from);
    // Release leases and verify round-robin history survives a new repository instance.
    await db.sql`UPDATE delivery_work SET lease_token=NULL,lease_expires_at=NULL WHERE state IN ('accepted','on-hold')`;
    expect((await new DeliveryRepository(db.sql).claimDue())?.senderDid).not.toBe(input.payload.from);
  });
  it('enforces provider-wide budgets across unrelated senders and recipients',async()=>{
    const small=new EnvelopeRepository(db.sql,{...ENVELOPE_ADMISSION,pendingProvider:2,rejectedProvider:1});
    const first=await sender(await recipient()),second=await sender(await recipient()),third=await sender(await recipient());
    expect(await small.accept(await first())).toBe('accepted');
    expect(await small.accept(await second())).toBe('accepted');
    expect(await small.accept(await third())).toBe('rate-limited');
    expect(await small.accept(await first('wrong'))).toBe('unauthorized');
    expect(await small.accept(await third('wrong'))).toBe('rate-limited');
  });

  it('preserves signed state through rollback and recomputes imported accounting',async()=>{
    const snapshot=()=>db.sql`SELECT (to_jsonb(r)-'admission_bytes') AS row FROM received_envelopes r ORDER BY sender_did,message_id`;
    const before=await snapshot();
    await db.sql.begin(async tx=>{
      await tx.unsafe(await Bun.file(new URL('../migrations/rollback/0104_federation_budgets.sql',import.meta.url)).text());
      await tx`DELETE FROM schema_migrations WHERE version=104`;
    });
    await db.migrate();
    expect(await snapshot()).toEqual(before);
    expect(await db.sql`SELECT 1 FROM received_envelopes WHERE admission_bytes < octet_length(envelope_cose)`).toHaveLength(0);
    // Whole-row history imports supply NULL for omitted local fields; the trigger must derive bytes.
    const make=await sender(await recipient()),input=await make('wrong');
    expect(await repository.accept(input)).toBe('unauthorized');
    const [saved]=await db.sql<{row:Record<string,unknown>}[]>`SELECT to_jsonb(r)-'admission_bytes' AS row
      FROM received_envelopes r WHERE message_id=${input.payload.message_id}`;
    await db.sql`DELETE FROM received_envelopes WHERE message_id=${input.payload.message_id}`;
    await db.sql`INSERT INTO received_envelopes SELECT * FROM jsonb_populate_record(NULL::received_envelopes,${JSON.stringify(saved!.row)}::text::jsonb)`;
    const [restored]=await db.sql<{admission_bytes:number}[]>`SELECT admission_bytes FROM received_envelopes WHERE message_id=${input.payload.message_id}`;
    expect(Number(restored!.admission_bytes)).toBeGreaterThan(input.representation.length);
  });

});
