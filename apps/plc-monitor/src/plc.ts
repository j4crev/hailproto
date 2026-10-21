import { def, type CompatibleOpOrTombstone, type DocumentData, type ExportedOp, type ExportedOpWithSeq } from "@did-plc/lib";
import { parseJsonWithoutDuplicateKeys } from "./strict-json.js";
import { createHash } from "node:crypto";
import { encodeBase64Url, encodeDeterministic, type HailValue } from "@hailproto/codec";

export function plcStateDigest(state: DocumentData): string {
  return encodeBase64Url(new Uint8Array(createHash("sha256").update(encodeDeterministic(state as unknown as HailValue)).digest()));
}

const DID = /^did:plc:[a-z2-7]{24}$/;

export interface MonitorPlcClient {
  exportAfter(after: number, count: number): Promise<ExportedOpWithSeq[]>;
  getOperationLog(did: string): Promise<CompatibleOpOrTombstone[]>;
  getDocumentData(did: string): Promise<DocumentData>;
  getAuditableLog(did: string): Promise<ExportedOp[]>;
}

export class BoundedMonitorPlcClient implements MonitorPlcClient {
  private readonly base: string;

  constructor(baseUrl: string, private readonly fetchRequest: (url: string, init: RequestInit) => Promise<Response> = fetch,
    private readonly timeoutMs = 5000, private readonly maxBytes = 1_048_576) {
    const url = new URL(baseUrl);
    if (!(["https:", "http:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error("Invalid configured PLC monitor directory URL or bounds");
    }
    this.base = baseUrl.replace(/\/$/, "");
  }

  async exportAfter(after: number, count: number): Promise<ExportedOpWithSeq[]> {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(count) || count < 1 || count > 100) {
      throw new Error("Invalid sequenced PLC export range");
    }
    const result = await this.read(`/export?after=${after}&count=${count}`);
    if (!result) return [];
    return result.split("\n").map((line) => def.exportedOpWithSeq.parse(parseJsonWithoutDuplicateKeys(line)));
  }

  async getOperationLog(did: string): Promise<CompatibleOpOrTombstone[]> {
    const value = parseJsonWithoutDuplicateKeys(await this.read(`${this.path(did)}/log`));
    if (!Array.isArray(value)) throw new Error("PLC operation log is not an array");
    return value.map((entry) => def.compatibleOpOrTombstone.parse(entry));
  }

  async getDocumentData(did: string): Promise<DocumentData> {
    return def.documentData.parse(parseJsonWithoutDuplicateKeys(await this.read(`${this.path(did)}/data`)));
  }

  async getAuditableLog(did: string): Promise<ExportedOp[]> {
    const value = parseJsonWithoutDuplicateKeys(await this.read(`${this.path(did)}/log/audit`));
    if (!Array.isArray(value)) throw new Error("PLC audit log is not an array");
    return value.map((entry) => def.exportedOp.parse(entry));
  }

  private path(did: string): string {
    if (!DID.test(did)) throw new Error("Monitor DID is not canonical");
    return `/${encodeURIComponent(did)}`;
  }

  private async read(path: string): Promise<string> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const response = await abortable(this.fetchRequest(`${this.base}${path}`, {
      method: "GET", redirect: "error", signal, headers: { Accept: "application/json, application/jsonlines" },
    }), signal);
    if (!response.ok) throw new Error(`PLC read returned HTTP ${response.status}`);
    const header = response.headers.get("content-length");
    if (header && (!/^\d+$/.test(header) || Number(header) > this.maxBytes)) {
      void response.body?.cancel().catch(() => {});
      throw new Error("PLC response exceeded monitor limit");
    }
    if (!response.body) throw new Error("PLC returned an empty response stream");
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let length = 0;
    let done = false;
    try {
      while (true) {
        const next = await abortable(reader.read(), signal);
        if (next.done) break;
        length += next.value.length;
        if (length > this.maxBytes) throw new Error("PLC response exceeded monitor limit");
        parts.push(next.value);
      }
      done = true;
    } finally { if (!done) void reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then((value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
