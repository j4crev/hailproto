import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { assureValidSig, def, didForCreateOp, type Operation } from "@did-plc/lib";
import { createWebCryptoVerifier, decodeBase64Url, encodeBase64Url,
  verifySignedPayload, type HailAddressBinding } from "@hailproto/codec";
import { base58btc } from "multiformats/bases/base58";
import { unlockUserVault, type UserVaultFile } from "../vault.js";
import { readRecoverySecret } from "./private-input.js";

async function privateFile(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size < 1 || info.size > 32_768 || (info.mode & 0o077) !== 0) {
    throw new Error("POC vault/preparation must be a bounded private mode-0600 regular file");
  }
  return readFile(path, "utf8");
}
const [vaultPath, preparationPath, outputPath] = Bun.argv.slice(2);
if (!vaultPath || !preparationPath || !outputPath || Bun.argv.length !== 5) {
  throw new Error("Usage: bun run poc:sign-onboarding -- <private-vault-file> <provider-preparation-file> <new-client-signed-output-file>");
}
const prepared = JSON.parse(await privateFile(preparationPath)) as {
  accountId: string; address: string; userRecoveryKey: string; userIdentityKey: string;
  providerRotationKey: string; providerMessagingKey: string; sourceServiceBase: string };
if (!/^https:\/\/hailproto\.(app|dev)\/hail$/.test(prepared.sourceServiceBase) ||
  prepared.address.slice(prepared.address.indexOf("@") + 1) !==
    new URL(prepared.sourceServiceBase).hostname) {
  throw new Error("POC preparation must name the matching provider address and service");
}
const secret = decodeBase64Url(await readRecoverySecret());
try {
  const vault = JSON.parse(await privateFile(vaultPath)) as UserVaultFile;
  if (vault.recovery.publicDidKey !== prepared.userRecoveryKey ||
    vault.identity.publicDidKey !== prepared.userIdentityKey) {
    throw new Error("POC preparation does not match the user-controlled vault");
  }
  const originallyUnbound = vault.did === null;
  const signer = await unlockUserVault(vault, secret);
  const unsigned = { type: "plc_operation" as const, prev: null,
    rotationKeys: [prepared.userRecoveryKey, prepared.providerRotationKey],
    verificationMethods: { "hail-identity": prepared.userIdentityKey,
      "hail-messaging": prepared.providerMessagingKey },
    alsoKnownAs: [], services: { hail: { type: "HailMessaging", endpoint: prepared.sourceServiceBase } },
  };
  let signedOperation: Operation;
  let did: string;
  try {
    const existing = JSON.parse(await privateFile(outputPath)) as {
      accountId: string; did: string; operation: unknown; bindingCose: string };
    signedOperation = def.operation.parse(existing.operation);
    did = await didForCreateOp(signedOperation);
    if (existing.accountId !== prepared.accountId || existing.did !== did ||
      !isDeepStrictEqual({ type: signedOperation.type, prev: signedOperation.prev,
        rotationKeys: signedOperation.rotationKeys,
        verificationMethods: signedOperation.verificationMethods,
        alsoKnownAs: signedOperation.alsoKnownAs, services: signedOperation.services }, unsigned)) {
      throw new Error("Existing POC onboarding output is for another provider preparation");
    }
    await assureValidSig([prepared.userRecoveryKey], signedOperation);
    const publicBytes = base58btc.decode(prepared.userIdentityKey.slice("did:key:".length));
    if (publicBytes.length !== 34 || publicBytes[0] !== 0xed || publicBytes[1] !== 0x01) {
      throw new Error("POC identity key must be Ed25519");
    }
    const signedBinding = decodeBase64Url(existing.bindingCose);
    const verified = await verifySignedPayload("hail.address-binding", signedBinding,
      createWebCryptoVerifier(async (kid) => {
        if (kid !== `${did}#hail-identity`) throw new Error("POC binding has another signer");
        return crypto.subtle.importKey("raw", Uint8Array.from(publicBytes.slice(2)),
          "Ed25519", false, ["verify"]);
      }));
    if (verified.payload.address !== prepared.address || verified.payload.did !== did) {
      throw new Error("Existing POC binding names another address or DID");
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    if (vault.did !== null) throw new Error("Bound vault needs its original signed genesis output");
    const signed = await signer.signPlcOperation(unsigned);
    signedOperation = signed.operation;
    did = signed.did;
    await signer.bindDid(did, signedOperation);
    const now = Math.floor(Date.now() / 1000);
    const binding: HailAddressBinding = { type: "hail.address-binding", version: 1,
      address: prepared.address, did, issued_at: now,
      expires_at: now + 90 * 86400, key_id: `${did}#hail-identity` };
    const signedBinding = await signer.signAddressBinding(binding);
    const output = JSON.stringify({ accountId: prepared.accountId, did,
      operation: signedOperation, bindingCose: encodeBase64Url(signedBinding) });
    const file = await open(outputPath, "wx", 0o600);
    let incomplete = false;
    try { await file.writeFile(output); }
    catch (writeError) { incomplete = true; throw writeError; }
    finally { await file.close(); if (incomplete) await unlink(outputPath); }
  }
  if (vault.did !== null && vault.did !== did) throw new Error("Vault is bound to a different DID");
  if (originallyUnbound) {
    if (signer.vault.did === null) await signer.bindDid(did, signedOperation);
    const temporary = `${vaultPath}.tmp-${randomUUID()}`;
    const replacement = await open(temporary, "wx", 0o600);
    let complete = false;
    try {
      await replacement.writeFile(JSON.stringify(signer.vault));
      await replacement.sync();
      await replacement.close();
      await rename(temporary, vaultPath);
      complete = true;
    } finally {
      if (!complete) { await replacement.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
    }
  }
  console.info(JSON.stringify({ did, accountId: prepared.accountId,
    address: prepared.address, outputFile: outputPath, profile: "private-poc" }));
} finally { secret.fill(0); }
