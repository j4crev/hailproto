import { createHash } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { decodeBase64Url, decodeDeterministic, encodeBase64Url } from "@hailproto/codec";
import { unlockUserVault, type UserTransferCancellation, type UserVaultFile } from "../vault.js";
import { readRecoverySecret } from "./private-input.js";

interface Signed { payloadBytes: Uint8Array; signature: Uint8Array }
async function privateFile(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size < 1 || info.size > 16_384 || (info.mode & 0o077) !== 0) {
    throw new Error("Vault and signed transfer files must be private mode-0600 regular files");
  }
  return readFile(path, "utf8");
}
function wire(value: Signed): { payload: string; signature: string } {
  return { payload: encodeBase64Url(value.payloadBytes), signature: encodeBase64Url(value.signature) };
}
function signed(value: unknown): Signed {
  if (!value || typeof value !== "object" || !("payload" in value) || !("signature" in value) ||
    typeof value.payload !== "string" || typeof value.signature !== "string") {
    throw new Error("Invalid signed cancellation record");
  }
  const payloadBytes = decodeBase64Url(value.payload);
  const signature = decodeBase64Url(value.signature);
  if (payloadBytes.length < 1 || payloadBytes.length > 4096 || signature.length !== 64) {
    throw new Error("Cancellation record exceeds limit");
  }
  return { payloadBytes, signature };
}
async function save(path: string, value: Signed): Promise<void> {
  const file = await open(path, "wx", 0o600);
  let incomplete = false;
  try { await file.writeFile(JSON.stringify(wire(value))); }
  catch (error) { incomplete = true; throw error; }
  finally { await file.close(); if (incomplete) await unlink(path); }
}
async function readBounded(response: Response): Promise<Uint8Array> {
  if (!response.body || Number(response.headers.get("content-length") ?? 0) > 16_384) {
    throw new Error("Missing or oversized cancellation response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16_384) throw new Error("Cancellation response exceeds limit");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) { result.set(part, offset); offset += part.length; }
  return result;
}

const [vaultPath, grantPath, cancellationPath, receiptPath] = Bun.argv.slice(2);
if (!vaultPath || !grantPath || !cancellationPath || !receiptPath || Bun.argv.length !== 6) {
  throw new Error("Usage: bun run transfer:cancel -- <private-vault> <signed-grant-file> <new-cancellation-file> <new-source-receipt-file>");
}
const secret = decodeBase64Url(await readRecoverySecret());
try {
  const user = await unlockUserVault(JSON.parse(await privateFile(vaultPath)) as UserVaultFile, secret);
  const grantSigned = signed(JSON.parse(await privateFile(grantPath)) as unknown);
  const grant = decodeDeterministic(grantSigned.payloadBytes) as unknown as {
    did: string; nonce: string; source_service_base: string; destination_domain: string };
  if (!user.vault.did || grant.did !== user.vault.did ||
    !/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(grant.destination_domain) ||
    !/^https:\/\/[a-z0-9.-]+\/hail$/.test(grant.source_service_base)) {
    throw new Error("Transfer cancellation requires this vault and a canonical original grant");
  }
  const grantDigest = new Uint8Array(createHash("sha256").update(grantSigned.payloadBytes).digest());
  let cancellation: Signed;
  try {
    cancellation = signed(JSON.parse(await privateFile(cancellationPath)) as unknown);
    const prior = decodeDeterministic(cancellation.payloadBytes) as unknown as UserTransferCancellation;
    if (prior.did !== grant.did || prior.nonce !== grant.nonce ||
      !Buffer.from(prior.grant_digest).equals(Buffer.from(grantDigest))) {
      throw new Error("Existing cancellation is for another transfer");
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const now = Math.floor(Date.now() / 1000);
    cancellation = await user.signTransferCancellation({ type: "hail.transfer-cancellation",
      version: 1, did: grant.did, nonce: grant.nonce, grant_digest: grantDigest,
      issued_at: now, expires_at: now + 3600 });
    await save(cancellationPath, cancellation);
  }
  let receipt: Signed;
  try { receipt = signed(JSON.parse(await privateFile(receiptPath)) as unknown); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const source = await fetch(`${grant.source_service_base}/transfers/cancellations`, {
      method: "POST", redirect: "error", credentials: "omit", signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/hail-transfer+json", "Cache-Control": "no-store" },
      body: JSON.stringify(wire(cancellation)),
    });
    if (source.status !== 200 || source.headers.get("content-type") !== "application/hail-transfer+json") {
      throw new Error(`Current provider did not confirm safe cancellation: HTTP ${source.status}`);
    }
    receipt = signed(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(source))) as unknown);
    await save(receiptPath, receipt);
  }
  const data = decodeDeterministic(receipt.payloadBytes) as unknown as {
    did: string; nonce: string; destination_domain: string; grant_digest: Uint8Array; expires_at: number };
  if (data.did !== grant.did || data.nonce !== grant.nonce ||
    data.destination_domain !== grant.destination_domain || data.expires_at <= Math.floor(Date.now() / 1000) ||
    !Buffer.from(data.grant_digest).equals(Buffer.from(grantDigest))) {
    throw new Error("Source cancellation receipt mismatches the original grant");
  }
  const target = await fetch(`https://${grant.destination_domain}/.well-known/hail/transfers/cancellations`, {
    method: "POST", redirect: "error", credentials: "omit", signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/hail-transfer+json", "Cache-Control": "no-store" },
    body: JSON.stringify({ cancellation: wire(cancellation), receipt: wire(receipt) }),
  });
  if (target.status !== 204) {
    throw new Error(`Source cancelled, but target cleanup remains pending (HTTP ${target.status}); retry these exact files`);
  }
  console.info(JSON.stringify({ did: grant.did, cancelled: true }));
} finally { secret.fill(0); }
