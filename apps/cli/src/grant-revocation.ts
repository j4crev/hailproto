import { createHash } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { createWebCryptoVerifier, inspectSignedPayload, verifySignedPayload, type HailGrant } from "@hailproto/codec";
import { base58btc } from "multiformats/bases/base58";
import { unlockUserIdentity, type UserVaultFile } from "./vault.js";

export async function privateFile(path: string, limit: number): Promise<Uint8Array> {
  const info = await stat(path);
  if (!info.isFile() || info.size < 1 || info.size > limit || (info.mode & 0o077) !== 0) {
    throw new Error("Client files must be bounded private mode-0600 regular files");
  }
  return new Uint8Array(await readFile(path));
}

export async function savePrivateBytes(path: string, bytes: Uint8Array): Promise<void> {
  const file = await open(path, "wx", 0o600);
  let incomplete = false;
  try { await file.writeFile(bytes); await file.sync(); }
  catch (error) { incomplete = true; throw error; }
  finally { await file.close(); if (incomplete) await unlink(path); }
}

export async function signGrantRevocation(vaultPath: string, currentBytes: Uint8Array,
  expectedGrantId: string, expectedSenderAddress: string, outputPath: string, secret: Uint8Array,
  expectedDid?: string): Promise<Uint8Array> {
  const user = await unlockUserIdentity(JSON.parse(new TextDecoder().decode(
    await privateFile(vaultPath, 16_384))) as UserVaultFile, secret);
  if (!user.vault.did || expectedDid !== undefined && user.vault.did !== expectedDid) {
    throw new Error("Grant revocation needs the authenticated account's user vault");
  }
  const publicBytes = base58btc.decode(user.vault.identity.publicDidKey.slice("did:key:".length));
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(publicBytes.slice(2)), "Ed25519", false, ["verify"]);
  const verifier = createWebCryptoVerifier(async (kid) => {
    if (kid !== `${user.vault.did}#hail-identity`) throw new Error("Grant identity signer does not match this user");
    return key;
  });
  const { payload: current } = await verifySignedPayload("hail.grant", currentBytes, verifier);
  if (current.grantor !== user.vault.did || current.grant_id !== expectedGrantId ||
    current.consent_context.grantee_address !== expectedSenderAddress) {
    throw new Error("Current Grant does not match the user's reviewed relationship");
  }
  let existing: Uint8Array | null = null;
  try { existing = await privateFile(outputPath, 262_144); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  let representation: Uint8Array;
  if (current.status === "revoked") {
    if (existing && !Buffer.from(existing).equals(Buffer.from(currentBytes))) {
      throw new Error("Existing signed revocation conflicts with the provider's terminal Grant");
    }
    representation = currentBytes;
  } else {
    const now = Math.floor(Date.now() / 1000);
    const updatedAt = existing ? inspectSignedPayload("hail.grant", existing).payload.updated_at :
      Math.max(now, current.updated_at + 1);
    if (updatedAt <= current.updated_at || updatedAt > now + 300) throw new Error("Revocation timestamp is invalid");
    const payload: HailGrant = { ...current, revision: current.revision + 1,
      previous: new Uint8Array(createHash("sha256").update(currentBytes).digest()),
      status: "revoked", updated_at: updatedAt };
    representation = existing ?? await user.signGrant(payload);
    const verified = await verifySignedPayload("hail.grant", representation, verifier);
    if (!isDeepStrictEqual(verified.payload, payload)) throw new Error("Existing signed revocation conflicts with this Grant");
  }
  if (!existing) await savePrivateBytes(outputPath, representation);
  return representation;
}
