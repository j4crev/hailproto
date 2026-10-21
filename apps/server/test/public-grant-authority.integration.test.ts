import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { createWebCryptoSigner,signPayload,type HailGrant,type HailAddressBinding,type HailSenderProfile } from "@hailproto/codec";
import { expect,it } from "vitest";
import { ProviderDatabase } from "../src/db/database.js";
import { GrantRepository } from "../src/grants/repository.js";
import type { SignedGrantRevisionInput,GrantConsentEvidence } from "../src/grants/store.js";
import { VerifiedPublicPlcResolver } from "../src/plc/public-resolver.js";
import { evidenceHash } from "../src/plc/read-evidence.js";
import { publicPlcFixture,publicPlcReaders } from "./public-plc-fixture.js";
import { uuidV7 } from "../src/identity/uuid-v7.js";

it.skipIf(!process.env.DATABASE_URL)("public Grant revisions/imports retain exact authority atomically and unilateral revocation needs no sender reads",async()=>{
  const admin=new SQL(process.env.DATABASE_URL!),schema=`grant_authority_${randomUUID().replaceAll("-","")}`;
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  const url=new URL(process.env.DATABASE_URL!);url.searchParams.set("options",`-csearch_path=${schema}`);
  const db=new ProviderDatabase(url.toString());
  try{
    await db.migrate();
    const grantor=await publicPlcFixture("https://local.example.com/hail"),grantee=await publicPlcFixture("https://peer.example.com/hail");
    const readers=publicPlcReaders([grantor,grantee]),resolver=new VerifiedPublicPlcResolver(db.sql,readers,["provider"],["https://local.example.com"]);
    const ownerId=randomUUID(),peerId=randomUUID(),now=Math.floor(Date.now()/1000),zero=new Uint8Array(32);
    for(const [id,did,address] of [[ownerId,grantor.did,"owner@local.example.com"],[peerId,grantee.did,"sender@peer.example.com"]])await db.sql`
      INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${id!},${randomUUID()},${address!},${did!},'active',now(),${zero},'public')`;
    const binding:HailAddressBinding={type:"hail.address-binding",version:1,address:"sender@peer.example.com",did:grantee.did,
      issued_at:now,expires_at:now+3600,key_id:`${grantee.did}#hail-identity`};
    const profile:HailSenderProfile={type:"hail.sender-profile",version:1,did:grantee.did,revision:1,display_name:"Sender",offers_uncategorized:false,
      categories:[{id:"updates",label:"Updates"}],updated_at:now,key_id:`${grantee.did}#hail-messaging`};
    const bindingBytes=await signPayload("hail.address-binding",binding,createWebCryptoSigner(binding.key_id,grantee.identity.pair.privateKey));
    const profileBytes=await signPayload("hail.sender-profile",profile,createWebCryptoSigner(profile.key_id,grantee.messaging.pair.privateKey));
    const peer=await resolver.resolve(grantee.did),owner=await resolver.resolve(grantor.did);
    const consent:GrantConsentEvidence={address:{address:binding.address,did:grantee.did,binding,representation:bindingBytes,digest:evidenceHash(bindingBytes),
      serviceBase:peer.serviceBase,identityDidKey:peer.identityDidKey,messagingDidKey:peer.messagingDidKey,plcEvidence:peer.evidence,verifiedAt:new Date()},
      senderProfile:{did:grantee.did,profile,representation:profileBytes,digest:evidenceHash(profileBytes),etag:'"fixture"',serviceBase:peer.serviceBase,
        messagingDidKey:peer.messagingDidKey,plcEvidence:peer.evidence,verifiedAt:new Date()}};
    const payload:HailGrant={type:"hail.grant",version:1,grant_id:uuidV7(),revision:1,previous:null,grantor:grantor.did,grantee:grantee.did,
      scope:[{type:"categories",values:["updates"]}],status:"active",issued_at:now,updated_at:now,expires_at:now+3600,
      consent_context:{grantee_address:binding.address,address_binding_hash:{algorithm:"sha-256",value:consent.address.digest},sender_profile_hash:{algorithm:"sha-256",value:consent.senderProfile.digest}},
      key_id:`${grantor.did}#hail-identity`};
    const signed=async(p:HailGrant):Promise<SignedGrantRevisionInput>=>{const representation=await signPayload("hail.grant",p,createWebCryptoSigner(p.key_id,grantor.identity.pair.privateKey));
      return{localAccountId:ownerId,localRole:"grantor",payload:p,representation,digest:evidenceHash(representation),signingPublicKey:owner.identityDidKey,
        signingPlcEvidence:owner.evidence,expectedServiceBase:owner.serviceBase};};
    const revision=await signed(payload),store=new GrantRepository(db.sql);
    const before=(await db.sql`SELECT grant_id FROM grant_lineages`).length;
    const stale=new VerifiedPublicPlcResolver(db.sql,readers,["provider"],["https://local.example.com"],()=>new Date(Date.now()-60_000));
    await expect(store.insertAuthoritativeRevision1({revision:{...revision,signingPlcEvidence:(await stale.resolve(grantor.did)).evidence},consent,destinationServiceBase:peer.serviceBase})).rejects.toThrow("stale");
    await expect(store.insertAuthoritativeRevision1({revision,consent:{...consent,address:{...consent.address,plcEvidence:owner.evidence}},destinationServiceBase:peer.serviceBase})).rejects.toThrow("mismatched");
    expect((await db.sql`SELECT grant_id FROM grant_lineages`).length).toBe(before);
    expect(await db.sql`SELECT grant_id FROM grant_revisions`).toHaveLength(0);expect(await db.sql`SELECT grant_id FROM grant_publications`).toHaveLength(0);
    expect(await db.sql`SELECT grant_id FROM public_grant_authority_evidence`).toHaveLength(0);
    await store.insertAuthoritativeRevision1({revision,consent,destinationServiceBase:peer.serviceBase});
    const links=await db.sql<{purpose:string;representation_digest:Uint8Array}[]>`SELECT purpose,representation_digest FROM public_grant_authority_evidence WHERE grant_id=${payload.grant_id} ORDER BY purpose`;
    expect(links.map(row=>row.purpose)).toEqual(["consent-binding","consent-profile","signer"]);
    for(const link of links)expect(new Uint8Array(link.representation_digest)).toEqual(revision.digest);
    const revoked=await signed({...payload,status:"revoked",revision:2,previous:revision.digest,updated_at:now+1});
    await store.appendAuthoritativeRevocation({revision:revoked,expectedCurrentRevision:1,expectedCurrentDigest:revision.digest});
    expect(await db.sql`SELECT purpose FROM public_grant_authority_evidence WHERE grant_id=${payload.grant_id} AND revision=2`).toHaveLength(1);
    expect((await store.findCurrentByGrantId(payload.grant_id))!.payload.status).toBe("revoked");
    const receivedRevision=await signed({...payload,grant_id:uuidV7()});
    const incoming={...receivedRevision,localAccountId:peerId,recipientEvidence:peer.evidence,recipientServiceBase:peer.serviceBase};
    const received=await store.acceptReceivedRevision(incoming);expect(received.localRole).toBe("grantee");
    expect(await store.acceptReceivedRevision(incoming)).toEqual(received);
    expect(await db.sql`SELECT purpose FROM public_grant_authority_evidence WHERE grant_id=${receivedRevision.payload.grant_id} AND local_account_id=${peerId}`).toHaveLength(2);
    await expect(db.sql`UPDATE public_grant_authority_evidence SET purpose='signer'`).rejects.toThrow("immutable");
    await expect(db.sql`DELETE FROM public_grant_authority_evidence`).rejects.toThrow("immutable");
    const connection=await db.sql.reserve();try{
      await expect(connection.unsafe(await Bun.file(new URL("../migrations/rollback/0042_public_grant_authority.sql",import.meta.url)).text())).rejects.toThrow("prevent rollback");}
    finally{await connection.unsafe("ROLLBACK");connection.release();}
  }finally{await db.close();await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}
},30_000);
