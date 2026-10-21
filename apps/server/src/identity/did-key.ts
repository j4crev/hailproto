import { base58btc } from "multiformats/bases/base58";

export async function ed25519PublicKeyFromDidKey(didKey: string): Promise<CryptoKey> {
  if (!didKey.startsWith("did:key:")) throw new Error("Expected an Ed25519 did:key");
  const prefixed = base58btc.decode(didKey.slice("did:key:".length));
  if (prefixed.length !== 34 || prefixed[0] !== 0xed || prefixed[1] !== 0x01) {
    throw new Error("Expected an Ed25519 did:key");
  }
  return crypto.subtle.importKey("raw", prefixed.slice(2), "Ed25519", false, ["verify"]);
}
