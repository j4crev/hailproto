import { createHash, randomBytes, randomUUID } from "node:crypto";
import { P256Keypair, verifySignature } from "@atproto/crypto";
import { assureValidSig, validateOperationLog } from "@did-plc/lib";
import { createWebCryptoVerifier, decodeDeterministic, verifySignedPayload, type HailAddressBinding, type HailGrant } from "@hailproto/codec";
import { base58btc } from "multiformats/bases/base58";
import { describe, expect, it } from "vitest";
import { createUserVault, replaceUserIdentity, unlockUserVault, type UserMigrationConsent, type UserTransferGrant,
  type UserTransferAddressSelection, type UserTransferCancellation, type UserVaultFile,
  type ManagedTransferGrant,type ManagedTransferAddressSelection,type ManagedTransferApproval } from "../src/vault.js";
import { verifyPortableMigrationConsent } from "../../hail-server-ts/src/migration/consent.js";
import { verifyHandshake } from "../../hail-server-ts/src/migration/handshake.js";
import {verifyManagedOwnerHandshake} from "../../hail-server-ts/src/migration/managed-handshake.js";

async function edDidKey() {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const bytes = new Uint8Array(34);
  bytes.set([0xed, 0x01]);
  bytes.set(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)), 2);
  return `did:key:${base58btc.encode(bytes)}`;
}

function verifier(publicDidKey: string) {
  return createWebCryptoVerifier(async () => {
    const bytes = base58btc.decode(publicDidKey.slice("did:key:".length));
    return crypto.subtle.importKey("raw", Uint8Array.from(bytes.slice(2)), "Ed25519", false, ["verify"]);
  });
}

describe("user-owned portable vault", () => {
  it("recovers two independent keys from an encrypted export and rejects an incorrect recovery secret", async () => {
    const generated = await createUserVault();
    const backup = JSON.parse(JSON.stringify(generated.vault)) as UserVaultFile;
    expect(generated.recoverySecret).toHaveLength(32);
    expect(backup.recovery.publicDidKey).not.toBe(backup.identity.publicDidKey);
    expect(backup.recovery.nonce).not.toBe(backup.identity.nonce);
    expect(Object.keys(backup)).toEqual(["type", "version", "did", "createdAt", "recovery", "identity"]);
    await expect(unlockUserVault(backup, randomBytes(32))).rejects.toThrow();
    const restored = await unlockUserVault(backup, generated.recoverySecret);
    expect(restored.vault.recovery.publicDidKey).toBe(generated.vault.recovery.publicDidKey);
    generated.recoverySecret.fill(0);
  });

  it("signs exact PLC state, Grants, bindings and migration consent without provider custody", async () => {
    const generated = await createUserVault();
    const client = await unlockUserVault(JSON.parse(JSON.stringify(generated.vault)) as UserVaultFile,
      generated.recoverySecret);
    const providerKey = await P256Keypair.create({ exportable: true });
    const messagingKey = await edDidKey();
    const genesis = await client.signPlcOperation({ type: "plc_operation", prev: null,
      rotationKeys: [generated.vault.recovery.publicDidKey, providerKey.did()],
      verificationMethods: { "hail-identity": generated.vault.identity.publicDidKey,
        "hail-messaging": messagingKey }, alsoKnownAs: [],
      services: { hail: { type: "HailMessaging", endpoint: "https://provider.example.com/hail" } },
    });
    expect((await assureValidSig([generated.vault.recovery.publicDidKey], genesis.operation)))
      .toBe(generated.vault.recovery.publicDidKey);
    expect((await validateOperationLog(genesis.did, [genesis.operation]))?.rotationKeys[0])
      .toBe(generated.vault.recovery.publicDidKey);
    await client.bindDid(genesis.did, genesis.operation);
    const now = Math.floor(Date.now() / 1000);
    const binding: HailAddressBinding = { type: "hail.address-binding", version: 1,
      address: "alice@user.example.com", did: genesis.did, issued_at: now,
      expires_at: now + 90 * 86400, key_id: `${genesis.did}#hail-identity` };
    const signedBinding = await client.signAddressBinding(binding);
    expect((await verifySignedPayload("hail.address-binding", signedBinding,
      verifier(generated.vault.identity.publicDidKey))).payload.address).toBe(binding.address);
    const hash = new Uint8Array(createHash("sha256").update(signedBinding).digest());
    const grant: HailGrant = { type: "hail.grant", version: 1,
      grant_id: "01954144-8097-7a9d-a7a8-ef29a823eaf1", revision: 1, previous: null,
      grantor: genesis.did, grantee: `did:plc:${"b".repeat(24)}`,
      scope: [{ type: "categories", values: ["updates"] }], status: "active",
      issued_at: now, updated_at: now, expires_at: null,
      consent_context: { grantee_address: "bob@example.com",
        address_binding_hash: { algorithm: "sha-256", value: hash },
        sender_profile_hash: { algorithm: "sha-256", value: hash } },
      key_id: `${genesis.did}#hail-identity` };
    expect((await verifySignedPayload("hail.grant", await client.signGrant(grant),
      verifier(generated.vault.identity.publicDidKey))).payload.grantor).toBe(genesis.did);
    const destination = await P256Keypair.create({ exportable: true });
    const consent: UserMigrationConsent = { type: "hail.portable-migration-consent", version: 1,
      did: genesis.did, transfer_id: randomUUID(), snapshot_digest: randomBytes(32),
      plc_operation_sha256: randomBytes(32), source_service_base: "https://provider.example.com/hail",
      destination_service_base: "https://next.example.com/hail", destination_address: binding.address,
      destination_rotation_key: destination.did(), destination_messaging_key: await edDidKey(),
      user_recovery_key: generated.vault.recovery.publicDidKey,
      user_identity_key: generated.vault.identity.publicDidKey, created_at: now, expires_at: now + 3600 };
    const signedConsent = await client.signMigrationConsent(consent);
    expect((await verifyPortableMigrationConsent(signedConsent,
      generated.vault.identity.publicDidKey, now)).transfer_id).toBe(consent.transfer_id);
    const transfer: UserTransferGrant = { type: "hail.transfer-grant", version: 1, did: genesis.did,
      nonce: randomUUID(), source_service_base: consent.source_service_base,
      destination_service_base: consent.destination_service_base,
      destination_domain: "next.example.com",
      issued_at: now, expires_at: now + 1800 };
    const signedTransfer = await client.signTransferGrant(transfer);
    expect((await verifyHandshake(signedTransfer, "hail.transfer-grant",
      generated.vault.identity.publicDidKey)).nonce).toBe(transfer.nonce);
    await expect(client.signTransferGrant({ ...transfer, did: `did:plc:${"b".repeat(24)}` }))
      .rejects.toThrow("this DID");
    const selection: UserTransferAddressSelection = {
      type: "hail.transfer-address-selection", version: 1, did: genesis.did,
      nonce: transfer.nonce, transfer_id: randomUUID(), grant_digest: randomBytes(32),
      offer_digest: randomBytes(32), address: "alice@next.example.com", selection_nonce: randomUUID(),
      issued_at: now, expires_at: now + 900 };
    const signedSelection = await client.signTransferAddressSelection(selection);
    expect((await verifyHandshake(signedSelection, "hail.transfer-address-selection",
      generated.vault.identity.publicDidKey)).address).toBe(selection.address);
    const cancellation: UserTransferCancellation = {
      type: "hail.transfer-cancellation", version: 1, did: genesis.did, nonce: transfer.nonce,
      grant_digest: new Uint8Array(createHash("sha256").update(signedTransfer.payloadBytes).digest()),
      issued_at: now, expires_at: now + 3600 };
    expect((await verifyHandshake(await client.signTransferCancellation(cancellation),
      "hail.transfer-cancellation", generated.vault.identity.publicDidKey)).nonce)
      .toBe(transfer.nonce);
    const managedSourceIdentity=await edDidKey(),managedGrant:ManagedTransferGrant={type:"hail.managed-transfer-grant",version:1,
      did:genesis.did,nonce:randomUUID(),source_service_base:consent.source_service_base,
      destination_service_base:consent.destination_service_base,destination_domain:"next.example.com",
      owner_recovery_key:generated.vault.recovery.publicDidKey,source_identity_key:managedSourceIdentity,
      issued_at:now,expires_at:now+1800};
    const signedManagedGrant=await client.signManagedTransferOwnerIntent(managedGrant);
    expect((await verifyManagedOwnerHandshake(signedManagedGrant,"hail.managed-transfer-grant",
      generated.vault.recovery.publicDidKey)).source_identity_key).toBe(managedSourceIdentity);
    const managedSelection:ManagedTransferAddressSelection={type:"hail.managed-transfer-address-selection",version:1,
      did:genesis.did,nonce:managedGrant.nonce,transfer_id:randomUUID(),grant_digest:randomBytes(32),offer_digest:randomBytes(32),
      address:"alice@next.example.com",selection_nonce:randomUUID(),issued_at:now,expires_at:now+900};
    const signedManagedSelection=await client.signManagedTransferOwnerIntent(managedSelection);
    expect((await verifyManagedOwnerHandshake(signedManagedSelection,"hail.managed-transfer-address-selection",
      generated.vault.recovery.publicDidKey)).address).toBe(managedSelection.address);
    const destinationIdentity=await edDidKey(),destinationMessaging=await edDidKey();
    const currentState={did:genesis.did,rotationKeys:[generated.vault.recovery.publicDidKey,providerKey.did()],
      verificationMethods:{...genesis.operation.verificationMethods,"other-role":await edDidKey()},
      alsoKnownAs:["at://alice.example.com"],services:{...genesis.operation.services,
        other:{type:"OtherService",endpoint:"https://other.example.com"}}};
    const cutover=await client.signManagedTransferCutover(currentState,genesis.cid,providerKey.did(),destination.did(),
      destinationIdentity,destinationMessaging,"https://next.example.com/hail");
    const managedApproval:ManagedTransferApproval={type:"hail.managed-transfer-approval",version:1,did:genesis.did,
      nonce:managedGrant.nonce,transfer_id:managedSelection.transfer_id,source_service_base:managedGrant.source_service_base,
      destination_service_base:managedGrant.destination_service_base,destination_address:managedSelection.address,
      owner_recovery_key:generated.vault.recovery.publicDidKey,source_identity_key:managedSourceIdentity,
      destination_rotation_key:destination.did(),destination_identity_key:destinationIdentity,destination_messaging_key:destinationMessaging,
      grant_digest:managedSelection.grant_digest,offer_digest:managedSelection.offer_digest,selection_digest:randomBytes(32),
      snapshot_version:4,snapshot_digest:randomBytes(32),history_checkpoint_digest:randomBytes(32),source_generation:1,
      previous_operation_cid:genesis.cid,operation_cid:cutover.cid,issued_at:now,expires_at:now+900};
    const signedManagedApproval=await client.signManagedTransferOwnerIntent(managedApproval,cutover.operation);
    expect((await verifyManagedOwnerHandshake(signedManagedApproval,"hail.managed-transfer-approval",
      generated.vault.recovery.publicDidKey)).snapshot_version).toBe(4);
    await expect(client.signManagedTransferOwnerIntent(managedApproval)).rejects.toThrow("exact owner-signed cutover");
    await expect(client.signManagedTransferOwnerIntent({...managedGrant,owner_recovery_key:destination.did()})).rejects.toThrow("this owner");
    expect(cutover.did).toBe(genesis.did);
    expect(cutover.operation).toMatchObject({prev:genesis.cid,
      rotationKeys:[generated.vault.recovery.publicDidKey,destination.did()],
      verificationMethods:{"hail-identity":destinationIdentity,"hail-messaging":destinationMessaging,
        "other-role":currentState.verificationMethods["other-role"]},
      alsoKnownAs:currentState.alsoKnownAs,services:{hail:{type:"HailMessaging",endpoint:"https://next.example.com/hail"},
        other:currentState.services.other}});
    expect(JSON.parse(new TextDecoder().decode(cutover.operationBytes))).toEqual(cutover.operation);
    expect((await assureValidSig([generated.vault.recovery.publicDidKey],cutover.operation)))
      .toBe(generated.vault.recovery.publicDidKey);
    await expect(client.signManagedTransferCutover(currentState,genesis.cid,providerKey.did(),destination.did(),
      currentState.verificationMethods["other-role"],destinationMessaging,"https://next.example.com/hail"))
      .rejects.toThrow("distinct and fresh");
    await expect(client.signManagedTransferCutover(currentState,genesis.cid,destination.did(),providerKey.did(),
      destinationIdentity,destinationMessaging,"https://next.example.com/hail"))
      .rejects.toThrow("current source rotation");
    const managedIdentity=await edDidKey(),transitionId=randomUUID(),history=randomBytes(32),bindingDigest=randomBytes(32);
    const transitionPreparation={transitionId,accountId:randomUUID(),did:genesis.did,
      direction:"owner-to-managed",ownerRecoveryKey:generated.vault.recovery.publicDidKey,
      oldIdentityKey:generated.vault.identity.publicDidKey,newIdentityKey:managedIdentity,
      providerServiceBase:"https://provider.example.com/hail",previousOperationCid:genesis.cid,
      currentState:{did:genesis.did,rotationKeys:genesis.operation.rotationKeys,
        verificationMethods:genesis.operation.verificationMethods,alsoKnownAs:genesis.operation.alsoKnownAs,services:genesis.operation.services},
      unsignedOperation:{type:"plc_operation",prev:genesis.cid,rotationKeys:genesis.operation.rotationKeys,
        verificationMethods:{...genesis.operation.verificationMethods,"hail-identity":managedIdentity},
        alsoKnownAs:genesis.operation.alsoKnownAs,services:genesis.operation.services},historyCheckpointDigest:history,
      bindingDigest,generationFrom:1,generationTo:2,expiresAt:new Date((now+1800)*1000).toISOString()} as const;
    const transition=await client.signManagedCustodyTransition(transitionPreparation);
    expect(transition.operation.verificationMethods["hail-identity"]).toBe(managedIdentity);
    expect((await assureValidSig([generated.vault.recovery.publicDidKey],transition.operation))).toBe(generated.vault.recovery.publicDidKey);
    const tag=new TextEncoder().encode("hailp.custody-transition.v1\0"),proof=new Uint8Array(tag.length+transition.approvalBytes.length);
    proof.set(tag);proof.set(transition.approvalBytes,tag.length);
    expect(await verifySignature(generated.vault.recovery.publicDidKey,proof,transition.approvalSignature,{jwtAlg:"ES256"})).toBe(true);
    expect((decodeDeterministic(transition.approvalBytes) as {operation_cid:string}).operation_cid).toBe(transition.operationCid);
    await expect(client.signManagedCustodyTransition({...transitionPreparation,newIdentityKey:generated.vault.identity.publicDidKey})).rejects.toThrow();
    await expect(client.signManagedCustodyTransition({...transitionPreparation,unsignedOperation:{...transitionPreparation.unsignedOperation,
      services:{...transitionPreparation.unsignedOperation.services,other:{type:"OtherService",endpoint:"https://other.example.com"}}}})).rejects.toThrow();
    const replacement=await replaceUserIdentity(JSON.parse(JSON.stringify(client.vault)),generated.recoverySecret);
    expect(replacement.vault.recovery.publicDidKey).toBe(client.vault.recovery.publicDidKey);
    expect(replacement.vault.identity.publicDidKey).not.toBe(client.vault.identity.publicDidKey);
    const reverse=await replacement.signManagedCustodyTransition({...transitionPreparation,direction:"managed-to-owner",
      oldIdentityKey:managedIdentity,newIdentityKey:replacement.vault.identity.publicDidKey,
      currentState:{...transitionPreparation.currentState,verificationMethods:{...transitionPreparation.currentState.verificationMethods,
        "hail-identity":managedIdentity}},
      unsignedOperation:{...transitionPreparation.unsignedOperation,
        verificationMethods:{...transitionPreparation.unsignedOperation.verificationMethods,"hail-identity":replacement.vault.identity.publicDidKey}},
      generationFrom:2,generationTo:3});
    expect(reverse.operation.verificationMethods["hail-identity"]).toBe(replacement.vault.identity.publicDidKey);
    expect((decodeDeterministic(reverse.approvalBytes) as {direction:string}).direction).toBe("managed-to-owner");
    generated.recoverySecret.fill(0);
  });
});
