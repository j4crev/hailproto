import { createHash, randomUUID } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { decodeBase64Url, decodeDeterministic, encodeBase64Url } from "@hailproto/codec";
import { base58btc } from "multiformats/bases/base58";
import { unlockUserVault, type UserTransferAddressSelection, type UserVaultFile } from "../vault.js";
import { readRecoverySecret } from "./private-input.js";

interface SignedRecord { payloadBytes: Uint8Array; signature: Uint8Array }
const media = "application/hail-transfer+json";
function record(value: unknown): SignedRecord {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== 2 || !("payload" in value) || !("signature" in value) ||
    typeof value.payload !== "string" || typeof value.signature !== "string") {
    throw new Error("Invalid signed transfer file");
  }
  const payloadBytes = decodeBase64Url(value.payload);
  const signature = decodeBase64Url(value.signature);
  if (payloadBytes.length < 1 || payloadBytes.length > 4096 || signature.length !== 64) {
    throw new Error("Signed transfer file exceeds the representation limit");
  }
  return { payloadBytes, signature };
}
async function privateFile(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size < 1 || info.size > 16_384 || (info.mode & 0o077) !== 0) {
    throw new Error("Transfer and vault files must be private regular files with mode 0600");
  }
  return readFile(path, "utf8");
}
async function verify(record: SignedRecord, kind: string, didKey: string): Promise<void> {
  const bytes = base58btc.decode(didKey.slice("did:key:".length));
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) {
    throw new Error("Transfer signer is not an Ed25519 did:key");
  }
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(bytes.slice(2)), "Ed25519", false, ["verify"]);
  const tag = new TextEncoder().encode(`${kind}.v1\0`);
  const input = new Uint8Array(tag.length + record.payloadBytes.length);
  input.set(tag); input.set(record.payloadBytes, tag.length);
  if (!await crypto.subtle.verify("Ed25519", key, Uint8Array.from(record.signature), input)) {
    throw new Error("Transfer signer did not authorize this exact record");
  }
}
async function save(path: string, signed: SignedRecord): Promise<void> {
  const file = await open(path, "wx", 0o600);
  let incomplete = false;
  try { await file.writeFile(JSON.stringify({ payload: encodeBase64Url(signed.payloadBytes),
    signature: encodeBase64Url(signed.signature) })); }
  catch (error) { incomplete = true; throw error; }
  finally { await file.close(); if (incomplete) await unlink(path); }
}

const [vaultPath, grantPath, offerPath, username, selectionPath, receiptPath] = Bun.argv.slice(2);
if (!vaultPath || !grantPath || !offerPath || !username || !selectionPath || !receiptPath || Bun.argv.length !== 8) {
  throw new Error("Usage: bun run transfer:select -- <private-vault> <signed-grant> <origin-verified-offer> <username> <new-selection-file> <new-receipt-file>");
}
if (username.length > 63 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(username) ||
  username.includes("..") || username.split(".").some((label) => label.startsWith("-") || label.endsWith("-"))) {
  throw new Error("Username must be a canonical Hail local part");
}
const secret = decodeBase64Url(await readRecoverySecret());
try {
  const user = await unlockUserVault(JSON.parse(await privateFile(vaultPath)) as UserVaultFile, secret);
  const grantSigned = record(JSON.parse(await privateFile(grantPath)) as unknown);
  const offerSigned = record(JSON.parse(await privateFile(offerPath)) as unknown);
  const grant = decodeDeterministic(grantSigned.payloadBytes) as unknown as {
    did: string; nonce: string; destination_domain: string; destination_service_base: string;
    source_service_base: string; expires_at: number };
  const offer = decodeDeterministic(offerSigned.payloadBytes) as unknown as {
    did: string; nonce: string; transfer_id: string; destination_service_base: string;
    destination_messaging_key: string; grant_digest: Uint8Array; expires_at: number };
  if (!user.vault.did || grant.did !== user.vault.did || offer.did !== grant.did ||
    offer.nonce !== grant.nonce || offer.destination_service_base !== grant.destination_service_base ||
    grant.destination_service_base !== `https://${grant.destination_domain}/hail` ||
    !/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(grant.destination_domain) ||
    offer.expires_at <= Math.floor(Date.now() / 1000) ||
    grant.expires_at <= Math.floor(Date.now() / 1000) ||
    !Buffer.from(offer.grant_digest).equals(createHash("sha256").update(grantSigned.payloadBytes).digest())) {
    throw new Error("Offer does not match the user-authorized provider domain and DID");
  }
  await verify(grantSigned, "hail.transfer-grant", user.vault.identity.publicDidKey);
  await verify(offerSigned, "hail.transfer-offer", offer.destination_messaging_key);
  const now = Math.floor(Date.now() / 1000);
  const selection: UserTransferAddressSelection = {
    type: "hail.transfer-address-selection", version: 1, did: grant.did, nonce: grant.nonce,
    transfer_id: offer.transfer_id,
    grant_digest: new Uint8Array(createHash("sha256").update(grantSigned.payloadBytes).digest()),
    offer_digest: new Uint8Array(createHash("sha256").update(offerSigned.payloadBytes).digest()),
    address: `${username}@${grant.destination_domain}`, selection_nonce: randomUUID(),
    issued_at: now, expires_at: Math.min(now + 1800, grant.expires_at, offer.expires_at),
  };
  let signed: SignedRecord;
  try {
    signed = record(JSON.parse(await privateFile(selectionPath)) as unknown);
    await verify(signed, "hail.transfer-address-selection", user.vault.identity.publicDidKey);
    const prior = decodeDeterministic(signed.payloadBytes) as unknown as UserTransferAddressSelection;
    if (prior.did !== selection.did || prior.nonce !== selection.nonce ||
      prior.transfer_id !== selection.transfer_id || prior.address !== selection.address ||
      prior.expires_at <= now ||
      !Buffer.from(prior.grant_digest).equals(Buffer.from(selection.grant_digest)) ||
      !Buffer.from(prior.offer_digest).equals(Buffer.from(selection.offer_digest))) {
      throw new Error("Existing selection does not match this live user-approved transfer");
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    signed = await user.signTransferAddressSelection(selection);
    await save(selectionPath, signed);
  }
  const url = `https://${grant.destination_domain}/.well-known/hail/transfers/reservations`;
  const response = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    credentials: "omit", headers: { "Content-Type": media, "Cache-Control": "no-store" },
    body: JSON.stringify({ payload: encodeBase64Url(signed.payloadBytes),
      signature: encodeBase64Url(signed.signature) }) });
  if (![200, 202].includes(response.status) || response.headers.get("content-type") !== media ||
    response.headers.has("content-encoding") || response.headers.has("location") ||
    Number(response.headers.get("content-length") ?? 0) > 16_384) {
    throw new Error(`Address reservation failed with HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("Reservation receipt is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 16_384) throw new Error("Reservation receipt exceeded limit");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  const receiptSigned = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown);
  await verify(receiptSigned, "hail.transfer-reservation", offer.destination_messaging_key);
  const receipt = decodeDeterministic(receiptSigned.payloadBytes) as unknown as {
    did: string; nonce: string; transfer_id: string; address: string;
    selection_digest: Uint8Array; offer_digest: Uint8Array; expires_at: number };
  if (receipt.did !== selection.did || receipt.nonce !== selection.nonce ||
    receipt.transfer_id !== selection.transfer_id || receipt.address !== selection.address ||
    receipt.expires_at <= now ||
    !Buffer.from(receipt.selection_digest).equals(createHash("sha256").update(signed.payloadBytes).digest()) ||
    !Buffer.from(receipt.offer_digest).equals(createHash("sha256").update(offerSigned.payloadBytes).digest())) {
    throw new Error("Destination signed a mismatched reservation receipt");
  }
  try {
    const priorReceipt = record(JSON.parse(await privateFile(receiptPath)) as unknown);
    if (!Buffer.from(priorReceipt.payloadBytes).equals(Buffer.from(receiptSigned.payloadBytes)) ||
      !Buffer.from(priorReceipt.signature).equals(Buffer.from(receiptSigned.signature))) {
      throw new Error("A different reservation receipt is already stored");
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    await save(receiptPath, receiptSigned);
  }
  console.info(JSON.stringify({ address: selection.address, transferId: selection.transfer_id,
    requestAcknowledged: response.status === 200 }));
} finally { secret.fill(0); }
