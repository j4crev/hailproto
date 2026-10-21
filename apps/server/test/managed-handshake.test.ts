import { randomBytes, randomUUID } from "node:crypto";
import { P256Keypair } from "@atproto/crypto";
import { base58btc } from "multiformats/bases/base58";
import { expect, it } from "vitest";
import {
  encodeManagedHandshake,
  managedHandshakeDigest,
  managedHandshakeSignatureInput,
  signManagedProviderHandshake,
  verifyManagedHandshakeChain,
  verifyManagedOwnerHandshake,
  type ManagedTransferAddressSelection,
  type ManagedTransferAcknowledgement,
  type ManagedTransferApproval,
  type ManagedTransferGrant,
  type ManagedTransferOffer,
  type SignedManagedHandshake,
} from "../src/migration/managed-handshake.js";

async function ed25519() {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const prefixed = new Uint8Array(34); prefixed.set([0xed, 0x01]); prefixed.set(raw, 2);
  return {privateKey: pair.privateKey, did: `did:key:${base58btc.encode(prefixed)}`};
}

async function ownerSign<T extends ManagedTransferGrant | ManagedTransferAddressSelection | ManagedTransferApproval>(
  value: T, owner: P256Keypair,
): Promise<SignedManagedHandshake> {
  const payloadBytes = encodeManagedHandshake(value);
  return {payloadBytes, signature: await owner.sign(managedHandshakeSignatureInput(value.type, payloadBytes))};
}

it("binds managed A-to-B intent, fresh destination roles, address, and exact v4 cutover to owner recovery", async () => {
  const owner = await P256Keypair.create(), destinationRotation = await P256Keypair.create();
  const sourceIdentity = await ed25519(), sourceMessaging = await ed25519();
  const destinationIdentity = await ed25519(), destinationMessaging = await ed25519();
  const now = Math.floor(Date.now() / 1000), did = `did:plc:${"a".repeat(24)}`, nonce = randomUUID();
  const grantValue: ManagedTransferGrant = {type:"hail.managed-transfer-grant",version:1,did,nonce,
    source_service_base:"https://a.example.com/hail",destination_service_base:"https://b.example.com/hail",
    destination_domain:"b.example.com",owner_recovery_key:owner.did(),source_identity_key:sourceIdentity.did,
    issued_at:now,expires_at:now+3600};
  const grant = await ownerSign(grantValue, owner), transferId = randomUUID();
  const acknowledgementValue:ManagedTransferAcknowledgement={type:"hail.managed-transfer-acknowledgement",version:1,
    did,nonce,source_service_base:grantValue.source_service_base,destination_service_base:grantValue.destination_service_base,
    grant_digest:managedHandshakeDigest(grant.payloadBytes),source_messaging_key:sourceMessaging.did,issued_at:now,expires_at:now+3600};
  const acknowledgement=await signManagedProviderHandshake(acknowledgementValue,sourceMessaging.privateKey);
  const offerValue: ManagedTransferOffer = {type:"hail.managed-transfer-offer",version:1,did,nonce,transfer_id:transferId,
    source_service_base:grantValue.source_service_base,destination_service_base:grantValue.destination_service_base,
    grant_digest:managedHandshakeDigest(grant.payloadBytes),acknowledgement_digest:managedHandshakeDigest(acknowledgement.payloadBytes),
    destination_rotation_key:destinationRotation.did(),
    destination_identity_key:destinationIdentity.did,destination_messaging_key:destinationMessaging.did,
    issued_at:now,expires_at:now+3600};
  const offer = await signManagedProviderHandshake(offerValue,destinationMessaging.privateKey);
  const selectionValue: ManagedTransferAddressSelection = {type:"hail.managed-transfer-address-selection",version:1,did,nonce,
    transfer_id:transferId,grant_digest:managedHandshakeDigest(grant.payloadBytes),offer_digest:managedHandshakeDigest(offer.payloadBytes),
    address:"alice@b.example.com",selection_nonce:randomUUID(),issued_at:now,expires_at:now+3600};
  const selection = await ownerSign(selectionValue,owner);
  const approvalValue: ManagedTransferApproval = {type:"hail.managed-transfer-approval",version:1,did,nonce,transfer_id:transferId,
    source_service_base:grantValue.source_service_base,destination_service_base:grantValue.destination_service_base,
    destination_address:selectionValue.address,owner_recovery_key:owner.did(),source_identity_key:sourceIdentity.did,
    destination_rotation_key:destinationRotation.did(),destination_identity_key:destinationIdentity.did,
    destination_messaging_key:destinationMessaging.did,grant_digest:managedHandshakeDigest(grant.payloadBytes),
    offer_digest:managedHandshakeDigest(offer.payloadBytes),selection_digest:managedHandshakeDigest(selection.payloadBytes),
    snapshot_version:4,snapshot_digest:new Uint8Array(randomBytes(32)),history_checkpoint_digest:new Uint8Array(randomBytes(32)),
    source_generation:7,previous_operation_cid:"bafy-previous",operation_cid:"bafy-cutover",issued_at:now,expires_at:now+300};
  const approval = await ownerSign(approvalValue,owner);
  await expect(verifyManagedHandshakeChain({grant,acknowledgement,offer,selection,approval},owner.did(),now)).resolves.toMatchObject({
    grant:{source_identity_key:sourceIdentity.did},offer:{destination_identity_key:destinationIdentity.did},
    selection:{address:"alice@b.example.com"},approval:{snapshot_version:4,source_generation:7},
  });

  const changedSelection = await ownerSign({...selectionValue,address:"other@b.example.com"},owner);
  await expect(verifyManagedHandshakeChain({grant,acknowledgement,offer,selection:changedSelection,approval},owner.did(),now))
    .rejects.toThrow("one exact owner-approved chain");

  const providerSignedGrant: SignedManagedHandshake = {payloadBytes:grant.payloadBytes,
    signature:new Uint8Array(await crypto.subtle.sign("Ed25519",sourceIdentity.privateKey,
      managedHandshakeSignatureInput(grantValue.type,grant.payloadBytes)))};
  await expect(verifyManagedOwnerHandshake(providerSignedGrant,"hail.managed-transfer-grant",owner.did()))
    .rejects.toThrow("owner signature");
});

it("rejects role reuse and managed approval profiles other than snapshot v4", async () => {
  const owner=await P256Keypair.create(),identity=await ed25519(),now=Math.floor(Date.now()/1000);
  const offer={type:"hail.managed-transfer-offer",version:1,did:`did:plc:${"b".repeat(24)}`,nonce:randomUUID(),
    transfer_id:randomUUID(),source_service_base:"https://a.example.com/hail",destination_service_base:"https://b.example.com/hail",
    grant_digest:new Uint8Array(32),acknowledgement_digest:new Uint8Array(32),destination_rotation_key:owner.did(),destination_identity_key:identity.did,
    destination_messaging_key:identity.did,issued_at:now,expires_at:now+60} satisfies ManagedTransferOffer;
  expect(()=>encodeManagedHandshake(offer)).toThrow("distinct DID keys");
});
