// Shared by hailp and browser signup. Keep filesystem, network and Node imports out.
import { P256Keypair } from "@atproto/crypto";
import { decodeBase64Url, encodeBase64Url } from "@hailproto/codec/base64url";
import { base58btc } from "multiformats/bases/base58";

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

export function bytes(value: Uint8Array): Uint8Array<ArrayBuffer> { return Uint8Array.from(value); }
function aad(role: Role, didKey: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`hail-user-vault-v1\0${role}\0${didKey}`);
}
export async function cipher(secret: Uint8Array): Promise<CryptoKey> {
  if (secret.length !== 32) throw new Error("Vault recovery secret must be exactly 256 bits");
  return crypto.subtle.importKey("raw", bytes(secret), "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function seal(key: CryptoKey, role: Role, publicDidKey: string, privateBytes: Uint8Array): Promise<EncryptedUserKey> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bytes(nonce),
    additionalData: aad(role, publicDidKey), tagLength: 128 }, key, bytes(privateBytes)));
  return { role, publicDidKey, nonce: encodeBase64Url(nonce), ciphertext: encodeBase64Url(ciphertext) };
}
export async function unseal(key: CryptoKey, value: EncryptedUserKey, role: Role): Promise<Uint8Array> {
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
  const recoverySecret = crypto.getRandomValues(new Uint8Array(32));
  const key = await cipher(recoverySecret);
  const recoveryBytes = await recovery.export();
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
    recoverySecret };
}

export function validateVault(vault: UserVaultFile): void {
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

export async function unlockIdentityKey(vault: UserVaultFile, key: CryptoKey): Promise<CryptoKey> {
  const identityBytes = await unseal(key, vault.identity, "hail-identity");
  try {
    const identity = await crypto.subtle.importKey("pkcs8", bytes(identityBytes), "Ed25519", false, ["sign"]);
    const publicBytes = base58btc.decode(vault.identity.publicDidKey.slice("did:key:".length));
    if (publicBytes.length !== 34 || publicBytes[0] !== 0xed || publicBytes[1] !== 0x01) throw new Error("Vault public keys do not match private keys");
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const signature = await crypto.subtle.sign("Ed25519", identity, challenge);
    const publicKey = await crypto.subtle.importKey("raw", bytes(publicBytes.slice(2)), "Ed25519", false, ["verify"]);
    if (!await crypto.subtle.verify("Ed25519", publicKey, signature, challenge)) {
      throw new Error("Vault identity private key does not match its public key");
    }
    return identity;
  } finally { identityBytes.fill(0); }
}

// Verifies an exported backup without returning or retaining an unlocked signer.
export async function verifyUserVault(vault: UserVaultFile, secret: Uint8Array): Promise<void> {
  validateVault(vault);
  const key = await cipher(secret), recoveryBytes = await unseal(key, vault.recovery, "user-recovery");
  try {
    const recovery = await P256Keypair.import(recoveryBytes);
    if (recovery.did() !== vault.recovery.publicDidKey) throw new Error("Vault public keys do not match private keys");
    await unlockIdentityKey(vault, key);
  } finally { recoveryBytes.fill(0); }
}
