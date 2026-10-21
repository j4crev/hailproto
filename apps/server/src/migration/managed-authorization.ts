import { def } from "@did-plc/lib";
import { decodeDeterministic } from "@hailproto/codec";
import type { SQL } from "bun";
import type { KeyEncryptor } from "../identity/key-encryption.js";
import { importEd25519PrivateKey } from "../identity/keys.js";
import type { OnboardingRepository } from "../onboarding/repository.js";
import type { HailDidResolver } from "../plc/resolver.js";
import { managedHandshakeDigest, signManagedProviderHandshake, verifyManagedOwnerHandshake,
  verifyManagedProviderHandshake, type ManagedTransferAcknowledgement,
  type SignedManagedHandshake } from "./managed-handshake.js";

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

interface ExistingAuthorization {
  custody_profile: "portable"|"managed"; owner_recovery_public_key: string|null;
  grant_bytes: Uint8Array; grant_signature: Uint8Array; invitation_bytes: Uint8Array;
  invitation_signature: Uint8Array; expires_at: Date; cancelled_at: Date|null;
  consumed_transfer_id: string|null;
}

export class ManagedTransferAuthorization {
  constructor(private readonly sql:SQL,private readonly resolver:HailDidResolver,private readonly sourceBase:string,
    private readonly accounts:Pick<OnboardingRepository,"getKey">,private readonly encryptor:KeyEncryptor,
    private readonly now=()=>Math.floor(Date.now()/1000)) {}

  async authorize(signed:SignedManagedHandshake):Promise<SignedManagedHandshake> {
    if(!signed.payloadBytes.length||signed.payloadBytes.length>8192||signed.signature.length!==64)
      throw new Error("Managed transfer grant exceeds its limit");
    const decoded=decodeDeterministic(signed.payloadBytes);
    if(!decoded||typeof decoded!=="object"||!("did" in decoded)||typeof decoded.did!=="string"||
      !/^did:plc:[a-z2-7]{24}$/.test(decoded.did))throw new Error("Managed transfer grant has no canonical DID");
    const state=await this.resolver.resolve(decoded.did),data=def.documentData.parse(state.evidence.data);
    const ownerRecoveryKey=data.rotationKeys[0];
    if(!ownerRecoveryKey||!state.evidence.verification||state.did!==decoded.did||state.serviceBase!==this.sourceBase)
      throw new Error("Managed transfer requires strict current source authority");
    const grant=await verifyManagedOwnerHandshake(signed,"hail.managed-transfer-grant",ownerRecoveryKey),now=this.now();
    if(grant.source_service_base!==this.sourceBase||grant.source_identity_key!==state.identityDidKey||
      grant.issued_at>now+300||grant.expires_at<=now)throw new Error("Managed transfer grant is stale or for another authority");
    const account=(await this.sql<{id:string;owner_recovery_public_key:string;provider_identity_public_key:string}[]>`
      SELECT account.id,managed.owner_recovery_public_key,managed.provider_identity_public_key
      FROM provider_accounts account JOIN managed_custody_evidence managed ON managed.account_id=account.id
      WHERE account.did=${grant.did} AND account.onboarding_state='active' AND account.activation_verification_mode='public'
        AND EXISTS (SELECT 1 FROM account_keys held WHERE held.account_id=account.id AND held.role='hail-identity'
          AND held.public_key=managed.provider_identity_public_key)`)[0];
    if(!account||account.owner_recovery_public_key!==ownerRecoveryKey||
      account.provider_identity_public_key!==state.identityDidKey)throw new Error("Source does not hold the strict managed account authority");
    const messaging=await this.accounts.getKey(account.id,"hail-messaging");
    if(messaging.algorithm!=="ed25519"||messaging.publicKey!==state.messagingDidKey)
      throw new Error("Source messaging authority is no longer current");
    const acknowledgement:ManagedTransferAcknowledgement={type:"hail.managed-transfer-acknowledgement",version:1,
      did:grant.did,nonce:grant.nonce,source_service_base:grant.source_service_base,
      destination_service_base:grant.destination_service_base,grant_digest:managedHandshakeDigest(signed.payloadBytes),
      source_messaging_key:messaging.publicKey,issued_at:now,expires_at:grant.expires_at};
    const secret=await this.encryptor.decrypt(account.id,messaging.role,messaging.algorithm,messaging.publicKey,messaging);
    let acknowledged:SignedManagedHandshake;
    try{acknowledged=await signManagedProviderHandshake(acknowledgement,await importEd25519PrivateKey(secret));}
    finally{secret.fill(0);}
    return this.sql.begin(async tx=>{
      await tx`SELECT id FROM provider_accounts WHERE id=${account.id} FOR UPDATE`;
      const inserted=await tx<{did:string}[]>`INSERT INTO provider_transfer_authorizations
        (did,nonce,destination_service_base,expires_at,grant_bytes,grant_signature,invitation_bytes,invitation_signature,
          custody_profile,owner_recovery_public_key)
        VALUES (${grant.did},${grant.nonce},${grant.destination_service_base},${new Date(grant.expires_at*1000)},
          ${signed.payloadBytes},${signed.signature},${acknowledged.payloadBytes},${acknowledged.signature},'managed',${ownerRecoveryKey})
        ON CONFLICT (did) DO UPDATE SET nonce=EXCLUDED.nonce,destination_service_base=EXCLUDED.destination_service_base,
          expires_at=EXCLUDED.expires_at,grant_bytes=EXCLUDED.grant_bytes,grant_signature=EXCLUDED.grant_signature,
          invitation_bytes=EXCLUDED.invitation_bytes,invitation_signature=EXCLUDED.invitation_signature,
          custody_profile='managed',owner_recovery_public_key=EXCLUDED.owner_recovery_public_key,created_at=clock_timestamp(),
          origin_request_bytes=NULL,origin_request_signature=NULL,origin_confirmed_at=NULL,invitation_attempts=0,
          next_invitation_attempt_at=clock_timestamp(),invitation_lease_token=NULL,invitation_lease_expires_at=NULL,
          cancelled_at=NULL,cancellation_bytes=NULL,cancellation_signature=NULL,cancellation_receipt_bytes=NULL,
          cancellation_receipt_signature=NULL
        WHERE provider_transfer_authorizations.consumed_transfer_id IS NULL
          AND ((provider_transfer_authorizations.expires_at<=clock_timestamp() AND
            provider_transfer_authorizations.origin_confirmed_at IS NULL) OR provider_transfer_authorizations.cancelled_at IS NOT NULL)
          AND (provider_transfer_authorizations.grant_bytes<>EXCLUDED.grant_bytes OR
            provider_transfer_authorizations.grant_signature<>EXCLUDED.grant_signature) RETURNING did`;
      if(inserted[0])return acknowledged;
      const row=(await tx<ExistingAuthorization[]>`SELECT custody_profile,owner_recovery_public_key,grant_bytes,grant_signature,
        invitation_bytes,invitation_signature,expires_at,cancelled_at,consumed_transfer_id
        FROM provider_transfer_authorizations WHERE did=${grant.did} FOR UPDATE`)[0];
      if(!row||row.custody_profile!=="managed"||row.owner_recovery_public_key!==ownerRecoveryKey||row.cancelled_at||
        row.consumed_transfer_id||row.expires_at.getTime()<=this.now()*1000||!same(row.grant_bytes,signed.payloadBytes)||
        !same(row.grant_signature,signed.signature))throw new Error("A different or unresolved transfer authorization already exists for this DID");
      const prior={payloadBytes:new Uint8Array(row.invitation_bytes),signature:new Uint8Array(row.invitation_signature)};
      const parsed=await verifyManagedProviderHandshake(prior,"hail.managed-transfer-acknowledgement",state.messagingDidKey);
      if(parsed.did!==grant.did||parsed.nonce!==grant.nonce||!same(parsed.grant_digest,managedHandshakeDigest(signed.payloadBytes)))
        throw new Error("Stored managed acknowledgement conflicts with owner grant");
      return prior;
    });
  }
}
