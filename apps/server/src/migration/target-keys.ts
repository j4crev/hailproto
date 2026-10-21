import { randomUUID } from "node:crypto";
import { P256Keypair } from "@atproto/crypto";
import { def } from "@did-plc/lib";
import { base58btc } from "multiformats/bases/base58";
import type { SQL } from "bun";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import type { KeyEncryptor } from "../identity/key-encryption.js";
import { generateAccountIdentityKey, importEd25519PrivateKey } from "../identity/keys.js";
import {retiredReturnAccount,retiredManagedReturnAccount,clearRetiredImportSlots} from "./return.js";
import type { HailDidResolver } from "../plc/resolver.js";
import { handshakeDigest, sameDigest, signHandshake, verifyHandshake,
  type SignedHandshake, type TransferRequest, type TransferGrant, type TransferInvitation,
  type TransferOffer, type TransferAddressSelection, type TransferReservation } from "./handshake.js";
import { managedHandshakeDigest, signManagedProviderHandshake, verifyManagedOwnerHandshake,
  verifyManagedProviderHandshake, type ManagedTransferGrant, type ManagedTransferOffer,
  type ManagedTransferReservation, type ManagedTransferFenceRequest,
  type SignedManagedHandshake } from "./managed-handshake.js";
import { decodeDeterministic } from "@hailproto/codec";
import { createWebCryptoSigner, signPayload, type HailAddressBinding } from "@hailproto/codec";
import { canonicalizeHailAddress } from "../identity/address.js";

export interface PreparedTargetKeys {
  transferId: string;
  did: string;
  destinationServiceBase: string;
  rotationPublicKey: string;
  messagingPublicKey: string;
  custodyProfile?:"portable"|"managed";
  identityPublicKey?:string;
}

interface TargetKeyRow {
  did: string;
  destination_service_base: string;
  rotation_public_key: string;
  rotation_private_ciphertext: Uint8Array;
  rotation_nonce: Uint8Array;
  messaging_public_key: string;
  messaging_private_ciphertext: Uint8Array;
  messaging_nonce: Uint8Array;
  custody_profile:"portable"|"managed";
  identity_public_key:string|null;
  identity_private_ciphertext:Uint8Array|null;
  identity_nonce:Uint8Array|null;
  state: string;
}

export class PreparedMigrationTarget {
  constructor(
    private readonly sql: SQL,
    private readonly encryptor: KeyEncryptor,
    private readonly destinationServiceBase: string,
    private readonly allowReturns=false,
  ) {}

  async recycleRetiredSlots(tx:SQL,did:string,custodyProfile:"portable"|"managed"="portable") {
    if(this.allowReturns){const retired=custodyProfile==="managed"?await retiredManagedReturnAccount(tx,did):await retiredReturnAccount(tx,did);
      if(retired)await clearRetiredImportSlots(tx,retired.account_id);}
  }

  async prepare(did: string,custodyProfile:"portable"|"managed"="portable"): Promise<PreparedTargetKeys> {
    if (!/^did:plc:[a-z2-7]{24}$/.test(did)) throw new Error("Target DID is not canonical");
    const existing = await this.sql<{ id: string }[]>`SELECT id FROM provider_accounts WHERE did = ${did}`;
    if (existing.length&&(!this.allowReturns||!(custodyProfile==="managed"?
      await retiredManagedReturnAccount(this.sql,did):await retiredReturnAccount(this.sql,did)))) throw new Error("Target already serves this DID");
    const transferId = randomUUID();
    const rotation = await P256Keypair.create({ exportable: true });
    const messaging = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
    const prefixed = new Uint8Array(34);
    prefixed.set([0xed, 0x01]);
    prefixed.set(new Uint8Array(await crypto.subtle.exportKey("raw", messaging.publicKey)), 2);
    const rotationPublicKey = rotation.did();
    const messagingPublicKey = `did:key:${base58btc.encode(prefixed)}`;
    const rotationBytes = new Uint8Array(await rotation.export());
    const messagingBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", messaging.privateKey));
    const identity=custodyProfile==="managed"?await generateAccountIdentityKey(transferId,this.encryptor):null;
    let encryptedRotation;
    let encryptedMessaging;
    try {
      [encryptedRotation, encryptedMessaging] = await Promise.all([
        this.encryptor.encrypt(transferId, "plc-rotation", "p256", rotationPublicKey, rotationBytes),
        this.encryptor.encrypt(transferId, "hail-messaging", "ed25519", messagingPublicKey, messagingBytes),
      ]);
    } finally {
      rotationBytes.fill(0);
      messagingBytes.fill(0);
    }
    await this.sql`
      INSERT INTO prepared_migration_target_keys
        (transfer_id, did, destination_service_base, rotation_public_key,
         rotation_private_ciphertext, rotation_nonce, messaging_public_key,
         messaging_private_ciphertext, messaging_nonce,custody_profile,identity_public_key,
         identity_private_ciphertext,identity_nonce)
      VALUES (${transferId}, ${did}, ${this.destinationServiceBase}, ${rotationPublicKey},
        ${encryptedRotation.ciphertext}, ${encryptedRotation.nonce}, ${messagingPublicKey},
        ${encryptedMessaging.ciphertext}, ${encryptedMessaging.nonce},${custodyProfile},${identity?.didKey??null},
        ${identity?.key.ciphertext??null},${identity?.key.nonce??null})
    `;
    return { transferId, did, destinationServiceBase: this.destinationServiceBase,
      rotationPublicKey, messagingPublicKey,custodyProfile,...(identity?{identityPublicKey:identity.didKey}:{}) };
  }

  async validateInvitation(did: string, grantSigned: SignedHandshake,
    invitationSigned: SignedHandshake, resolver: HailDidResolver):
    Promise<{ grant: TransferGrant; invitation: TransferInvitation }> {
    const state = await resolver.resolve(did);
    const grant = await verifyHandshake(grantSigned, "hail.transfer-grant", state.identityDidKey);
    const invitation = await verifyHandshake(invitationSigned, "hail.transfer-invitation", state.messagingDidKey);
    const now = Math.floor(Date.now() / 1000);
    if (state.did !== did || state.serviceBase !== grant.source_service_base ||
      grant.did !== did || invitation.did !== grant.did || invitation.nonce !== grant.nonce ||
      invitation.source_service_base !== grant.source_service_base ||
      invitation.destination_service_base !== grant.destination_service_base ||
      grant.destination_service_base !== this.destinationServiceBase ||
      invitation.expires_at !== grant.expires_at || grant.expires_at <= now ||
      !sameDigest(invitation.grant_digest, handshakeDigest(grantSigned.payloadBytes))) {
      throw new Error("Destination invitation does not match the user grant");
    }
    return { grant, invitation };
  }

  async createOffer(prepared: PreparedTargetKeys, grantSigned: SignedHandshake,
    invitationSigned: SignedHandshake, resolver: HailDidResolver): Promise<SignedHandshake> {
    const { grant, invitation } = await this.validateInvitation(prepared.did, grantSigned, invitationSigned, resolver);
    const now = Math.floor(Date.now() / 1000);
    const offer: TransferOffer = { type: "hail.transfer-offer", version: 1,
      did: prepared.did, nonce: grant.nonce, transfer_id: prepared.transferId,
      source_service_base: grant.source_service_base,
      destination_service_base: grant.destination_service_base,
      grant_digest: handshakeDigest(grantSigned.payloadBytes),
      invitation_digest: handshakeDigest(invitationSigned.payloadBytes),
      invitation_challenge: invitation.challenge,
      destination_rotation_key: prepared.rotationPublicKey,
      destination_messaging_key: prepared.messagingPublicKey,
      issued_at: now, expires_at: grant.expires_at };
    return this.signWithPreparedMessaging(prepared, offer);
  }

  async createManagedOffer(prepared: PreparedTargetKeys, grantSigned: SignedManagedHandshake,
    acknowledgementSigned: SignedManagedHandshake, resolver: HailDidResolver): Promise<SignedManagedHandshake> {
    if (prepared.custodyProfile !== "managed" || !prepared.identityPublicKey) {
      throw new Error("Managed Offer requires prepared managed destination roles");
    }
    if (!grantSigned.payloadBytes.length || grantSigned.payloadBytes.length > 8192) throw new Error("Managed grant exceeds limit");
    const decoded: unknown = decodeDeterministic(grantSigned.payloadBytes);
    if (!decoded || typeof decoded !== "object") throw new Error("Managed grant names another DID");
    const raw = decoded as Partial<ManagedTransferGrant>;
    if (raw.type !== "hail.managed-transfer-grant" || raw.did !== prepared.did) throw new Error("Managed grant names another DID");
    const state = await resolver.resolve(prepared.did), data = def.documentData.parse(state.evidence.data);
    const ownerRecoveryKey = data.rotationKeys[0];
    if (!ownerRecoveryKey || !state.evidence.verification || state.did !== prepared.did ||
      state.serviceBase !== raw.source_service_base || state.identityDidKey !== raw.source_identity_key ||
      prepared.destinationServiceBase !== raw.destination_service_base) {
      throw new Error("Managed Offer requires strict current source authority");
    }
    const grant = await verifyManagedOwnerHandshake(grantSigned, "hail.managed-transfer-grant", ownerRecoveryKey);
    const acknowledgement = await verifyManagedProviderHandshake(acknowledgementSigned,
      "hail.managed-transfer-acknowledgement", state.messagingDidKey);
    const now = Math.floor(Date.now() / 1000);
    const sourceKeys=new Set([ownerRecoveryKey,state.identityDidKey,state.messagingDidKey,...data.rotationKeys]);
    if (grant.issued_at > now + 300 || grant.expires_at <= now || acknowledgement.issued_at > now + 300 ||
      acknowledgement.expires_at <= now || acknowledgement.expires_at !== grant.expires_at ||
      acknowledgement.did !== grant.did || acknowledgement.nonce !== grant.nonce ||
      acknowledgement.source_service_base !== grant.source_service_base ||
      acknowledgement.destination_service_base !== grant.destination_service_base ||
      !Buffer.from(acknowledgement.grant_digest).equals(Buffer.from(managedHandshakeDigest(grantSigned.payloadBytes))) ||
      sourceKeys.has(prepared.identityPublicKey) || sourceKeys.has(prepared.messagingPublicKey) ||
      sourceKeys.has(prepared.rotationPublicKey)) {
      throw new Error("Managed destination roles are not fresh against source authority");
    }
    const offer: ManagedTransferOffer = {type:"hail.managed-transfer-offer",version:1,did:grant.did,nonce:grant.nonce,
      transfer_id:prepared.transferId,source_service_base:grant.source_service_base,
      destination_service_base:grant.destination_service_base,grant_digest:managedHandshakeDigest(grantSigned.payloadBytes),
      acknowledgement_digest:managedHandshakeDigest(acknowledgementSigned.payloadBytes),
      destination_rotation_key:prepared.rotationPublicKey,destination_identity_key:prepared.identityPublicKey,
      destination_messaging_key:prepared.messagingPublicKey,issued_at:now,expires_at:grant.expires_at};
    await this.assertOwnership(prepared);
    const row = (await this.sql<TargetKeyRow[]>`SELECT messaging_public_key,messaging_private_ciphertext,messaging_nonce
      FROM prepared_migration_target_keys WHERE transfer_id=${prepared.transferId}`)[0];
    if (!row || row.messaging_public_key !== prepared.messagingPublicKey) throw new Error("Managed target key missing");
    const keyBytes = await this.encryptor.decrypt(prepared.transferId,"hail-messaging","ed25519",row.messaging_public_key,
      {ciphertext:row.messaging_private_ciphertext,nonce:row.messaging_nonce,encryptionVersion:1,kekId:"poc-v1"});
    try { return signManagedProviderHandshake(offer,await importEd25519PrivateKey(keyBytes)); }
    finally { keyBytes.fill(0); }
  }

  async signManagedArtifact(prepared: PreparedTargetKeys,
    value: ManagedTransferReservation | ManagedTransferFenceRequest): Promise<SignedManagedHandshake> {
    if (prepared.custodyProfile !== "managed" || !prepared.identityPublicKey ||
      value.did !== prepared.did || value.transfer_id !== prepared.transferId ||
      value.destination_rotation_key !== prepared.rotationPublicKey ||
      value.destination_identity_key !== prepared.identityPublicKey ||
      value.destination_messaging_key !== prepared.messagingPublicKey) {
      throw new Error("Managed artifact does not match prepared destination roles");
    }
    await this.assertOwnership(prepared);
    const row = (await this.sql<TargetKeyRow[]>`SELECT messaging_public_key,messaging_private_ciphertext,messaging_nonce
      FROM prepared_migration_target_keys WHERE transfer_id=${prepared.transferId}`)[0];
    if (!row || row.messaging_public_key !== prepared.messagingPublicKey) throw new Error("Managed target key missing");
    const keyBytes = await this.encryptor.decrypt(prepared.transferId, "hail-messaging", "ed25519",
      row.messaging_public_key, { ciphertext: row.messaging_private_ciphertext, nonce: row.messaging_nonce,
        encryptionVersion: 1, kekId: "poc-v1" });
    try { return signManagedProviderHandshake(value, await importEd25519PrivateKey(keyBytes)); }
    finally { keyBytes.fill(0); }
  }

  async createManagedDestinationBinding(prepared: PreparedTargetKeys, address: string,
    issuedAt: number): Promise<Uint8Array> {
    if (prepared.custodyProfile !== "managed" || !prepared.identityPublicKey ||
      canonicalizeHailAddress(address) !== address ||
      address.slice(address.indexOf("@") + 1) !== new URL(prepared.destinationServiceBase).hostname ||
      !Number.isSafeInteger(issuedAt) || issuedAt < 0) {
      throw new Error("Managed destination binding does not match prepared identity and domain");
    }
    await this.assertOwnership(prepared);
    const row = (await this.sql<TargetKeyRow[]>`SELECT identity_public_key,identity_private_ciphertext,identity_nonce
      FROM prepared_migration_target_keys WHERE transfer_id=${prepared.transferId}`)[0];
    if (!row?.identity_public_key || !row.identity_private_ciphertext || !row.identity_nonce ||
      row.identity_public_key !== prepared.identityPublicKey) throw new Error("Managed target identity key missing");
    const keyBytes = await this.encryptor.decrypt(prepared.transferId, "hail-identity", "ed25519",
      row.identity_public_key, { ciphertext: row.identity_private_ciphertext, nonce: row.identity_nonce,
        encryptionVersion: 1, kekId: "poc-v1" });
    const binding: HailAddressBinding = { type: "hail.address-binding", version: 1, address, did: prepared.did,
      issued_at: issuedAt, expires_at: issuedAt + 90 * 86400, key_id: `${prepared.did}#hail-identity` };
    try { return signPayload("hail.address-binding", binding,
      createWebCryptoSigner(binding.key_id, await importEd25519PrivateKey(keyBytes))); }
    finally { keyBytes.fill(0); }
  }

  async finalRequest(prepared: PreparedTargetKeys, offerSigned: SignedHandshake,
    selectionSigned: SignedHandshake, receiptSigned: SignedHandshake,
    userIdentityKey: string): Promise<SignedHandshake> {
    const offer = await verifyHandshake(offerSigned, "hail.transfer-offer", prepared.messagingPublicKey);
    const selection = await verifyHandshake(selectionSigned, "hail.transfer-address-selection",
      userIdentityKey);
    const receipt = await verifyHandshake(receiptSigned, "hail.transfer-reservation", prepared.messagingPublicKey);
    if (offer.did !== prepared.did || offer.transfer_id !== prepared.transferId ||
      offer.destination_messaging_key !== prepared.messagingPublicKey ||
      selection.did !== offer.did || selection.transfer_id !== offer.transfer_id ||
      selection.nonce !== offer.nonce ||
      !sameDigest(selection.grant_digest, offer.grant_digest) ||
      receipt.did !== offer.did || receipt.transfer_id !== offer.transfer_id ||
      receipt.nonce !== offer.nonce ||
      receipt.address !== selection.address ||
      !sameDigest(selection.offer_digest, handshakeDigest(offerSigned.payloadBytes)) ||
      !sameDigest(receipt.offer_digest, handshakeDigest(offerSigned.payloadBytes)) ||
      !sameDigest(receipt.selection_digest, handshakeDigest(selectionSigned.payloadBytes))) {
      throw new Error("Final request does not match the address reservation");
    }
    const now = Math.floor(Date.now() / 1000);
    if (selection.expires_at <= now || receipt.expires_at <= now || offer.expires_at <= now) {
      throw new Error("Transfer address reservation has expired");
    }
    const request: TransferRequest = { ...offer, type: "hail.transfer-request", version: 1,
      offer_digest: handshakeDigest(offerSigned.payloadBytes),
      destination_address: selection.address,
      selection_digest: handshakeDigest(selectionSigned.payloadBytes),
      reservation_digest: handshakeDigest(receiptSigned.payloadBytes),
      issued_at: now, expires_at: Math.min(now + 300, offer.expires_at) };
    return this.signWithPreparedMessaging(prepared, request);
  }

  private async signWithPreparedMessaging(prepared: PreparedTargetKeys,
    value: TransferOffer | TransferRequest | TransferReservation): Promise<SignedHandshake> {
    await this.assertOwnership(prepared);
    const rows = await this.sql<TargetKeyRow[]>`
      SELECT messaging_public_key, messaging_private_ciphertext, messaging_nonce
      FROM prepared_migration_target_keys WHERE transfer_id = ${prepared.transferId}`;
    const row = rows[0];
    if (!row || row.messaging_public_key !== prepared.messagingPublicKey) throw new Error("Target key missing");
    const keyBytes = await this.encryptor.decrypt(prepared.transferId, "hail-messaging", "ed25519",
      row.messaging_public_key, { ciphertext: row.messaging_private_ciphertext,
        nonce: row.messaging_nonce, encryptionVersion: 1, kekId: "poc-v1" });
    try { return await signHandshake(value, await importEd25519PrivateKey(keyBytes)); }
    finally { keyBytes.fill(0); }
  }

  async signReservation(prepared: PreparedTargetKeys, value: TransferReservation): Promise<SignedHandshake> {
    return this.signWithPreparedMessaging(prepared, value);
  }

  async assertOwnership(expected: PreparedTargetKeys): Promise<void> {
    const rows = await this.sql<TargetKeyRow[]>`
      SELECT did, destination_service_base, rotation_public_key, rotation_private_ciphertext,
        rotation_nonce, messaging_public_key, messaging_private_ciphertext, messaging_nonce, state,custody_profile,
        identity_public_key,identity_private_ciphertext,identity_nonce
      FROM prepared_migration_target_keys WHERE transfer_id = ${expected.transferId}
    `;
    const row = rows[0];
    if (!row || !["prepared", "staged"].includes(row.state) ||
      row.did !== expected.did || row.destination_service_base !== expected.destinationServiceBase ||
      row.rotation_public_key !== expected.rotationPublicKey ||
      row.messaging_public_key !== expected.messagingPublicKey||row.custody_profile!==(expected.custodyProfile??"portable")||
      row.identity_public_key!==(expected.identityPublicKey??null)) {
      throw new Error("Destination does not own the requested prepared operational keys");
    }
    const rotation = await this.encryptor.decrypt(expected.transferId, "plc-rotation", "p256", row.rotation_public_key, {
      ciphertext: row.rotation_private_ciphertext, nonce: row.rotation_nonce, encryptionVersion: 1, kekId: "poc-v1",
    });
    const messaging = await this.encryptor.decrypt(expected.transferId, "hail-messaging", "ed25519", row.messaging_public_key, {
      ciphertext: row.messaging_private_ciphertext, nonce: row.messaging_nonce, encryptionVersion: 1, kekId: "poc-v1",
    });
    const identity=row.custody_profile==="managed"&&row.identity_public_key&&row.identity_private_ciphertext&&row.identity_nonce?
      await this.encryptor.decrypt(expected.transferId,"hail-identity","ed25519",row.identity_public_key,{ciphertext:row.identity_private_ciphertext,
        nonce:row.identity_nonce,encryptionVersion:1,kekId:"poc-v1"}):null;
    try {
      if ((await P256Keypair.import(rotation)).did() !== row.rotation_public_key) {
        throw new Error("Destination rotation private key does not match its public DID key");
      }
      const privateKey = await importEd25519PrivateKey(messaging);
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const signature = await crypto.subtle.sign("Ed25519", privateKey, challenge);
      if (!await crypto.subtle.verify("Ed25519", await ed25519PublicKeyFromDidKey(row.messaging_public_key),
        signature, challenge)) {
        throw new Error("Destination messaging private key does not match its public DID key");
      }
      if(identity&&row.identity_public_key) {
        const identityKey=await importEd25519PrivateKey(identity),identitySignature=await crypto.subtle.sign("Ed25519",identityKey,challenge);
        if(!await crypto.subtle.verify("Ed25519",await ed25519PublicKeyFromDidKey(row.identity_public_key),identitySignature,challenge))
          throw new Error("Destination identity private key does not match its public DID key");
      }
    } finally { rotation.fill(0); messaging.fill(0);identity?.fill(0); }
  }
}
