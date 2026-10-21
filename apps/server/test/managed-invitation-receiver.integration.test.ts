import {randomBytes,randomUUID} from "node:crypto";
import {P256Keypair} from "@atproto/crypto";
import {encodeBase64Url} from "@hailproto/codec";
import {base58btc} from "multiformats/bases/base58";
import {SQL} from "bun";
import {expect,it} from "vitest";
import {ProviderDatabase} from "../src/db/database.js";
import {KeyEncryptor} from "../src/identity/key-encryption.js";
import {ManagedTransferInvitationReceiver} from "../src/migration/managed-invitation-receiver.js";
import {encodeManagedHandshake,managedHandshakeDigest,managedHandshakeSignatureInput,signManagedProviderHandshake,
  verifyManagedProviderHandshake,type ManagedTransferAcknowledgement,type ManagedTransferGrant}
  from "../src/migration/managed-handshake.js";
import {PreparedMigrationTarget} from "../src/migration/target-keys.js";

const integration=process.env.DATABASE_URL?it:it.skip;
async function ed(){const pair=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]) as CryptoKeyPair;
  const raw=new Uint8Array(await crypto.subtle.exportKey("raw",pair.publicKey)),prefixed=new Uint8Array(34);
  prefixed.set([0xed,0x01]);prefixed.set(raw,2);return {pair,did:`did:key:${base58btc.encode(prefixed)}`};}

integration("materializes one exact managed destination Offer from the owner grant and source acknowledgement",async()=>{
  const admin=new SQL(process.env.DATABASE_URL!),schema=`managed_ingress_${randomUUID().replaceAll("-","")}`;
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);const url=new URL(process.env.DATABASE_URL!);
  url.searchParams.set("options",`-csearch_path=${schema}`);const db=new ProviderDatabase(url.toString());
  try {
    await db.migrate();const did=`did:plc:${"d".repeat(24)}`,owner=await P256Keypair.create(),identity=await ed(),messaging=await ed();
    const now=Math.floor(Date.now()/1000),grantValue:ManagedTransferGrant={type:"hail.managed-transfer-grant",version:1,did,
      nonce:randomUUID(),source_service_base:"https://a.example.com/hail",destination_service_base:"https://b.example.com/hail",
      destination_domain:"b.example.com",owner_recovery_key:owner.did(),source_identity_key:identity.did,
      issued_at:now,expires_at:now+3600};
    const grantBytes=encodeManagedHandshake(grantValue),grant={payloadBytes:grantBytes,
      signature:await owner.sign(managedHandshakeSignatureInput(grantValue.type,grantBytes))};
    const acknowledgementValue:ManagedTransferAcknowledgement={type:"hail.managed-transfer-acknowledgement",version:1,did,
      nonce:grantValue.nonce,source_service_base:grantValue.source_service_base,
      destination_service_base:grantValue.destination_service_base,grant_digest:managedHandshakeDigest(grantBytes),
      source_messaging_key:messaging.did,issued_at:now,expires_at:now+3600};
    const acknowledgement=await signManagedProviderHandshake(acknowledgementValue,messaging.pair.privateKey);
    const resolver={async resolve(value:string){if(value!==did)throw new Error("unknown DID");return {did,
      identityDidKey:identity.did,messagingDidKey:messaging.did,serviceBase:grantValue.source_service_base,
      evidence:{document:{},data:{did,rotationKeys:[owner.did()],verificationMethods:{"hail-identity":identity.did,
        "hail-messaging":messaging.did},alsoKnownAs:[],services:{hail:{type:"HailMessaging",endpoint:grantValue.source_service_base}}},
        log:[],verification:{profile:"strict-public-v1" as const,digest:"fixture",operationCid:"fixture",
          verifiedAt:new Date().toISOString()}}};}};
    const target=new PreparedMigrationTarget(db.sql,new KeyEncryptor(encodeBase64Url(randomBytes(32))),grantValue.destination_service_base);
    const receiver=new ManagedTransferInvitationReceiver(db.sql,resolver,target);
    const first=await receiver.receive(grant,acknowledgement),retry=await receiver.receive(grant,acknowledgement);
    expect(retry).toEqual(first);
    const row=(await db.sql<{custody_profile:string;messaging_public_key:string;identity_public_key:string;transfer_id:string}[]>`
      SELECT custody_profile,messaging_public_key,identity_public_key,transfer_id FROM prepared_migration_target_keys`)[0]!;
    await expect(verifyManagedProviderHandshake(first,"hail.managed-transfer-offer",row.messaging_public_key)).resolves.toMatchObject({
      transfer_id:row.transfer_id,destination_identity_key:row.identity_public_key,
      acknowledgement_digest:managedHandshakeDigest(acknowledgement.payloadBytes)});
    const changedValue={...acknowledgementValue,issued_at:now+1},changed=await signManagedProviderHandshake(changedValue,messaging.pair.privateKey);
    await expect(receiver.receive(grant,changed)).rejects.toThrow("occupies this DID");
  } finally {await db.close();await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}
},30_000);
