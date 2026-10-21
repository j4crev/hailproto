import { decodeBase64Url } from "@hailproto/codec";

export type AccountKeyRole = "plc-rotation" | "hail-identity" | "hail-messaging";
export type AccountKeyAlgorithm = "p256" | "ed25519";

export interface EncryptedKeyMaterial {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  encryptionVersion: 1;
  kekId: "poc-v1";
}

function additionalData(
  accountId: string,
  role: AccountKeyRole,
  algorithm: AccountKeyAlgorithm,
  publicKey: string,
): Uint8Array {
  return new TextEncoder().encode(
    ["hail-account-key", "1", accountId, role, algorithm, publicKey].join("\0"),
  );
}

function webCryptoBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value);
}

export class KeyEncryptor {
  readonly #key: Promise<CryptoKey>;

  constructor(base64UrlKey: string) {
    const keyBytes = decodeBase64Url(base64UrlKey);
    if (keyBytes.length !== 32) {
      throw new Error("KEY_ENCRYPTION_KEY must decode to exactly 32 bytes");
    }
    this.#key = crypto.subtle.importKey("raw", webCryptoBytes(keyBytes), "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  }

  async encrypt(
    accountId: string,
    role: AccountKeyRole,
    algorithm: AccountKeyAlgorithm,
    publicKey: string,
    plaintext: Uint8Array,
  ): Promise<EncryptedKeyMaterial> {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData: webCryptoBytes(additionalData(accountId, role, algorithm, publicKey)),
          tagLength: 128,
        },
        await this.#key,
        webCryptoBytes(plaintext),
      ),
    );
    return { ciphertext, nonce, encryptionVersion: 1, kekId: "poc-v1" };
  }

  async decrypt(
    accountId: string,
    role: AccountKeyRole,
    algorithm: AccountKeyAlgorithm,
    publicKey: string,
    material: EncryptedKeyMaterial,
  ): Promise<Uint8Array> {
    if (material.encryptionVersion !== 1 || material.kekId !== "poc-v1") {
      throw new Error("Unsupported encrypted key envelope");
    }
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: webCryptoBytes(material.nonce),
          additionalData: webCryptoBytes(additionalData(accountId, role, algorithm, publicKey)),
          tagLength: 128,
        },
        await this.#key,
        webCryptoBytes(material.ciphertext),
      ),
    );
  }
}
