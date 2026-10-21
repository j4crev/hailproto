import {
  Client,
  PlcClientError,
  type CompatibleOpOrTombstone,
  type DocumentData,
  type ExportedOp,
  type Operation,
} from "@did-plc/lib";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";

const DID_PATTERN = /^did:plc:[a-z2-7]{24}$/;
const MAX_PLC_RESPONSE_BYTES = 1_048_576;
const PLC_READ_TIMEOUT_MS = 5_000;
export type PlcReadFetch = (url: string, init: RequestInit) => Promise<Response>;

export function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener("abort", aborted); reject(signal.reason); };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    work.then(
      (value) => { signal.removeEventListener("abort", aborted); resolve(value); },
      (error) => { signal.removeEventListener("abort", aborted); reject(error); },
    );
  });
}

export interface PlcDirectoryClient {
  health(): Promise<unknown>;
  getDocument(did: string): Promise<object>;
  getDocumentData(did: string): Promise<DocumentData>;
  getOperationLog(did: string): Promise<CompatibleOpOrTombstone[]>;
  getAuditableLog(did: string): Promise<ExportedOp[]>;
  sendOperation(did: string, operation: Operation): Promise<void>;
}

export class BoundedPlcDirectoryClient implements PlcDirectoryClient {
  private readonly official: Pick<Client, "sendOperation">;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchRequest: PlcReadFetch = fetch,
    private readonly readTimeoutMs = PLC_READ_TIMEOUT_MS,
    private readonly maxResponseBytes = MAX_PLC_RESPONSE_BYTES,
    official?: Pick<Client, "sendOperation">,
  ) {
    if (!Number.isSafeInteger(readTimeoutMs) || readTimeoutMs < 1 ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
      throw new Error("Invalid PLC read bounds");
    }
    this.official = official ?? new Client(baseUrl);
  }

  health(): Promise<unknown> { return this.read("/_health"); }
  async getDocument(did: string): Promise<object> { return this.read(this.didPath(did)); }
  async getDocumentData(did: string): Promise<DocumentData> { return this.read(`${this.didPath(did)}/data`); }
  async getOperationLog(did: string): Promise<CompatibleOpOrTombstone[]> { return this.read(`${this.didPath(did)}/log`); }
  async getAuditableLog(did: string): Promise<ExportedOp[]> { return this.read(`${this.didPath(did)}/log/audit`); }

  // Preserve the pinned official client's submission behavior and onboarding's
  // exact-operation reconciliation when a response is ambiguous.
  sendOperation(did: string, operation: Operation): Promise<void> {
    return this.official.sendOperation(did, operation);
  }

  private didPath(did: string): string {
    if (!DID_PATTERN.test(did)) throw new Error("PLC DID is not canonical");
    return `/${encodeURIComponent(did)}`;
  }

  private async read<T>(path: string): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, "")}${path}`;
    const signal = AbortSignal.timeout(this.readTimeoutMs);
    const response = await withAbort(this.fetchRequest(url, {
      method: "GET", redirect: "error", signal,
      headers: { Accept: "application/json" },
    }), signal);
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > this.maxResponseBytes)) {
      void response.body?.cancel().catch(() => {});
      throw new Error("PLC response exceeds its size limit");
    }
    if (!response.body) {
      if (!response.ok) throw new PlcClientError(response.status, null, `PLC returned HTTP ${response.status}`);
      throw new Error("PLC returned an empty response");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let complete = false;
    try {
      while (true) {
        const { done, value } = await withAbort(reader.read(), signal);
        if (done) break;
        size += value.length;
        if (size > this.maxResponseBytes) throw new Error("PLC response exceeds its size limit");
        chunks.push(value);
      }
      complete = true;
    } finally {
      if (!complete) void reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!response.ok) {
      let data: unknown = text;
      try { data = parseJsonWithoutDuplicateKeys(text); } catch { /* PLC may return a plain-text error. */ }
      throw new PlcClientError(response.status, data, `PLC returned HTTP ${response.status}`);
    }
    return parseJsonWithoutDuplicateKeys(text) as T;
  }
}

export function createPlcDirectoryClient(baseUrl: string): PlcDirectoryClient {
  return new BoundedPlcDirectoryClient(baseUrl);
}

export function isPlcNotFound(error: unknown): boolean {
  return error instanceof PlcClientError && error.status === 404;
}
