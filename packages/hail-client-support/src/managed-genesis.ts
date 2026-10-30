import { P256Keypair, parseDidKey, P256_JWT_ALG, SECP256K1_JWT_ALG } from "@atproto/crypto";
import type { UnsignedOperation } from "@did-plc/lib";
import { encodeBase64Url } from "@hailproto/codec/base64url";
import * as dagCbor from "@ipld/dag-cbor";
import { base32 } from "multiformats/bases/base32";
import { base58btc } from "multiformats/bases/base58";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import type { UserVaultFile } from "./vault-crypto.js";

// Shared role checks after schema validation (hailp) or construction from exact
// expected fields (browser). No provider-specific or arbitrary PLC updates.
export function reviewManagedGenesisRoles(operation: UnsignedOperation, vault: UserVaultFile): UnsignedOperation {
  const identity = operation.verificationMethods["hail-identity"], messaging = operation.verificationMethods["hail-messaging"];
  if (operation.type !== "plc_operation" || operation.prev !== null || operation.rotationKeys.length !== 2 ||
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
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname) ||
    url.hostname.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) || endpoint !== `${url.origin}${path}` ||
    path && path.slice(1).split("/").some(segment => !/^[A-Za-z0-9._~-]+$/.test(segment) || segment === "." || segment === "..")) {
    throw new Error("Managed genesis service must be a canonical HTTPS Hail service base");
  }
  return operation;
}

export async function signReviewedManagedGenesis(unsigned: UnsignedOperation, vault: UserVaultFile, recovery: P256Keypair) {
  if (vault.did !== null) throw new Error("Bound vault cannot authorize another managed genesis; retain the original signup state");
  reviewManagedGenesisRoles(unsigned, vault);
  if (recovery.did() !== vault.recovery.publicDidKey) throw new Error("Vault recovery public key differs from signer");
  const operation = { ...unsigned, sig: encodeBase64Url(await recovery.sign(dagCbor.encode(unsigned))) };
  const encoded = dagCbor.encode(operation);
  if (encoded.length > 7500) throw new Error("PLC operation exceeds the directory limit");
  const hash = await sha256.digest(encoded);
  return { operation, did: `did:plc:${base32.baseEncode(hash.digest).slice(0, 24)}`,
    cid: CID.createV1(dagCbor.code, hash).toString() };
}
