import { randomBytes,randomUUID } from "node:crypto";
import { SQL } from "bun";
import { cidForCbor } from "@atproto/common";
import { signOperation } from "@did-plc/lib";
import { createWebCryptoSigner,signPayload,inspectSignedPayload,decodeDeterministic,type HailEnvelope,type HailGrant } from "@hailproto/codec";
import { expect,it } from "vitest";
import { ProviderDatabase } from "../src/db/database.js";
import { EnvelopeRepository } from "../src/envelopes/repository.js";
import { EnvelopeReceiver } from "../src/envelopes/receiver.js";
import { OnboardingRepository } from "../src/onboarding/repository.js";
import { uuidV7 } from "../src/identity/uuid-v7.js";
import { VerifiedPublicPlcResolver } from "../src/plc/public-resolver.js";
import { evidenceHash,PUBLIC_EVIDENCE_LIMITS } from "../src/plc/read-evidence.js";
import { publicEdKey,publicPlcFixture,publicPlcReaders } from "./public-plc-fixture.js";

it.skipIf(!process.env.DATABASE_URL)("fresh public reads bind exact accepted envelope evidence, fail closed after outage/rotation, and preserve history",async()=>{
  const admin=new SQL(process.env.DATABASE_URL!),schema=`authority_${randomUUID().replaceAll("-","")}`;
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  const url=new URL(process.env.DATABASE_URL!);url.searchParams.set("options",`-csearch_path=${schema}`);
  const db=new ProviderDatabase(url.toString());
  try{
    await db.migrate();
    const sender=await publicPlcFixture("https://sender.example.com/hail"),recipient=await publicPlcFixture("https://local.example.com/hail");
    const readers=publicPlcReaders([sender,recipient]),resolver=new VerifiedPublicPlcResolver(db.sql,readers,["local-operator"],["https://local.example.com"]);
    const id=randomUUID(),grantId=uuidV7(),now=Math.floor(Date.now()/1000),zero=new Uint8Array(32);
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${id},${randomUUID()},'owner@local.example.com',${recipient.did},'active',now(),${zero},'public')`;
    const grant:HailGrant={type:"hail.grant",version:1,grant_id:grantId,revision:1,previous:null,grantor:recipient.did,grantee:sender.did,
      scope:[{type:"categories",values:["updates"]}],status:"active",issued_at:now,updated_at:now,expires_at:now+3600,
      consent_context:{grantee_address:"sender@sender.example.com",address_binding_hash:{algorithm:"sha-256",value:zero},sender_profile_hash:{algorithm:"sha-256",value:zero}},
      key_id:`${recipient.did}#hail-identity`};
    const signedGrant=await signPayload("hail.grant",grant,createWebCryptoSigner(grant.key_id,recipient.identity.pair.privateKey)),grantDigest=evidenceHash(signedGrant);
    await db.sql`INSERT INTO grant_lineages(grant_id,local_account_id,local_role,grantor_did,grantee_did,current_revision,current_digest,current_status)
      VALUES(${grantId},${id},'grantor',${recipient.did},${sender.did},1,${grantDigest},'active')`;
    await db.sql`INSERT INTO grant_revisions(grant_id,revision,status,issued_at,updated_at,expires_at,scope_payload,consent_address_binding_sha256,
      consent_sender_profile_sha256,cose,representation_digest,signing_public_key,signing_plc_document,signing_plc_data,signing_plc_operation_log)
      VALUES(${grantId},1,'active',${now},${now},${now+3600},${JSON.stringify(grant.scope)}::jsonb,${zero},${zero},${signedGrant},${grantDigest},
        ${recipient.identity.didKey},'{}','{}','[]')`;
    const fingerprint=async()=>Promise.all(["provider_accounts","grant_lineages","grant_revisions","account_serving_generations"].map(async table=>
      JSON.stringify(await db.sql.unsafe(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`))));
    const before=await fingerprint(),migrationConnection=await db.sql.reserve();
    try{
      await migrationConnection.unsafe(await Bun.file(new URL("../migrations/rollback/0051_did_monitor_coverage.sql",import.meta.url)).text());
      await migrationConnection.unsafe(await Bun.file(new URL("../migrations/rollback/0050_managed_profile_version.sql",import.meta.url)).text());
      if((await migrationConnection`SELECT version FROM schema_migrations WHERE version=49`).length)
        await migrationConnection.unsafe(await Bun.file(new URL("../migrations/rollback/0049_managed_migration_materialization.sql",import.meta.url)).text());
      if((await migrationConnection`SELECT version FROM schema_migrations WHERE version=48`).length)
        await migrationConnection.unsafe(await Bun.file(new URL("../migrations/rollback/0048_managed_migration_approval.sql",import.meta.url)).text());
      await migrationConnection.unsafe(await Bun.file(new URL("../migrations/rollback/0047_managed_provider_migration.sql",import.meta.url)).text());
      await migrationConnection.unsafe(await Bun.file(new URL("../migrations/rollback/0046_reverse_custody_transition.sql",import.meta.url)).text());
      await migrationConnection.unsafe(await Bun.file(new URL("../migrations/rollback/0045_same_provider_custody_transition.sql",import.meta.url)).text());
      await migrationConnection.unsafe(await Bun.file(new URL("../migrations/rollback/0044_public_onboarding.sql",import.meta.url)).text());
      await migrationConnection.unsafe(await Bun.file(new URL("../migrations/rollback/0043_public_signing_authority.sql",import.meta.url)).text());
      await migrationConnection.unsafe(await Bun.file(new URL("../migrations/rollback/0042_public_grant_authority.sql",import.meta.url)).text());
      await migrationConnection.unsafe(await Bun.file(new URL("../migrations/rollback/0041_public_plc_authority.sql",import.meta.url)).text());
    }
    finally{await migrationConnection.unsafe("ROLLBACK");migrationConnection.release();}
    expect(await fingerprint()).toEqual(before);await db.migrate();await db.migrate();expect(await fingerprint()).toEqual(before);
    expect(await db.sql`SELECT evidence_digest FROM public_plc_resolution_evidence`).toHaveLength(0);
    expect(await db.sql`SELECT message_id FROM public_envelope_authority_evidence`).toHaveLength(0);
    const envelope=(messageId=uuidV7()):HailEnvelope=>({type:"hail.envelope",version:1,message_id:messageId,from:sender.did,to:recipient.did,
      authorization:{type:"grant",grant_id:grantId},category:"updates",created_at:now,expires_at:now+3600,
      body:{digest:{algorithm:"sha-256",value:zero},size:12,media_type:"application/hail-body+cbor",profile:"spt-1",available_until:now+31*86400,
        access:{type:"bearer",token:randomBytes(32),expires_at:now+31*86400}},reply:{allowed:false}});
    const sign=(payload:HailEnvelope,key=sender.messaging.pair.privateKey)=>signPayload("hail.envelope",payload,createWebCryptoSigner(`${sender.did}#hail-messaging`,key));
    const store=new EnvelopeRepository(db.sql),receiver=new EnvelopeReceiver(new OnboardingRepository(db.sql),store,resolver,"https://local.example.com/hail");
    const first=envelope(),bytes=await sign(first);
    expect(await receiver.receive(bytes)).toBe("accepted");
    const links=await db.sql<{authority_did:string;representation_digest:Uint8Array;evidence_digest:Uint8Array}[]>`
      SELECT authority_did,representation_digest,evidence_digest FROM public_envelope_authority_evidence WHERE sender_did=${sender.did} AND message_id=${first.message_id} ORDER BY authority_did`;
    expect(links.map(row=>row.authority_did).sort()).toEqual([sender.did,recipient.did].sort());
    for(const link of links){
      expect(new Uint8Array(link.representation_digest)).toEqual(evidenceHash(bytes));
      const retained=(await db.sql<{bundle_bytes:Uint8Array}[]>`SELECT bundle_bytes FROM public_plc_resolution_evidence WHERE evidence_digest=${link.evidence_digest}`)[0]!.bundle_bytes;
      expect(evidenceHash(retained)).toEqual(new Uint8Array(link.evidence_digest));
      expect((decodeDeterministic(retained,PUBLIC_EVIDENCE_LIMITS) as Record<string,any>).witnesses).toHaveLength(1);
    }
    expect(await receiver.receive(bytes)).toBe("duplicate");
    expect(await db.sql`SELECT authority_did FROM public_envelope_authority_evidence WHERE message_id=${first.message_id}`).toHaveLength(2);
    const offline=new VerifiedPublicPlcResolver(db.sql,[readers[0],{...readers[1],async audit(){throw new Error("Mirror down");}}],
      ["local-operator"],["https://local.example.com"]);
    await expect(offline.resolve(sender.did)).resolves.toMatchObject({did:sender.did});
    expect(await new EnvelopeReceiver(new OnboardingRepository(db.sql),store,offline,"https://local.example.com/hail").receive(await sign(envelope()))).toBe("accepted");
    const oldKey=sender.messaging,next=await publicEdKey(),{sig,...unsigned}=sender.log.at(-1)!;
    sender.log.push(await signOperation({...unsigned,prev:(await cidForCbor(sender.log.at(-1)!)).toString(),
      verificationMethods:{...unsigned.verificationMethods,"hail-messaging":next.didKey}},sender.owner));sender.messaging=next;
    expect((await resolver.resolve(sender.did)).messagingDidKey).toBe(next.didKey);
    expect(await receiver.receive(await sign(envelope(),oldKey.pair.privateKey))).toBe("ignored");
    expect(await receiver.receive(await sign(envelope()))).toBe("accepted");
    expect((await db.sql<{state:string}[]>`SELECT state FROM delivery_work WHERE sender_did=${sender.did} AND message_id=${first.message_id}`)[0]!.state).toBe("accepted");
    expect(await db.sql`SELECT evidence_digest FROM public_envelope_authority_evidence WHERE message_id=${first.message_id}`).toHaveLength(2);
    // Store-layer refusal rolls back the received row, authority bindings and
    // work enqueue together, even when the signed envelope itself is valid.
    const payload=envelope(),representation=await sign(payload),senderEvidence=await resolver.resolve(sender.did),recipientEvidence=await resolver.resolve(recipient.did);
    const parsed=inspectSignedPayload("hail.envelope",representation),payloadDigest=evidenceHash(parsed.payloadBytes);
    const input={payload,representation,payloadDigest,envelopeDigest:payloadDigest,localAccountId:id,signingPublicKey:next.didKey,evidence:senderEvidence.evidence,
      recipientEvidence:recipientEvidence.evidence,recipientServiceBase:"https://local.example.com/hail",now};
    await expect(store.accept({...input,recipientEvidence:senderEvidence.evidence})).rejects.toThrow("authority evidence");
    const stale=new VerifiedPublicPlcResolver(db.sql,readers,["local-operator"],["https://local.example.com"],()=>new Date(Date.now()-60_000));
    await expect(store.accept({...input,evidence:(await stale.resolve(sender.did)).evidence})).rejects.toThrow("stale");
    expect(await db.sql`SELECT message_id FROM received_envelopes WHERE message_id=${payload.message_id}`).toHaveLength(0);
    expect(await db.sql`SELECT message_id FROM delivery_work WHERE message_id=${payload.message_id}`).toHaveLength(0);
    expect(await db.sql`SELECT message_id FROM public_envelope_authority_evidence WHERE message_id=${payload.message_id}`).toHaveLength(0);
    await expect(db.sql`UPDATE public_plc_resolution_evidence SET operation_cid='changed'`).rejects.toThrow("immutable");
    await expect(db.sql`DELETE FROM public_envelope_authority_evidence`).rejects.toThrow("immutable");
    await expect(db.sql`TRUNCATE public_plc_resolution_evidence CASCADE`).rejects.toThrow("immutable");
    const connection=await db.sql.reserve();try{
      await expect(connection.unsafe(await Bun.file(new URL("../migrations/rollback/0041_public_plc_authority.sql",import.meta.url)).text())).rejects.toThrow("prevent rollback");
    }finally{await connection.unsafe("ROLLBACK");connection.release();}
  }finally{await db.close();await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}
},30_000);
