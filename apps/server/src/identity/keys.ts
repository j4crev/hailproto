import { P256Keypair } from "@atproto/crypto";
import { base58btc } from "multiformats/bases/base58";
import type {
  AccountKeyAlgorithm,
  AccountKeyRole,
  EncryptedKeyMaterial,
} from "./key-encryption.js";
import { KeyEncryptor } from "./key-encryption.js";

export interface StoredAccountKey extends EncryptedKeyMaterial {
  role: AccountKeyRole;
  algorithm: AccountKeyAlgorithm;
  publicKey: string;
}

export interface GeneratedAccountKeys {
  rotationKey: P256Keypair;
  identityPrivateKey: CryptoKey;
  keys: [StoredAccountKey, StoredAccountKey, StoredAccountKey];
  rotationDidKey: string;
  identityDidKey: string;
  messagingDidKey: string;
}

export interface GeneratedAccountIdentityKey {
  privateKey: CryptoKey;
  key: StoredAccountKey;
  didKey: string;
}

function ed25519DidKey(publicKey: CryptoKey): Promise<string> {
  return crypto.subtle.exportKey("raw", publicKey).then((value) => {
    const raw = new Uint8Array(value);
    if (raw.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
    const prefixed = new Uint8Array(34);
    prefixed.set([0xed, 0x01]);
    prefixed.set(raw, 2);
    return `did:key:${base58btc.encode(prefixed)}`;
  });
}

async function generateEd25519(): Promise<{
  privateKey: CryptoKey;
  privateBytes: Uint8Array;
  didKey: string;
}> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  return {
    privateKey: pair.privateKey,
    privateBytes: new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    didKey: await ed25519DidKey(pair.publicKey),
  };
}

export async function generateAccountIdentityKey(
  accountId: string,
  encryptor: KeyEncryptor,
): Promise<GeneratedAccountIdentityKey> {
  const identity = await generateEd25519();
  try {
    const encrypted = await encryptor.encrypt(
      accountId,
      "hail-identity",
      "ed25519",
      identity.didKey,
      identity.privateBytes,
    );
    return {
      privateKey: identity.privateKey,
      didKey: identity.didKey,
      key: {
        role: "hail-identity",
        algorithm: "ed25519",
        publicKey: identity.didKey,
        ...encrypted,
      },
    };
  } finally {
    identity.privateBytes.fill(0);
  }
}

export async function generateAccountKeys(
  accountId: string,
  encryptor: KeyEncryptor,
): Promise<GeneratedAccountKeys> {
  const [rotationKey, identity, messaging] = await Promise.all([
    P256Keypair.create({ exportable: true }),
    generateEd25519(),
    generateEd25519(),
  ]);
  const rotationDidKey = rotationKey.did();
  const rotationBytes = await rotationKey.export();

  const [encryptedRotation, encryptedIdentity, encryptedMessaging] = await Promise.all([
    encryptor.encrypt(accountId, "plc-rotation", "p256", rotationDidKey, rotationBytes),
    encryptor.encrypt(accountId, "hail-identity", "ed25519", identity.didKey, identity.privateBytes),
    encryptor.encrypt(
      accountId,
      "hail-messaging",
      "ed25519",
      messaging.didKey,
      messaging.privateBytes,
    ),
  ]);

  const publicKeys = new Set([rotationDidKey, identity.didKey, messaging.didKey]);
  if (publicKeys.size !== 3) throw new Error("Generated account keys must be distinct");

  return {
    rotationKey,
    identityPrivateKey: identity.privateKey,
    rotationDidKey,
    identityDidKey: identity.didKey,
    messagingDidKey: messaging.didKey,
    keys: [
      {
        role: "plc-rotation",
        algorithm: "p256",
        publicKey: rotationDidKey,
        ...encryptedRotation,
      },
      {
        role: "hail-identity",
        algorithm: "ed25519",
        publicKey: identity.didKey,
        ...encryptedIdentity,
      },
      {
        role: "hail-messaging",
        algorithm: "ed25519",
        publicKey: messaging.didKey,
        ...encryptedMessaging,
      },
    ],
  };
}

export async function importEd25519PrivateKey(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", Uint8Array.from(pkcs8), "Ed25519", false, ["sign"]);
}
