import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { cidForCbor } from "@atproto/common";
import { P256Keypair, parseDidKey, P256_JWT_ALG, SECP256K1_JWT_ALG } from "@atproto/crypto";
import { assureValidSig, def, didForCreateOp, signOperation, type DocumentData, type Operation, type UnsignedOperation } from "@did-plc/lib";
import { isIP } from "node:net";
import { createWebCryptoSigner, decodeBase64Url, encodeBase64Url, encodeDeterministic, signPayload,
  type HailAddressBinding, type HailGrant, type HailValue } from "@hailproto/codec";
import * as dagCbor from "@ipld/dag-cbor";
import { base58btc } from "multiformats/bases/base58";
import { accountAccessInput, type AccountAccessChallenge } from "./account-access-proof.js";

type Role = "user-recovery" | "hail-identity";

export interface EncryptedUserKey {
  role: Role;
  publicDidKey: string;
  nonce: string;
  ciphertext: string;
}

export interface UserVaultFile {
  type: "hail.user-vault";
  version: 1;
  did: string | null;
  createdAt: string;
  recovery: EncryptedUserKey;
  identity: EncryptedUserKey;
}

export interface VaultCreation { vault: UserVaultFile; recoverySecret: Uint8Array; }

// Reference new-genesis subset of the candidate managed-custody v1 profile.
// This checks public roles/state, not physical custody or production PLC trust.
export function reviewManagedGenesis(input: UnsignedOperation, vault: UserVaultFile): UnsignedOperation {
  const operation = def.unsignedOperation.parse(input);
  const identity = operation.verificationMethods["hail-identity"], messaging = operation.verificationMethods["hail-messaging"];
  if (operation.prev !== null || operation.rotationKeys.length !== 2 ||
    operation.rotationKeys[0] !== vault.recovery.publicDidKey || operation.alsoKnownAs.length ||
    Object.keys(operation.verificationMethods).length !== 2 || Object.keys(operation.services).length !== 1 ||
    operation.services.hail?.type !== "HailMessaging" || !identity || !messaging ||
    new Set([...operation.rotationKeys, identity, messaging]).size !== 4 ||
    [...operation.rotationKeys, identity, messaging].includes(vault.identity.publicDidKey)) {
    throw new Error("Managed genesis requires four distinct reviewed owner/provider roles and no unexpected state");
  }
  for (const key of [identity, messaging]) {
    if (!key.startsWith("did:key:")) throw new Error("Managed Hail keys must be Ed25519 did:key values");
    const raw = base58btc.decode(key.slice(8));
    if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 1) throw new Error("Managed Hail keys must be Ed25519 did:key values");
  }
  if (![P256_JWT_ALG, SECP256K1_JWT_ALG].includes(parseDidKey(operation.rotationKeys[1]!).jwtAlg)) {
    throw new Error("Managed provider rotation must use a PLC-supported key");
  }
  const endpoint = operation.services.hail.endpoint, url = new URL(endpoint);
  const path = url.pathname === "/" ? "" : url.pathname;
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || isIP(url.hostname) ||
    url.hostname.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) || endpoint !== `${url.origin}${path}` ||
    path && path.slice(1).split("/").some(segment => !/^[A-Za-z0-9._~-]+$/.test(segment) || segment === "." || segment === "..")) {
    throw new Error("Managed genesis service must be a canonical HTTPS Hail service base");
  }
  return operation;
}

export interface UserMigrationConsent {
  type: "hail.portable-migration-consent";
  version: 1;
  did: string;
  transfer_id: string;
  snapshot_digest: Uint8Array;
  plc_operation_sha256: Uint8Array;
  source_service_base: string;
  destination_service_base: string;
  destination_address: string;
  destination_rotation_key: string;
  destination_messaging_key: string;
  user_recovery_key: string;
  user_identity_key: string;
  created_at: number;
  expires_at: number;
}

export interface UserTransferGrant {
  type: "hail.transfer-grant";
  version: 1;
  did: string;
  nonce: string;
  source_service_base: string;
  destination_service_base: string;
  destination_domain: string;
  issued_at: number;
  expires_at: number;
}

export interface UserTransferAddressSelection {
  type: "hail.transfer-address-selection"; version: 1; did: string; nonce: string;
  transfer_id: string; grant_digest: Uint8Array; offer_digest: Uint8Array;
  address: string; selection_nonce: string; issued_at: number; expires_at: number;
}

export interface UserTransferCancellation {
  type: "hail.transfer-cancellation"; version: 1; did: string; nonce: string;
  grant_digest: Uint8Array; issued_at: number; expires_at: number;
}
export interface ManagedTransferGrant {
  type:"hail.managed-transfer-grant";version:1;did:string;nonce:string;source_service_base:string;
  destination_service_base:string;destination_domain:string;owner_recovery_key:string;source_identity_key:string;
  issued_at:number;expires_at:number;
}
export interface ManagedTransferAddressSelection {
  type:"hail.managed-transfer-address-selection";version:1;did:string;nonce:string;transfer_id:string;
  grant_digest:Uint8Array;offer_digest:Uint8Array;address:string;selection_nonce:string;issued_at:number;expires_at:number;
}
export interface ManagedTransferApproval {
  type:"hail.managed-transfer-approval";version:1;did:string;nonce:string;transfer_id:string;
  source_service_base:string;destination_service_base:string;destination_address:string;owner_recovery_key:string;
  source_identity_key:string;destination_rotation_key:string;destination_identity_key:string;destination_messaging_key:string;
  grant_digest:Uint8Array;offer_digest:Uint8Array;selection_digest:Uint8Array;snapshot_version:4;
  snapshot_digest:Uint8Array;history_checkpoint_digest:Uint8Array;source_generation:number;
  previous_operation_cid:string;operation_cid:string;issued_at:number;expires_at:number;
}
export interface UserTransferRecoveryApproval {
  type:"hailp.transfer-abandon"|"hailp.transfer-resume";version:1;did:string;transfer_id:string;
  source_service_base:string;destination_service_base:string;source_generation:number;snapshot_digest:Uint8Array;
  cutover_operation_cid:string;user_recovery_key:string;nonce:string;issued_at:number;expires_at:number;
  protective_operation_cid?:string;invalidation_digest?:Uint8Array;
}
export interface ManagedCustodyTransitionPreparation {
  transitionId:string;accountId:string;did:string;direction:"owner-to-managed"|"managed-to-owner";
  ownerRecoveryKey:string;oldIdentityKey:string;newIdentityKey:string;
  providerServiceBase:string;currentState:DocumentData;unsignedOperation:UnsignedOperation;previousOperationCid:string;
  historyCheckpointDigest:Uint8Array;bindingDigest:Uint8Array;generationFrom:number;generationTo:number;expiresAt:string;
}
export interface ManagedCustodyTransitionApproval {
  type:"hailp.custody-transition";version:1;transition_id:string;did:string;direction:"owner-to-managed"|"managed-to-owner";
  provider_service_base:string;owner_recovery_key:string;old_identity_key:string;new_identity_key:string;
  previous_operation_cid:string;operation_cid:string;history_checkpoint_sha256:Uint8Array;binding_sha256:Uint8Array;
  generation_from:number;generation_to:number;nonce:string;issued_at:number;expires_at:number;
}

function bytes(value: Uint8Array): Uint8Array<ArrayBuffer> { return Uint8Array.from(value); }
function aad(role: Role, didKey: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`hail-user-vault-v1\0${role}\0${didKey}`);
}
async function cipher(secret: Uint8Array): Promise<CryptoKey> {
  if (secret.length !== 32) throw new Error("Vault recovery secret must be exactly 256 bits");
  return crypto.subtle.importKey("raw", bytes(secret), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(key: CryptoKey, role: Role, publicDidKey: string, privateBytes: Uint8Array): Promise<EncryptedUserKey> {
  const nonce = randomBytes(12);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bytes(nonce),
    additionalData: aad(role, publicDidKey), tagLength: 128 }, key, bytes(privateBytes)));
  return { role, publicDidKey, nonce: encodeBase64Url(nonce), ciphertext: encodeBase64Url(ciphertext) };
}
async function unseal(key: CryptoKey, value: EncryptedUserKey, role: Role): Promise<Uint8Array> {
  if (value.role !== role || typeof value.publicDidKey !== "string") throw new Error("Vault role mismatch");
  const nonce = decodeBase64Url(value.nonce);
  const ciphertext = decodeBase64Url(value.ciphertext);
  if (nonce.length !== 12 || ciphertext.length < 17) throw new Error("Vault ciphertext or nonce is invalid");
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(nonce),
    additionalData: aad(role, value.publicDidKey), tagLength: 128 }, key, bytes(ciphertext)));
}

export async function createUserVault(): Promise<VaultCreation> {
  const recovery = await P256Keypair.create({ exportable: true });
  const identity = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const prefixed = new Uint8Array(34);
  prefixed.set([0xed, 0x01]);
  prefixed.set(new Uint8Array(await crypto.subtle.exportKey("raw", identity.publicKey)), 2);
  const identityDidKey = `did:key:${base58btc.encode(prefixed)}`;
  const recoverySecret = randomBytes(32);
  const key = await cipher(recoverySecret);
  const recoveryBytes = new Uint8Array(await recovery.export());
  const identityBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", identity.privateKey));
  let sealedRecovery;
  let sealedIdentity;
  try {
    [sealedRecovery, sealedIdentity] = await Promise.all([
      seal(key, "user-recovery", recovery.did(), recoveryBytes),
      seal(key, "hail-identity", identityDidKey, identityBytes),
    ]);
  } finally { recoveryBytes.fill(0); identityBytes.fill(0); }
  return { vault: { type: "hail.user-vault", version: 1, did: null,
    createdAt: new Date().toISOString(), recovery: sealedRecovery, identity: sealedIdentity },
    recoverySecret: bytes(recoverySecret) };
}

function validateVault(vault: UserVaultFile): void {
  if (!vault || typeof vault !== "object" || Array.isArray(vault) ||
    Object.keys(vault).length !== 6 || Object.keys(vault).some(key =>
      !["type", "version", "did", "createdAt", "recovery", "identity"].includes(key)) ||
    vault.type !== "hail.user-vault" || vault.version !== 1 ||
    (vault.did !== null && !/^did:plc:[a-z2-7]{24}$/.test(vault.did)) ||
    typeof vault.createdAt !== "string" || !Number.isFinite(Date.parse(vault.createdAt))) throw new Error("Invalid user vault representation");
  for (const [record, role] of [[vault.recovery, "user-recovery"], [vault.identity, "hail-identity"]] as const) {
    if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).length !== 4 ||
      Object.keys(record).some(key => !["role", "publicDidKey", "nonce", "ciphertext"].includes(key)) ||
      record.role !== role || typeof record.publicDidKey !== "string" || record.publicDidKey.length > 256 ||
      !/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(record.publicDidKey) ||
      typeof record.nonce !== "string" || typeof record.ciphertext !== "string") throw new Error("Invalid vault key record");
  }
  if (vault.recovery.publicDidKey === vault.identity.publicDidKey) throw new Error("Invalid user vault representation");
}

async function unlockIdentityKey(vault: UserVaultFile, key: CryptoKey): Promise<CryptoKey> {
  const identityBytes = await unseal(key, vault.identity, "hail-identity");
  try {
    const identity = await crypto.subtle.importKey("pkcs8", bytes(identityBytes), "Ed25519", false, ["sign"]);
    const publicBytes = base58btc.decode(vault.identity.publicDidKey.slice("did:key:".length));
    if (publicBytes.length !== 34 ||
      publicBytes[0] !== 0xed || publicBytes[1] !== 0x01) throw new Error("Vault public keys do not match private keys");
    const challenge = randomBytes(32);
    const signature = await crypto.subtle.sign("Ed25519", identity, bytes(challenge));
    const publicKey = await crypto.subtle.importKey("raw", bytes(publicBytes.slice(2)), "Ed25519", false, ["verify"]);
    if (!await crypto.subtle.verify("Ed25519", publicKey, signature, bytes(challenge))) {
      throw new Error("Vault identity private key does not match its public key");
    }
    return identity;
  } finally { identityBytes.fill(0); }
}

function signUserGrant(vault: UserVaultFile, identity: CryptoKey, payload: HailGrant): Promise<Uint8Array> {
  if (!vault.did || payload.grantor !== vault.did ||
    payload.key_id !== `${vault.did}#hail-identity`) throw new Error("Grant signer DID is not the user vault");
  return signPayload("hail.grant", payload, createWebCryptoSigner(payload.key_id, identity));
}

function signUserBinding(vault: UserVaultFile, identity: CryptoKey, payload: HailAddressBinding): Promise<Uint8Array> {
  if (!vault.did || payload.did !== vault.did || payload.key_id !== `${vault.did}#hail-identity`) throw new Error("Binding signer DID is not the user vault");
  return signPayload("hail.address-binding", payload, createWebCryptoSigner(payload.key_id, identity));
}

async function signTransferIntent(vault:UserVaultFile,key:CryptoKey,value:UserTransferGrant|UserTransferCancellation|UserTransferAddressSelection,kind:typeof value.type) {
  if(!vault.did||value.did!==vault.did||value.type!==kind||value.version!==1||!Number.isSafeInteger(value.issued_at)||!Number.isSafeInteger(value.expires_at)||
    value.expires_at<=value.issued_at||value.expires_at-value.issued_at>3600)throw new Error("Transfer intent must name this DID and one short-lived approval");
  if(value.type==="hail.transfer-grant") {
    if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value.nonce)||
      value.destination_service_base!==`https://${value.destination_domain}/hail`||value.source_service_base===value.destination_service_base)throw new Error("Transfer grant must select one destination");
  } else if(value.grant_digest.length!==32||value.type==="hail.transfer-address-selection"&&value.offer_digest.length!==32)throw new Error("Transfer intent must bind the exact transfer grant and Offer");
  const payloadBytes=encodeDeterministic(value as unknown as HailValue),tag=new TextEncoder().encode(`${value.type}.v1\0`);
  const input=new Uint8Array(tag.length+payloadBytes.length);input.set(tag);input.set(payloadBytes,tag.length);
  return {payloadBytes,signature:new Uint8Array(await crypto.subtle.sign("Ed25519",key,bytes(input)))};
}

export async function unlockUserIdentity(vault: UserVaultFile, secret: Uint8Array):
  Promise<Pick<UnlockedUserVault, "vault" | "signGrant" | "signAddressBinding" | "signTransferGrant" | "signTransferCancellation" | "signTransferAddressSelection"> & { signAccountAccess(challenge: AccountAccessChallenge): Promise<Uint8Array> }> {
  validateVault(vault);
  const identity = await unlockIdentityKey(vault, await cipher(secret));
  return { vault, signGrant: async payload => signUserGrant(vault, identity, payload),
    signAddressBinding: async payload => signUserBinding(vault, identity, payload),
    signTransferGrant:async payload=>signTransferIntent(vault,identity,payload,"hail.transfer-grant"),
    signTransferCancellation:async payload=>signTransferIntent(vault,identity,payload,"hail.transfer-cancellation"),
    signTransferAddressSelection:async payload=>signTransferIntent(vault,identity,payload,"hail.transfer-address-selection"),
    async signAccountAccess(challenge) {
      const input = accountAccessInput(challenge);
      if (!vault.did || challenge.did !== vault.did || challenge.signer !== "identity" || challenge.publicKey !== vault.identity.publicDidKey) throw new Error("Login proof does not match this identity");
      return new Uint8Array(await crypto.subtle.sign("Ed25519", identity, bytes(input)));
    } };
}

export async function unlockUserVault(vault: UserVaultFile, recoverySecret: Uint8Array): Promise<UnlockedUserVault> {
  validateVault(vault);
  const key = await cipher(recoverySecret);
  const rotationBytes = await unseal(key, vault.recovery, "user-recovery");
  try {
    // The official P-256 keypair may retain its input buffer. Pass a distinct
    // copy so clearing our temporary decrypted bytes does not zero the signer.
    const recovery = await P256Keypair.import(bytes(rotationBytes));
    if (recovery.did() !== vault.recovery.publicDidKey) throw new Error("Vault public keys do not match private keys");
    return new UnlockedUserVault(vault, recovery, await unlockIdentityKey(vault, key));
  } finally { rotationBytes.fill(0); }
}

export async function replaceUserIdentity(vault: UserVaultFile, recoverySecret: Uint8Array): Promise<UnlockedUserVault> {
  validateVault(vault);
  if (!vault.did) throw new Error("Custody transition requires a bound user vault");
  const key = await cipher(recoverySecret);
  const rotationBytes = await unseal(key, vault.recovery, "user-recovery");
  const generated = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", generated.privateKey));
  try {
    const recovery = await P256Keypair.import(bytes(rotationBytes));
    if (recovery.did() !== vault.recovery.publicDidKey) throw new Error("Vault public keys do not match private keys");
    const prefixed = new Uint8Array(34);prefixed.set([0xed,0x01]);
    prefixed.set(new Uint8Array(await crypto.subtle.exportKey("raw",generated.publicKey)),2);
    const publicDidKey=`did:key:${base58btc.encode(prefixed)}`;
    if(publicDidKey===vault.identity.publicDidKey)throw new Error("Fresh owner identity generation failed");
    const next:UserVaultFile={...vault,identity:await seal(key,"hail-identity",publicDidKey,privateBytes)};
    return new UnlockedUserVault(next,recovery,generated.privateKey);
  } finally {rotationBytes.fill(0);privateBytes.fill(0);}
}

export class UnlockedUserVault {
  constructor(readonly vault: UserVaultFile, private readonly recovery: P256Keypair,
    private readonly identity: CryptoKey) {}

  async signAccountRecovery(challenge: AccountAccessChallenge): Promise<Uint8Array> {
    const input = accountAccessInput(challenge);
    if (!this.vault.did || challenge.did !== this.vault.did || challenge.signer !== "owner-recovery" ||
      challenge.publicKey !== this.vault.recovery.publicDidKey) throw new Error("Recovery proof does not match the reviewed owner key");
    return this.recovery.sign(input);
  }
  async signTransferRecoveryApproval(approval:UserTransferRecoveryApproval) {
    if(!this.vault.did||approval.did!==this.vault.did||approval.user_recovery_key!==this.vault.recovery.publicDidKey||
      !["hailp.transfer-abandon","hailp.transfer-resume"].includes(approval.type)||approval.version!==1||!Number.isSafeInteger(approval.source_generation)||approval.source_generation<1||
      approval.snapshot_digest.length!==32||!Number.isSafeInteger(approval.issued_at)||!Number.isSafeInteger(approval.expires_at)||
      approval.expires_at<=approval.issued_at||approval.expires_at-approval.issued_at>3600||approval.source_service_base===approval.destination_service_base||
      approval.type==="hailp.transfer-resume"&&(!approval.protective_operation_cid||approval.invalidation_digest?.length!==32))throw new Error("Recovery approval must bind this owner and one exact private transfer");
    const payloadBytes=encodeDeterministic(approval as unknown as HailValue),tag=new TextEncoder().encode(`${approval.type}.v1\0`),input=new Uint8Array(tag.length+payloadBytes.length);
    input.set(tag);input.set(payloadBytes,tag.length);return {payloadBytes,signature:await this.recovery.sign(input)};
  }

  async signManagedTransferOwnerIntent(value:ManagedTransferGrant|ManagedTransferAddressSelection|ManagedTransferApproval,
    operation?:Operation) {
    if(!this.vault.did||value.did!==this.vault.did||value.version!==1||
      !["hail.managed-transfer-grant","hail.managed-transfer-address-selection","hail.managed-transfer-approval"].includes(value.type)||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value.nonce)||
      !Number.isSafeInteger(value.issued_at)||!Number.isSafeInteger(value.expires_at)||value.expires_at<=value.issued_at||
      value.expires_at-value.issued_at>3600)throw new Error("Managed transfer intent must name this DID and one short-lived approval");
    if(value.type==="hail.managed-transfer-grant") {
      if(value.owner_recovery_key!==this.vault.recovery.publicDidKey||value.source_service_base===value.destination_service_base||
        value.destination_service_base!==`https://${value.destination_domain}/hail`||value.source_identity_key===value.owner_recovery_key)
        throw new Error("Managed transfer grant must bind this owner and one destination");
    } else if(value.grant_digest.length!==32||value.offer_digest.length!==32||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value.transfer_id)) {
      throw new Error("Managed transfer intent must bind the exact grant and Offer");
    } else if(value.type==="hail.managed-transfer-approval") {
      const keys=[value.owner_recovery_key,value.source_identity_key,value.destination_rotation_key,
        value.destination_identity_key,value.destination_messaging_key];
      if(value.owner_recovery_key!==this.vault.recovery.publicDidKey||new Set(keys).size!==keys.length||
        value.selection_digest.length!==32||value.snapshot_version!==4||value.snapshot_digest.length!==32||
        value.history_checkpoint_digest.length!==32||!Number.isSafeInteger(value.source_generation)||value.source_generation<1||
        !value.previous_operation_cid||!value.operation_cid||value.previous_operation_cid===value.operation_cid)
        throw new Error("Managed transfer approval must bind the exact v4 cutover and current owner");
      if(!operation||operation.prev!==value.previous_operation_cid||operation.rotationKeys.length!==2||
        operation.rotationKeys[0]!==value.owner_recovery_key||operation.rotationKeys[1]!==value.destination_rotation_key||
        operation.verificationMethods["hail-identity"]!==value.destination_identity_key||
        operation.verificationMethods["hail-messaging"]!==value.destination_messaging_key||
        operation.services.hail?.type!=="HailMessaging"||operation.services.hail.endpoint!==value.destination_service_base||
        (await cidForCbor(operation)).toString()!==value.operation_cid||
        await assureValidSig([this.vault.recovery.publicDidKey],operation)!==this.vault.recovery.publicDidKey)
        throw new Error("Managed transfer approval differs from the exact owner-signed cutover operation");
    }
    const payloadBytes=encodeDeterministic(value as unknown as HailValue),tag=new TextEncoder().encode(`${value.type}.v1\0`);
    const input=new Uint8Array(tag.length+payloadBytes.length);input.set(tag);input.set(payloadBytes,tag.length);
    return {payloadBytes,signature:await this.recovery.sign(input)};
  }

  async signPlcOperation(unsigned: UnsignedOperation): Promise<{ operation: Operation;
    dagCbor: Uint8Array; cid: string; did: string }> {
    if (unsigned.rotationKeys[0] !== this.vault.recovery.publicDidKey ||
      unsigned.verificationMethods["hail-identity"] !== this.vault.identity.publicDidKey ||
      !Array.isArray(unsigned.alsoKnownAs)) {
      throw new Error("PLC state must preserve the user's top key, identity role and aliases");
    }
    const operation = await signOperation(unsigned, this.recovery);
    const did = unsigned.prev === null ? await didForCreateOp(operation) : this.vault.did;
    if (!did || !/^did:plc:[a-z2-7]{24}$/.test(did)) throw new Error("PLC update requires a bound DID");
    const dagCborBytes = new Uint8Array(dagCbor.encode(operation));
    if (dagCborBytes.length > 7500) throw new Error("PLC operation exceeds the directory limit");
    return { operation, dagCbor: dagCborBytes, cid: (await cidForCbor(operation)).toString(), did };
  }

  async signManagedTransferCutover(currentState: DocumentData, previousOperationCid: string,
    sourceRotationPublicKey: string, destinationRotationPublicKey: string,
    destinationIdentityPublicKey: string, destinationMessagingPublicKey: string,
    destinationServiceBase: string): Promise<{ operation: Operation; operationBytes: Uint8Array;
      dagCbor: Uint8Array; cid: string; did: string }> {
    const current = def.documentData.parse(currentState);
    if (!this.vault.did || current.did !== this.vault.did ||
      current.rotationKeys[0] !== this.vault.recovery.publicDidKey ||
      sourceRotationPublicKey === this.vault.recovery.publicDidKey ||
      !current.rotationKeys.includes(sourceRotationPublicKey)) {
      throw new Error("Managed cutover requires this bound owner and the current source rotation role");
    }
    const destinationKeys = [destinationRotationPublicKey, destinationIdentityPublicKey,
      destinationMessagingPublicKey];
    const currentKeys = new Set([...current.rotationKeys, ...Object.values(current.verificationMethods)]);
    if (new Set(destinationKeys).size !== destinationKeys.length ||
      destinationKeys.some(key => currentKeys.has(key))) {
      throw new Error("Managed cutover destination roles must be distinct and fresh");
    }
    if (![P256_JWT_ALG, SECP256K1_JWT_ALG].includes(parseDidKey(destinationRotationPublicKey).jwtAlg)) {
      throw new Error("Managed destination rotation must use a PLC-supported key");
    }
    for (const key of [destinationIdentityPublicKey, destinationMessagingPublicKey]) {
      if (!key.startsWith("did:key:")) throw new Error("Managed destination Hail roles must use Ed25519 did:key values");
      const raw = base58btc.decode(key.slice("did:key:".length));
      if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 0x01) {
        throw new Error("Managed destination Hail roles must use Ed25519 did:key values");
      }
    }
    const url = new URL(destinationServiceBase), path = url.pathname === "/" ? "" : url.pathname;
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || isIP(url.hostname) ||
      url.hostname.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ||
      destinationServiceBase !== `${url.origin}${path}` ||
      path && path.slice(1).split("/").some(segment => !/^[A-Za-z0-9._~-]+$/.test(segment) || segment === "." || segment === "..")) {
      throw new Error("Managed destination service must be a canonical HTTPS Hail service base");
    }
    const unsigned = def.unsignedOperation.parse({ type: "plc_operation", prev: previousOperationCid,
      rotationKeys: [...current.rotationKeys.filter(key => key !== sourceRotationPublicKey), destinationRotationPublicKey],
      verificationMethods: { ...current.verificationMethods, "hail-identity": destinationIdentityPublicKey,
        "hail-messaging": destinationMessagingPublicKey },
      alsoKnownAs: current.alsoKnownAs,
      services: { ...current.services, hail: { type: "HailMessaging", endpoint: destinationServiceBase } } });
    const operation = await signOperation(unsigned, this.recovery);
    const dagCborBytes = new Uint8Array(dagCbor.encode(operation));
    if (dagCborBytes.length > 7500) throw new Error("PLC operation exceeds the directory limit");
    return { operation, operationBytes: new TextEncoder().encode(JSON.stringify(operation)),
      dagCbor: dagCborBytes, cid: (await cidForCbor(operation)).toString(), did: this.vault.did };
  }

  async signManagedCustodyTransition(prepared:ManagedCustodyTransitionPreparation) {
    const now=Math.floor(Date.now()/1000),expiry=Math.floor(new Date(prepared.expiresAt).getTime()/1000);
    const current=def.documentData.parse(prepared.currentState),unsigned=def.unsignedOperation.parse(prepared.unsignedOperation);
    if(!prepared.newIdentityKey.startsWith("did:key:"))throw new Error("Managed custody identity must be an Ed25519 did:key value");
    const identityBytes=base58btc.decode(prepared.newIdentityKey.slice("did:key:".length));
    const expected=def.unsignedOperation.parse({type:"plc_operation",prev:prepared.previousOperationCid,
      rotationKeys:current.rotationKeys,verificationMethods:{...current.verificationMethods,"hail-identity":prepared.newIdentityKey},
      alsoKnownAs:current.alsoKnownAs,services:current.services});
    if(!this.vault.did||prepared.did!==this.vault.did||!["owner-to-managed","managed-to-owner"].includes(prepared.direction)||
      prepared.ownerRecoveryKey!==this.vault.recovery.publicDidKey||
      (prepared.direction==="owner-to-managed"?prepared.oldIdentityKey!==this.vault.identity.publicDidKey:prepared.newIdentityKey!==this.vault.identity.publicDidKey)||
      current.did!==prepared.did||current.rotationKeys[0]!==this.vault.recovery.publicDidKey||
      current.verificationMethods["hail-identity"]!==prepared.oldIdentityKey||!isDeepStrictEqual(unsigned,expected)||
      identityBytes.length!==34||identityBytes[0]!==0xed||identityBytes[1]!==0x01||prepared.newIdentityKey===prepared.oldIdentityKey||
      prepared.historyCheckpointDigest.length!==32||prepared.bindingDigest.length!==32||
      prepared.generationTo!==prepared.generationFrom+1||!Number.isSafeInteger(expiry)||expiry<=now)
      throw new Error("Managed custody preparation does not match this bound owner vault");
    const operation=await signOperation(unsigned,this.recovery);
    const operationBytes=new TextEncoder().encode(JSON.stringify(operation));
    if(new Uint8Array(dagCbor.encode(operation)).length>7500)throw new Error("PLC operation exceeds the directory limit");
    const operationCid=(await cidForCbor(operation)).toString();
    const approval:ManagedCustodyTransitionApproval={type:"hailp.custody-transition",version:1,
      transition_id:prepared.transitionId,did:prepared.did,direction:prepared.direction,provider_service_base:prepared.providerServiceBase,
      owner_recovery_key:prepared.ownerRecoveryKey,old_identity_key:prepared.oldIdentityKey,new_identity_key:prepared.newIdentityKey,
      previous_operation_cid:prepared.previousOperationCid,operation_cid:operationCid,
      history_checkpoint_sha256:Uint8Array.from(prepared.historyCheckpointDigest),binding_sha256:Uint8Array.from(prepared.bindingDigest),
      generation_from:prepared.generationFrom,generation_to:prepared.generationTo,nonce:randomUUID(),issued_at:now,
      expires_at:Math.min(now+3600,expiry)};
    const approvalBytes=encodeDeterministic(approval as unknown as HailValue),tag=new TextEncoder().encode("hailp.custody-transition.v1\0");
    const input=new Uint8Array(tag.length+approvalBytes.length);input.set(tag);input.set(approvalBytes,tag.length);
    return {operation,operationBytes,operationCid,approval,approvalBytes,approvalSignature:await this.recovery.sign(input)};
  }

  async signManagedGenesis(unsigned: UnsignedOperation) {
    if (this.vault.did !== null) throw new Error("Bound vault cannot authorize another managed genesis; retain the original signup state");
    const operation = await signOperation(reviewManagedGenesis(unsigned, this.vault),this.recovery);
    if (dagCbor.encode(operation).length > 7500) throw new Error("PLC operation exceeds the directory limit");
    return {operation,did:await didForCreateOp(operation)};
  }

  async bindDid(did: string, signedGenesis: Operation, managed = false): Promise<UserVaultFile> {
    if (this.vault.did !== null || signedGenesis.prev !== null ||
      signedGenesis.rotationKeys[0] !== this.vault.recovery.publicDidKey ||
      (!managed && signedGenesis.verificationMethods["hail-identity"] !== this.vault.identity.publicDidKey) ||
      !/^did:plc:[a-z2-7]{24}$/.test(did)) throw new Error("Cannot bind vault to this DID");
    if (managed) {
      const { sig, ...unsigned } = signedGenesis;
      reviewManagedGenesis(unsigned, this.vault);
      if (dagCbor.encode(signedGenesis).length > 7500) throw new Error("PLC operation exceeds the directory limit");
    }
    await assureValidSig([this.vault.recovery.publicDidKey], signedGenesis);
    if (await didForCreateOp(signedGenesis) !== did) throw new Error("Vault DID does not match exact signed genesis");
    this.vault.did = did;
    return this.vault;
  }

  async signGrant(payload: HailGrant): Promise<Uint8Array> {
    return signUserGrant(this.vault, this.identity, payload);
  }

  async signTransferGrant(grant: UserTransferGrant): Promise<{
    payloadBytes: Uint8Array; signature: Uint8Array }> {
    return signTransferIntent(this.vault,this.identity,grant,"hail.transfer-grant");
  }

  async signTransferAddressSelection(selection: UserTransferAddressSelection): Promise<{
    payloadBytes: Uint8Array; signature: Uint8Array }> {
    return signTransferIntent(this.vault,this.identity,selection,"hail.transfer-address-selection");
  }

  async signTransferCancellation(cancellation: UserTransferCancellation): Promise<{
    payloadBytes: Uint8Array; signature: Uint8Array }> {
    return signTransferIntent(this.vault,this.identity,cancellation,"hail.transfer-cancellation");
  }

  async signAddressBinding(payload: HailAddressBinding): Promise<Uint8Array> {
    return signUserBinding(this.vault, this.identity, payload);
  }

  signMigrationConsent(consent: UserMigrationConsent): Promise<{
    payloadBytes: Uint8Array; signature: Uint8Array }> {
    if (!this.vault.did || consent.did !== this.vault.did ||
      consent.user_identity_key !== this.vault.identity.publicDidKey ||
      consent.user_recovery_key !== this.vault.recovery.publicDidKey) {
      throw new Error("Migration consent does not match the bound user identity");
    }
    return signMigrationConsentBytes(consent, this.identity);
  }
}

async function signMigrationConsentBytes(consent: UserMigrationConsent, key: CryptoKey) {
  const payloadBytes = encodeDeterministic(consent as unknown as HailValue);
  const tag = new TextEncoder().encode("hail.portable-migration-consent.v1\0");
  const message = new Uint8Array(tag.length + payloadBytes.length);
  message.set(tag);
  message.set(payloadBytes, tag.length);
  return { payloadBytes,
    signature: new Uint8Array(await crypto.subtle.sign("Ed25519", key, bytes(message))) };
}
