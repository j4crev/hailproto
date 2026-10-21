import {randomBytes,randomUUID} from "node:crypto";
import {P256Keypair} from "@atproto/crypto";
import {encodeBase64Url} from "@hailproto/codec";
import {SQL} from "bun";
import {expect,it} from "vitest";
import {ProviderDatabase} from "../src/db/database.js";
import {KeyEncryptor} from "../src/identity/key-encryption.js";
import {generateAccountKeys} from "../src/identity/keys.js";
import {OnboardingRepository} from "../src/onboarding/repository.js";
import {ManagedTransferAuthorization} from "../src/migration/managed-authorization.js";
import {encodeManagedHandshake,managedHandshakeSignatureInput,verifyManagedProviderHandshake,
  type ManagedTransferGrant} from "../src/migration/managed-handshake.js";
import {TransferDeliveryWorker} from "../src/migration/delivery-worker.js";

const integration=process.env.DATABASE_URL?it:it.skip;

integration("durably admits one exact owner-authorized managed transfer without entering the portable worker",async()=>{
  const admin=new SQL(process.env.DATABASE_URL!),schema=`managed_authorization_${randomUUID().replaceAll("-","")}`;
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);const url=new URL(process.env.DATABASE_URL!);
  url.searchParams.set("options",`-csearch_path=${schema}`);const db=new ProviderDatabase(url.toString());
  try {
    await db.migrate();const accountId=randomUUID(),did=`did:plc:${"c".repeat(24)}`,sourceBase="https://a.example.com/hail";
    const encryptor=new KeyEncryptor(encodeBase64Url(randomBytes(32))),keys=await generateAccountKeys(accountId,encryptor);
    const owner=await P256Keypair.create();
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,
      activation_binding_digest,activation_verification_mode) VALUES (${accountId},${randomUUID()},'alice@a.example.com',${did},
      'active',now(),${randomBytes(32)},'public')`;
    for(const key of keys.keys)await db.sql`INSERT INTO account_keys(account_id,role,algorithm,public_key,encrypted_private_key,
      encryption_nonce,encryption_version,kek_id) VALUES (${accountId},${key.role},${key.algorithm},${key.publicKey},
      ${key.ciphertext},${key.nonce},${key.encryptionVersion},${key.kekId})`;
    await db.sql`INSERT INTO managed_custody_evidence(account_id,owner_recovery_public_key,provider_identity_public_key,
      verification_mode,managed_profile_version) VALUES (${accountId},${owner.did()},${keys.identityDidKey},'strict-public-v1',
        'hail-managed-custody-v1')`;
    const resolver={async resolve(value:string){if(value!==did)throw new Error("unknown DID");return {did,
      identityDidKey:keys.identityDidKey,messagingDidKey:keys.messagingDidKey,serviceBase:sourceBase,
      evidence:{document:{},data:{did,rotationKeys:[owner.did(),keys.rotationDidKey],verificationMethods:{
        "hail-identity":keys.identityDidKey,"hail-messaging":keys.messagingDidKey},alsoKnownAs:[],
        services:{hail:{type:"HailMessaging",endpoint:sourceBase}}},log:[],verification:{profile:"strict-public-v1" as const,
          digest:"fixture",operationCid:"fixture",verifiedAt:new Date().toISOString()}}};}};
    const now=Math.floor(Date.now()/1000),value:ManagedTransferGrant={type:"hail.managed-transfer-grant",version:1,did,
      nonce:randomUUID(),source_service_base:sourceBase,destination_service_base:"https://b.example.com/hail",
      destination_domain:"b.example.com",owner_recovery_key:owner.did(),source_identity_key:keys.identityDidKey,
      issued_at:now,expires_at:now+3600};
    const bytes=encodeManagedHandshake(value),grant={payloadBytes:bytes,
      signature:await owner.sign(managedHandshakeSignatureInput(value.type,bytes))};
    const service=new ManagedTransferAuthorization(db.sql,resolver,sourceBase,new OnboardingRepository(db.sql),encryptor,()=>now);
    const first=await service.authorize(grant),retry=await service.authorize(grant);
    expect(retry).toEqual(first);
    await expect(verifyManagedProviderHandshake(first,"hail.managed-transfer-acknowledgement",keys.messagingDidKey))
      .resolves.toMatchObject({did,nonce:value.nonce,source_messaging_key:keys.messagingDidKey});
    const row=(await db.sql<{custody_profile:string;owner_recovery_public_key:string;invitation_attempts:number}[]>`
      SELECT custody_profile,owner_recovery_public_key,invitation_attempts FROM provider_transfer_authorizations WHERE did=${did}`)[0]!;
    expect(row).toMatchObject({custody_profile:"managed",owner_recovery_public_key:owner.did(),invitation_attempts:0});
    const changed={...value,nonce:randomUUID()},changedBytes=encodeManagedHandshake(changed);
    await expect(service.authorize({payloadBytes:changedBytes,signature:await owner.sign(
      managedHandshakeSignatureInput(changed.type,changedBytes))})).rejects.toThrow("different or unresolved");
    const worker=new TransferDeliveryWorker(db.sql,{async deliver(){throw new Error("portable delivery must not run");}},
      {async publish(){throw new Error("no final request");}});
    await expect(worker.runOnce()).resolves.toBe("idle");
  } finally {await db.close();await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}
},30_000);
