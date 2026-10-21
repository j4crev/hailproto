import { open, readFile, stat, unlink } from "node:fs/promises";
import { decodeBase64Url, encodeBase64Url } from "@hailproto/codec";
import type { SignedHandshake } from "../migration/handshake.js";

export async function readTransferRecord(path: string): Promise<SignedHandshake> {
  const info = await stat(path);
  if (!info.isFile() || info.size < 1 || info.size > 16384 || (info.mode & 0o077) !== 0) {
    throw new Error("Transfer record must be a bounded private file with mode 0600");
  }
  const row: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!row || typeof row !== "object" || Array.isArray(row) ||
    Object.keys(row).length !== 2 ||
    !("payload" in row) || !("signature" in row) ||
    typeof row.payload !== "string" || typeof row.signature !== "string") {
    throw new Error("Invalid signed transfer record");
  }
  return { payloadBytes: decodeBase64Url(row.payload), signature: decodeBase64Url(row.signature) };
}

export async function writeTransferRecord(path: string, signed: SignedHandshake): Promise<void> {
  const file = await open(path, "wx", 0o600).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    const saved = await readTransferRecord(path);
    if (!Buffer.from(saved.payloadBytes).equals(Buffer.from(signed.payloadBytes)) ||
      !Buffer.from(saved.signature).equals(Buffer.from(signed.signature))) {
      throw new Error("Existing transfer record differs from the exact signed retry");
    }
    return null;
  });
  if (!file) return;
  let incomplete = false;
  try { await file.writeFile(JSON.stringify({ payload: encodeBase64Url(signed.payloadBytes),
    signature: encodeBase64Url(signed.signature) })); }
  catch (error) { incomplete = true; throw error; }
  finally { await file.close(); if (incomplete) await unlink(path); }
}
