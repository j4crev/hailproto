import { createHash } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { decodeBase64Url, decodeDeterministic, encodeBase64Url } from "@hailproto/codec";
import { base58btc } from "multiformats/bases/base58";

const [grantFile, offerFile] = Bun.argv.slice(2);
if (!grantFile || !offerFile || Bun.argv.length !== 4) {
  throw new Error("Usage: bun run transfer:submit-grant -- <private-user-signed-grant-file> <new-private-offer-file>");
}
const info = await stat(grantFile);
if (!info.isFile() || info.size < 1 || info.size > 16_384 || (info.mode & 0o077) !== 0) {
  throw new Error("Transfer grant must be a bounded private regular file with mode 0600");
}
const wire: unknown = JSON.parse(await readFile(grantFile, "utf8"));
if (!wire || typeof wire !== "object" || Array.isArray(wire) || Object.keys(wire).length !== 2 ||
  !("payload" in wire) || !("signature" in wire) || typeof wire.payload !== "string" ||
  typeof wire.signature !== "string") throw new Error("Invalid signed grant file");
const grantBytes = decodeBase64Url(wire.payload);
if (grantBytes.length > 4096 || decodeBase64Url(wire.signature).length !== 64) {
  throw new Error("Signed grant exceeds its limit");
}
const grant = decodeDeterministic(grantBytes) as unknown as {
  did: string; nonce: string; destination_domain: string;
  destination_service_base: string; source_service_base: string; expires_at: number };
const now = Math.floor(Date.now() / 1000);
if (!/^did:plc:[a-z2-7]{24}$/.test(grant.did) || grant.expires_at <= now ||
  grant.destination_service_base !== `https://${grant.destination_domain}/hail` ||
  !/^https:\/\/[a-z0-9.-]+\/hail$/.test(grant.source_service_base)) {
  throw new Error("Grant must target a canonical current Hail service and public destination domain");
}
const response = await fetch(`${grant.source_service_base}/transfers/grants`, {
  method: "POST", redirect: "error", credentials: "omit", signal: AbortSignal.timeout(10_000),
  headers: { "Content-Type": "application/hail-transfer+json", "Cache-Control": "no-store" },
  body: JSON.stringify(wire),
});
if (response.status === 202) {
  console.info(JSON.stringify({ did: grant.did, pending: true,
    instruction: "Retry the same signed grant to retrieve the Offer" }));
} else {
  if (response.status !== 200 || response.headers.get("content-type") !== "application/hail-transfer+json" ||
    response.headers.has("content-encoding") || response.headers.has("location") ||
    Number(response.headers.get("content-length") ?? 0) > 16_384 || !response.body) {
    throw new Error(`Transfer Grant submission failed with HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16_384) throw new Error("Transfer Offer exceeds limit");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  const signed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  if (!signed || typeof signed !== "object" || !("payload" in signed) || !("signature" in signed) ||
    typeof signed.payload !== "string" || typeof signed.signature !== "string") {
    throw new Error("Invalid origin-verified Offer representation");
  }
  const bytes = decodeBase64Url(signed.payload);
  const signature = decodeBase64Url(signed.signature);
  const offer = decodeDeterministic(bytes) as unknown as {
    type: string; did: string; nonce: string; grant_digest: Uint8Array;
    destination_service_base: string; destination_messaging_key: string; expires_at: number };
  if (offer.type !== "hail.transfer-offer" || offer.did !== grant.did || offer.nonce !== grant.nonce ||
    offer.destination_service_base !== grant.destination_service_base || offer.expires_at <= now ||
    signature.length !== 64 || !Buffer.from(offer.grant_digest).equals(createHash("sha256").update(grantBytes).digest())) {
    throw new Error("Transfer Offer does not match the user grant");
  }
  const keyBytes = base58btc.decode(offer.destination_messaging_key.slice("did:key:".length));
  if (keyBytes.length !== 34 || keyBytes[0] !== 0xed || keyBytes[1] !== 0x01) {
    throw new Error("Offer key is not a Hail messaging did:key");
  }
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(keyBytes.slice(2)), "Ed25519", false, ["verify"]);
  const context = new TextEncoder().encode("hail.transfer-offer.v1\0");
  const input = new Uint8Array(context.length + bytes.length);
  input.set(context); input.set(bytes, context.length);
  if (!await crypto.subtle.verify("Ed25519", key, Uint8Array.from(signature), input)) {
    throw new Error("Offer signature from the destination key is invalid");
  }
  const file = await open(offerFile, "wx", 0o600);
  let incomplete = false;
  try { await file.writeFile(JSON.stringify({ payload: encodeBase64Url(bytes),
    signature: encodeBase64Url(signature) })); }
  catch (error) { incomplete = true; throw error; }
  finally { await file.close(); if (incomplete) await unlink(offerFile); }
  console.info(JSON.stringify({ did: grant.did, destination: grant.destination_domain, offerReceived: true }));
}
