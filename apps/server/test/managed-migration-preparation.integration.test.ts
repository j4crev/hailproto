import {randomBytes,randomUUID} from "node:crypto";
import {SQL} from "bun";
import {P256Keypair} from "@atproto/crypto";
import {encodeBase64Url} from "@hailproto/codec";
import {base58btc} from "multiformats/bases/base58";
import {expect,it} from "vitest";
import {ProviderDatabase} from "../src/db/database.js";
import {KeyEncryptor} from "../src/identity/key-encryption.js";
import {PreparedMigrationTarget} from "../src/migration/target-keys.js";
import {encodeManagedHandshake,managedHandshakeDigest,managedHandshakeSignatureInput,verifyManagedProviderHandshake,
  signManagedProviderHandshake,type ManagedTransferAcknowledgement,type ManagedTransferGrant} from "../src/migration/managed-handshake.js";

const integration=process.env.DATABASE_URL?it:it.skip;

integration("migration 47 prepares distinct destination-held managed roles without exporting private material",async()=>{
  const admin=new SQL(process.env.DATABASE_URL!),schema=`managed_target_${randomUUID().replaceAll("-","")}`;
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);const url=new URL(process.env.DATABASE_URL!);
  url.searchParams.set("options",`-csearch_path=${schema}`);const db=new ProviderDatabase(url.toString());
  try {
    await db.migrate();const target=new PreparedMigrationTarget(db.sql,new KeyEncryptor(encodeBase64Url(randomBytes(32))),"https://b.example.com/hail");
    const portable=await target.prepare(`did:plc:${"a".repeat(24)}`);
    expect(portable.custodyProfile).toBe("portable");expect(portable.identityPublicKey).toBeUndefined();
    await target.assertOwnership(portable);
    const managed=await target.prepare(`did:plc:${"b".repeat(24)}`,"managed");
    expect(managed.custodyProfile).toBe("managed");expect(managed.identityPublicKey).toMatch(/^did:key:z/);
    expect(new Set([managed.identityPublicKey,managed.messagingPublicKey,managed.rotationPublicKey]).size).toBe(3);
    await target.assertOwnership(managed);
    const row=(await db.sql<{custody_profile:string;identity_public_key:string;identity_private_ciphertext:Uint8Array;
      identity_nonce:Uint8Array}[]>`SELECT custody_profile,identity_public_key,identity_private_ciphertext,identity_nonce
      FROM prepared_migration_target_keys WHERE transfer_id=${managed.transferId}`)[0]!;
    expect(row.custody_profile).toBe("managed");expect(row.identity_public_key).toBe(managed.identityPublicKey);
    expect(row.identity_private_ciphertext.length).toBeGreaterThan(16);expect(row.identity_nonce).toHaveLength(12);
    const owner=await P256Keypair.create(),sourcePair=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]) as CryptoKeyPair;
    const sourceRaw=new Uint8Array(await crypto.subtle.exportKey("raw",sourcePair.publicKey)),prefixed=new Uint8Array(34);
    prefixed.set([0xed,0x01]);prefixed.set(sourceRaw,2);const sourceIdentity=`did:key:${base58btc.encode(prefixed)}`;
    const now=Math.floor(Date.now()/1000),grantValue:ManagedTransferGrant={type:"hail.managed-transfer-grant",version:1,did:managed.did,
      nonce:randomUUID(),source_service_base:"https://a.example.com/hail",destination_service_base:managed.destinationServiceBase,
      destination_domain:"b.example.com",owner_recovery_key:owner.did(),source_identity_key:sourceIdentity,issued_at:now,expires_at:now+3600};
    const grantBytes=encodeManagedHandshake(grantValue),grant={payloadBytes:grantBytes,
      signature:await owner.sign(managedHandshakeSignatureInput(grantValue.type,grantBytes))};
    const acknowledgementValue:ManagedTransferAcknowledgement={type:"hail.managed-transfer-acknowledgement",version:1,did:managed.did,
      nonce:grantValue.nonce,source_service_base:grantValue.source_service_base,destination_service_base:grantValue.destination_service_base,
      grant_digest:managedHandshakeDigest(grant.payloadBytes),source_messaging_key:sourceIdentity,issued_at:now,expires_at:now+3600};
    const acknowledgement=await signManagedProviderHandshake(acknowledgementValue,sourcePair.privateKey);
    const offer=await target.createManagedOffer(managed,grant,acknowledgement,{async resolve(did:string){return {did,identityDidKey:sourceIdentity,
      messagingDidKey:sourceIdentity,serviceBase:grantValue.source_service_base,evidence:{document:{},data:{did,rotationKeys:[owner.did()],
        verificationMethods:{"hail-identity":sourceIdentity,"hail-messaging":sourceIdentity},alsoKnownAs:[],
        services:{hail:{type:"HailMessaging",endpoint:grantValue.source_service_base}}},log:[],verification:{profile:"strict-public-v1",
          digest:"fixture",operationCid:"fixture",verifiedAt:new Date().toISOString()}}};}});
    await expect(verifyManagedProviderHandshake(offer,"hail.managed-transfer-offer",managed.messagingPublicKey)).resolves.toMatchObject({
      transfer_id:managed.transferId,destination_identity_key:managed.identityPublicKey,
      destination_rotation_key:managed.rotationPublicKey,destination_messaging_key:managed.messagingPublicKey});
    const connection=await db.sql.reserve();try {
      await expect(connection.unsafe(await Bun.file(new URL("../migrations/rollback/0047_managed_provider_migration.sql",import.meta.url)).text()))
        .rejects.toThrow("rollback refused");
    } finally {await connection.unsafe("ROLLBACK");connection.release();}
  } finally {await db.close();await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}
},30_000);
