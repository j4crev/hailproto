import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { cidForCbor } from "@atproto/common";
import { assureValidSig, def, type Operation } from "@did-plc/lib";
import * as dagCbor from "@ipld/dag-cbor";
import { createWebCryptoVerifier, decodeBase64Url, decodeDeterministic, encodeBase64Url,
  verifySignedPayload,
  type HailAddressBinding } from "@hailproto/codec";
import { base58btc } from "multiformats/bases/base58";
import { unlockUserVault, type UserMigrationConsent, type UserVaultFile } from "./vault.js";
import { readRecoverySecret } from "./cli/private-input.js";
import { privateFile,savePrivateBytes as save } from "./grant-revocation.js";
async function existingPrivateFile(path: string, limit: number): Promise<Uint8Array | null> {
  try { return await privateFile(path, limit); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
function data(bytes: Uint8Array): Record<string, unknown> {
  const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Invalid cutover file");
  return decoded as Record<string, unknown>;
}
export async function verifySignature(kind: string, payload: Uint8Array,
  signature: Uint8Array, didKey: string): Promise<void> {
  const keyBytes = base58btc.decode(didKey.slice("did:key:".length));
  if (keyBytes.length !== 34 || keyBytes[0] !== 0xed || keyBytes[1] !== 0x01) {
    throw new Error("Cutover signer is not an Ed25519 DID key");
  }
  const publicKey = await crypto.subtle.importKey("raw", Uint8Array.from(keyBytes.slice(2)),
    "Ed25519", false, ["verify"]);
  const prefix = new TextEncoder().encode(`${kind}\0`);
  const input = new Uint8Array(prefix.length + payload.length);
  input.set(prefix); input.set(payload, prefix.length);
  if (!await crypto.subtle.verify("Ed25519", publicKey,
    Uint8Array.from(signature), Uint8Array.from(input))) {
    throw new Error("Cutover record is not signed by the expected key");
  }
}

export async function verifyTransferSnapshot(snapshot:Record<string,unknown>) {
  if(!snapshot||typeof snapshot!=="object"||Array.isArray(snapshot)||Object.keys(snapshot).sort().join(",")!=="digest,manifest,signature,sourceMessagingPublicKey,type,version"||
    snapshot.type!=="hail.portable-migration-transfer"||![2,3].includes(snapshot.version as number)||typeof snapshot.manifest!=="string"||typeof snapshot.digest!=="string"||
    typeof snapshot.signature!=="string"||typeof snapshot.sourceMessagingPublicKey!=="string")throw new Error("Source did not supply a signed portable snapshot");
  const manifestBytes=decodeBase64Url(snapshot.manifest),digest=new Uint8Array(createHash("sha256").update(manifestBytes).digest());
  if(manifestBytes.length>67108864||decodeBase64Url(snapshot.digest).length!==32||decodeBase64Url(snapshot.signature).length!==64||
    !Buffer.from(digest).equals(Buffer.from(decodeBase64Url(snapshot.digest))))throw new Error("Source snapshot digest mismatch or size limit exceeded");
  const manifest=data(manifestBytes);
  if(manifest.version!==snapshot.version)throw new Error("Snapshot container and manifest versions differ");
  await verifySignature(`hail-migration-snapshot-v${snapshot.version}`,digest,decodeBase64Url(snapshot.signature),snapshot.sourceMessagingPublicKey);
  return {manifest,digest};
}

export async function signPrivatePocCutover(vaultPath:string,snapshotPath:string,offerRow:Record<string,unknown>,receiptRow:Record<string,unknown>,
  consentPath:string,operationPath:string,bindingPath:string,recoveryInput=readRecoverySecret) {
const secret = decodeBase64Url(await recoveryInput());
try {
  const vault = JSON.parse(new TextDecoder().decode(await privateFile(vaultPath, 16_384))) as UserVaultFile;
  const user = await unlockUserVault(vault, secret);
  if (!vault.did) throw new Error("POC cutover needs a vault bound to the original private-PLC DID");
  const snapshot = data(await privateFile(snapshotPath, 100_000_000));
  const verified=await verifyTransferSnapshot(snapshot),digest=verified.digest;
  const manifest = verified.manifest as {
    did: string; transferId: string; sourceServiceBase: string;
    destinationServiceBase: string; destinationRotationPublicKey: string;
    destinationMessagingPublicKey: string; tables: {
      account_keys: { role: string; public_key: string }[];
      portable_custody_evidence: { user_recovery_public_key: string;
        user_identity_public_key: string; monitor_verification_mode: string }[];
      plc_operation_evidence: { operation_cid: string; expected_state: unknown }[];
    } };
  const custody = manifest.tables.portable_custody_evidence[0];
  const oldKey = manifest.tables.account_keys.find((item) => item.role === "plc-rotation")?.public_key;
  const evidence = manifest.tables.plc_operation_evidence.at(-1);
  if (manifest.did !== vault.did || !custody || custody.monitor_verification_mode !== "poc-local" ||
    custody.user_identity_public_key !== vault.identity.publicDidKey ||
    custody.user_recovery_public_key !== vault.recovery.publicDidKey || !oldKey || !evidence) {
    throw new Error("POC snapshot is not for this user-held recovery and identity key");
  }
  const prior = (typeof evidence.expected_state === "string" ?
    JSON.parse(evidence.expected_state) : evidence.expected_state) as {
      rotationKeys: string[]; verificationMethods: Record<string, string>;
      alsoKnownAs: string[]; services: Record<string, { type: string; endpoint: string }> };
  if (!Array.isArray(prior.rotationKeys) || prior.rotationKeys[0] !== vault.recovery.publicDidKey ||
    prior.verificationMethods["hail-identity"] !== vault.identity.publicDidKey ||
    prior.verificationMethods["hail-messaging"] !== snapshot.sourceMessagingPublicKey ||
    prior.services.hail?.endpoint !== manifest.sourceServiceBase ||
    !prior.rotationKeys.includes(oldKey) || !Array.isArray(prior.alsoKnownAs)) {
    throw new Error("Original PLC state no longer agrees with the user vault and source snapshot");
  }
  if (typeof offerRow.payload !== "string" || typeof offerRow.signature !== "string" ||
    typeof receiptRow.payload !== "string" || typeof receiptRow.signature !== "string") {
    throw new Error("Offer or address reservation lacks a signed representation");
  }
  const offerBytes = decodeBase64Url(offerRow.payload);
  const offer = decodeDeterministic(offerBytes) as unknown as {
    did: string; transfer_id: string; source_service_base: string;
    destination_service_base: string; destination_rotation_key: string;
    destination_messaging_key: string };
  if (offer.did !== manifest.did || offer.transfer_id !== manifest.transferId ||
    offer.source_service_base !== manifest.sourceServiceBase ||
    offer.destination_service_base !== manifest.destinationServiceBase ||
    offer.destination_rotation_key !== manifest.destinationRotationPublicKey ||
    offer.destination_messaging_key !== manifest.destinationMessagingPublicKey) {
    throw new Error("Origin-verified Offer does not match the exact snapshot destination");
  }
  await verifySignature("hail.transfer-offer.v1", offerBytes,
    decodeBase64Url(offerRow.signature), offer.destination_messaging_key);
  const receiptBytes = decodeBase64Url(receiptRow.payload);
  const receipt = decodeDeterministic(receiptBytes) as unknown as {
    did: string; transfer_id: string; address: string; offer_digest: Uint8Array };
  if (receipt.did !== vault.did || receipt.transfer_id !== manifest.transferId ||
    !Buffer.from(receipt.offer_digest).equals(createHash("sha256").update(offerBytes).digest()) ||
    receipt.address.slice(receipt.address.indexOf("@") + 1) !==
      new URL(manifest.destinationServiceBase).hostname) {
    throw new Error("Destination reservation is not the user-approved Hail address");
  }
  await verifySignature("hail.transfer-reservation.v1", receiptBytes,
    decodeBase64Url(receiptRow.signature), offer.destination_messaging_key);
  const rotationKeys = [...prior.rotationKeys.filter((key) => key !== oldKey),
    manifest.destinationRotationPublicKey];
  const unsigned = { type: "plc_operation" as const, prev: evidence.operation_cid,
    rotationKeys, verificationMethods: { ...prior.verificationMethods,
      "hail-messaging": manifest.destinationMessagingPublicKey },
    alsoKnownAs: prior.alsoKnownAs, services: { ...prior.services,
      hail: { type: "HailMessaging", endpoint: manifest.destinationServiceBase } },
  };
  let operation: Operation;
  let dagCborBytes: Uint8Array;
  let operationCid: string;
  const previousOperation = await existingPrivateFile(operationPath, 16_000);
  const priorConsent = await existingPrivateFile(consentPath, 16_384);
  const priorBinding = await existingPrivateFile(bindingPath, 16_384);
  if(!previousOperation&&(priorConsent||priorBinding)||!priorConsent&&priorBinding) {
    throw new Error("Retained cutover artifacts are incomplete; restore the original operation/consent instead of signing replacements");
  }
  if (previousOperation) {
    operation = def.operation.parse(data(previousOperation));
    if (!isDeepStrictEqual({ type: operation.type, prev: operation.prev,
      rotationKeys: operation.rotationKeys, verificationMethods: operation.verificationMethods,
      alsoKnownAs: operation.alsoKnownAs, services: operation.services }, unsigned)) {
      throw new Error("Retained signed PLC operation is for another transfer or snapshot");
    }
    await assureValidSig([vault.recovery.publicDidKey], operation);
    dagCborBytes = new Uint8Array(dagCbor.encode(operation));
    operationCid = (await cidForCbor(operation)).toString();
  } else {
    const signed = await user.signPlcOperation(unsigned);
    if (signed.did !== vault.did) throw new Error("Signed cutover changed the DID");
    operation = signed.operation;
    dagCborBytes = signed.dagCbor;
    operationCid = signed.cid;
    // Save the exact operation first so a restart never signs a competing
    // operation after a consent has already committed to its DAG-CBOR hash.
    await save(operationPath, new TextEncoder().encode(JSON.stringify(operation)));
  }
  const now = Math.floor(Date.now() / 1000);
  const expectedConsent: UserMigrationConsent = {
    type: "hail.portable-migration-consent", version: 1, did: vault.did,
    transfer_id: manifest.transferId, snapshot_digest: digest,
    plc_operation_sha256: new Uint8Array(createHash("sha256").update(dagCborBytes).digest()),
    source_service_base: manifest.sourceServiceBase,
    destination_service_base: manifest.destinationServiceBase,
    destination_address: receipt.address,
    destination_rotation_key: manifest.destinationRotationPublicKey,
    destination_messaging_key: manifest.destinationMessagingPublicKey,
    user_recovery_key: vault.recovery.publicDidKey,
    user_identity_key: vault.identity.publicDidKey, created_at: now, expires_at: now + 3600,
  };
  if (priorConsent) {
    const stored = data(priorConsent);
    if (stored.type !== "hail.portable-migration-consent" || stored.version !== 1 ||
      typeof stored.payload !== "string" || typeof stored.signature !== "string") {
      throw new Error("Retained migration consent container is invalid");
    }
    const bytes = decodeBase64Url(stored.payload);
    await verifySignature("hail.portable-migration-consent.v1", bytes,
      decodeBase64Url(stored.signature), vault.identity.publicDidKey);
    const value = decodeDeterministic(bytes) as unknown as UserMigrationConsent;
    if (value.expires_at <= now || !isDeepStrictEqual({ ...value,
      created_at: expectedConsent.created_at, expires_at: expectedConsent.expires_at }, expectedConsent)) {
      throw new Error("Retained migration consent is stale or commits to another operation");
    }
  } else {
    const signedConsent = await user.signMigrationConsent(expectedConsent);
    await save(consentPath, new TextEncoder().encode(JSON.stringify({
      type: "hail.portable-migration-consent", version: 1,
      payload: encodeBase64Url(signedConsent.payloadBytes),
      signature: encodeBase64Url(signedConsent.signature),
    })));
  }
  if (priorBinding) {
    const publicBytes = base58btc.decode(vault.identity.publicDidKey.slice("did:key:".length));
    if (publicBytes.length !== 34 || publicBytes[0] !== 0xed || publicBytes[1] !== 0x01) {
      throw new Error("User identity key is not an Ed25519 DID key");
    }
    const verified = await verifySignedPayload("hail.address-binding", priorBinding,
      createWebCryptoVerifier(async (kid) => {
        if (kid !== `${vault.did}#hail-identity`) throw new Error("Old binding has another identity signer");
        return crypto.subtle.importKey("raw", Uint8Array.from(publicBytes.slice(2)),
          "Ed25519", false, ["verify"]);
      }));
    if (verified.payload.address !== receipt.address || verified.payload.did !== vault.did ||
      verified.payload.expires_at <= now) {
      throw new Error("Retained destination binding does not match this transfer");
    }
  } else {
    await save(bindingPath, await user.signAddressBinding({ type: "hail.address-binding", version: 1,
      address: receipt.address, did: vault.did, issued_at: now,
      expires_at: now + 90 * 86400, key_id: `${vault.did}#hail-identity` }));
  }
  return { did: vault.did, transferId: manifest.transferId,
    address: receipt.address, operationCid, profile: "private-poc" };
} finally { secret.fill(0); }
}
