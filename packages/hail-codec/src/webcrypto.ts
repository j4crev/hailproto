import { HailCodecError } from "./errors.js";
import type { HailSigner, HailVerifier } from "./types.js";

export type HailPublicKeyResolver = (keyId: string) => CryptoKey | Promise<CryptoKey>;

function requireEd25519Key(key: CryptoKey, usage: KeyUsage): void {
  if (key.algorithm.name !== "Ed25519" || !key.usages.includes(usage)) {
    throw new HailCodecError(
      "wrong-key-role",
      `CryptoKey must be an Ed25519 key with ${usage} usage`,
    );
  }
}

export function createWebCryptoSigner(
  keyId: string,
  privateKey: CryptoKey,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): HailSigner {
  requireEd25519Key(privateKey, "sign");
  return {
    keyId,
    async sign(data) {
      return new Uint8Array(
        await subtle.sign("Ed25519", privateKey, Uint8Array.from(data)),
      );
    },
  };
}

export function createWebCryptoVerifier(
  resolve: HailPublicKeyResolver,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): HailVerifier {
  return {
    async verify(data, signature, keyId) {
      const publicKey = await resolve(keyId);
      requireEd25519Key(publicKey, "verify");
      return subtle.verify(
        "Ed25519",
        publicKey,
        Uint8Array.from(signature),
        Uint8Array.from(data),
      );
    },
  };
}
