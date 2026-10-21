import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { encodeBase64Url, type HailEnvelope, type HailFailureReason, type HailHoldReason } from "@hailproto/codec";
import { validateBodyBytes } from "../bodies/service.js";
import type { DiscoveryFetch, NetworkTargetValidator } from "../discovery/verifier.js";
import type { HailDidResolver } from "../plc/resolver.js";

export type RetrievalResult =
  | { kind: "success"; bytes: Uint8Array }
  | { kind: "retry"; reason: HailHoldReason; retryAfter: Date | null }
  | { kind: "fail"; reason: HailFailureReason };

class TransferInterrupted extends Error {}
class OversizedTransfer extends Error {}

async function boundedResponse(response: Response, limit: number): Promise<Uint8Array> {
  const header = response.headers.get("content-length");
  if (header !== null && (!/^\d+$/.test(header) || Number(header) > limit)) throw new OversizedTransfer();
  if (!response.body) throw new TransferInterrupted();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); throw new OversizedTransfer(); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof OversizedTransfer) throw error;
    throw new TransferInterrupted();
  }
  if (header !== null && length !== Number(header)) throw new TransferInterrupted();
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

function retryAfter(response: Response, now: Date): Date | null {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  if (/^\d+$/.test(value)) return new Date(now.getTime() + Math.min(Number(value), 86_400) * 1000);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > now.getTime()
    ? new Date(Math.min(parsed, now.getTime() + 86_400_000)) : null;
}

function validateContentDigest(header: string | null, wire: Uint8Array): boolean {
  if (header === null) return true;
  const expected = createHash("sha256").update(wire).digest("base64");
  return header === `sha-256=:${expected}:`;
}

export class BodyRetriever {
  constructor(
    private readonly resolver: HailDidResolver,
    private readonly fetchBody: DiscoveryFetch,
    private readonly validateTarget: NetworkTargetValidator,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async retrieve(envelope: HailEnvelope): Promise<RetrievalResult> {
    try {
      const sender = await this.resolver.resolve(envelope.from);
      const first = await this.at(sender.serviceBase, envelope);
      if (first.kind !== "not-found") return first;
      // A uniform 404 is not permanent until current sender PLC service is refreshed.
      const refreshed = await this.resolver.resolve(envelope.from);
      if (refreshed.serviceBase === sender.serviceBase) return { kind: "fail", reason: "body-authorization-failed" };
      const second = await this.at(refreshed.serviceBase, envelope);
      return second.kind === "not-found" ? { kind: "fail", reason: "body-authorization-failed" } : second;
    } catch {
      return { kind: "retry", reason: "sender-unreachable", retryAfter: null };
    }
  }

  private async at(base: string, envelope: HailEnvelope): Promise<RetrievalResult | { kind: "not-found" }> {
    const url = new URL(`${base}/bodies/${encodeBase64Url(envelope.body.digest.value)}`);
    await this.validateTarget(url);
    const response = await this.fetchBody(new Request(url, {
      method: "GET", redirect: "manual", signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${encodeBase64Url(envelope.body.access.token)}`,
        Accept: "application/hail-body+cbor", "Accept-Encoding": "gzip, identity",
      },
    }));
    if (response.status === 404) { await response.body?.cancel(); return { kind: "not-found" }; }
    if (response.status === 429 || response.status === 503 || response.status >= 500) {
      await response.body?.cancel();
      return { kind: "retry", reason: response.status === 429 ? "sender-rate-limited" : "body-temporarily-unavailable",
        retryAfter: retryAfter(response, this.now()) };
    }
    if (response.status === 406 || response.status === 415) {
      await response.body?.cancel();
      return { kind: "fail", reason: "body-unsupported" };
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return { kind: "retry", reason: "sender-unreachable", retryAfter: null };
    }
    if (response.headers.get("content-type")?.toLowerCase() !== envelope.body.media_type) {
      await response.body?.cancel();
      return { kind: "fail", reason: "body-integrity-failed" };
    }
    const encoding = response.headers.get("content-encoding")?.toLowerCase() ?? "identity";
    if (encoding !== "identity" && encoding !== "gzip") {
      await response.body?.cancel();
      return { kind: "fail", reason: "body-unsupported" };
    }
    let wire: Uint8Array;
    try {
      wire = await boundedResponse(response, encoding === "gzip" ? 524_288 : envelope.body.size);
    } catch (error) {
      return error instanceof OversizedTransfer
        ? { kind: "fail", reason: "body-integrity-failed" }
        : { kind: "retry", reason: "body-transfer-interrupted", retryAfter: null };
    }
    if (!validateContentDigest(response.headers.get("content-digest"), wire)) {
      return { kind: "fail", reason: "body-integrity-failed" };
    }
    let bytes = wire;
    if (encoding === "gzip") {
      try { bytes = new Uint8Array(gunzipSync(wire, { maxOutputLength: envelope.body.size + 1 })); }
      catch (error) {
        if ((error as { code?: string }).code === "Z_BUF_ERROR") {
          return { kind: "retry", reason: "body-transfer-interrupted", retryAfter: null };
        }
        return { kind: "fail", reason: "body-integrity-failed" };
      }
    }
    if (bytes.length !== envelope.body.size ||
      !Buffer.from(createHash("sha256").update(bytes).digest()).equals(Buffer.from(envelope.body.digest.value))) {
      return { kind: "fail", reason: "body-integrity-failed" };
    }
    try { validateBodyBytes(bytes); }
    catch { return { kind: "fail", reason: "body-invalid" }; }
    return { kind: "success", bytes };
  }
}
