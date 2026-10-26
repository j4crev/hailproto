// Portable, browser-safe envelope. The embedded v1 vault remains usable by
// existing recovery tooling after extraction, without a live provider/session.
import type { Operation } from "@did-plc/lib";
import { verifySignature } from "@atproto/crypto";
import { decodeBase64Url } from "@hailproto/codec/base64url";
import { encode } from "@ipld/dag-cbor";
import { sha256 } from "multiformats/hashes/sha2";
import { base32 } from "multiformats/bases/base32";
import { validateVault, verifyUserVault, type UserVaultFile } from "./vault-crypto.js";
import { reviewManagedGenesisRoles } from "./managed-genesis.js";

export interface RecoveryPackage {
  type: "hail.recovery-package";
  version: 1;
  vault: UserVaultFile;
  operation: Operation;
  setup: string;
}
export async function readRecoveryPackage(text: string): Promise<RecoveryPackage> {
  if (new TextEncoder().encode(text).length > 98_304) throw new Error("Recovery package is too large");
  const value = JSON.parse(text) as RecoveryPackage;
  if (!value || value.type !== "hail.recovery-package" || value.version !== 1 || Object.keys(value).length !== 5 ||
      typeof value.setup !== "string" || value.setup.length > 65_536) throw new Error("Invalid recovery package");
  validateVault(value.vault);
  const operation = value.operation;
  if (!operation || Object.keys(operation).length !== 7 ||
      Object.keys(operation).some(key=>!["type","prev","rotationKeys","verificationMethods","alsoKnownAs","services","sig"].includes(key)) ||
      typeof operation.sig !== "string" || encode(operation).length > 7500) throw new Error("Invalid recovery identity");
  const { sig, ...unsigned } = operation;
  reviewManagedGenesisRoles(unsigned, value.vault);
  if (!await verifySignature(value.vault.recovery.publicDidKey,encode(unsigned),decodeBase64Url(sig))) throw new Error("Invalid recovery signature");
  const did = `did:plc:${base32.baseEncode((await sha256.digest(encode(operation))).digest).slice(0,24)}`;
  if (!value.vault.did || did !== value.vault.did) throw new Error("Recovery package identity mismatch");
  return value;
}
export async function extractRecoveryVault(text: string, secret: Uint8Array): Promise<UserVaultFile> {
  const value = await readRecoveryPackage(text);
  await verifyUserVault(value.vault, secret);
  return value.vault;
}
