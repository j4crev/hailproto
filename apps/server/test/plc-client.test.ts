import type { Operation } from "@did-plc/lib";
import { describe, expect, it, vi } from "vitest";
import { BoundedPlcDirectoryClient, isPlcNotFound, type PlcReadFetch } from "../src/plc/client.js";

const did = `did:plc:${"a".repeat(24)}`;

describe("bounded private PLC directory reads", () => {
  it("requests only the configured registry with canonical DID paths and preserves official writes", async () => {
    const request = vi.fn<PlcReadFetch>(async () => new Response('{"did":"fixture"}', {
      headers: { "Content-Type": "application/json" },
    }));
    const sendOperation = vi.fn(async () => {});
    const client = new BoundedPlcDirectoryClient("http://plc:2582/", request, 50, 1024, { sendOperation });
    expect(await client.getDocumentData(did)).toEqual({ did: "fixture" });
    expect(request.mock.calls[0]?.[0]).toBe(`http://plc:2582/${encodeURIComponent(did)}/data`);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "error" });
    expect(request.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    await expect(client.getOperationLog("did:plc:INVALID")).rejects.toThrow("canonical");
    expect(request).toHaveBeenCalledOnce();
    const operation = {} as Operation;
    await client.sendOperation(did, operation);
    expect(sendOperation).toHaveBeenCalledWith(did, operation);
  });

  it("preserves a bodyless 404 for exact-operation onboarding reconciliation", async () => {
    const client = new BoundedPlcDirectoryClient("http://plc:2582", async () =>
      new Response(null, { status: 404 }), 50, 1024);
    await expect(client.getOperationLog(did)).rejects.toSatisfy(isPlcNotFound);
  });

  it("bounds streamed bytes and rejects ambiguous JSON member names", async () => {
    const tooLarge = new BoundedPlcDirectoryClient("http://plc:2582", async () =>
      new Response(new Uint8Array(65)), 50, 64);
    await expect(tooLarge.getDocument(did)).rejects.toThrow("size limit");
    const declared = new BoundedPlcDirectoryClient("http://plc:2582", async () =>
      new Response(new Uint8Array([1]), { headers: { "Content-Length": "65" } }), 50, 64);
    await expect(declared.getDocument(did)).rejects.toThrow("size limit");
    const duplicate = new BoundedPlcDirectoryClient("http://plc:2582", async () =>
      new Response('{"id":1,"id":2}'), 50, 64);
    await expect(duplicate.getDocument(did)).rejects.toThrow();
  });

  it("stops waiting when headers or streamed body exceed the single read deadline", async () => {
    const stalledHeaders = new BoundedPlcDirectoryClient("http://plc:2582",
      () => new Promise(() => {}), 15, 64);
    await expect(stalledHeaders.health()).rejects.toMatchObject({ name: "TimeoutError" });
    const stalledBody = new BoundedPlcDirectoryClient("http://plc:2582", async () =>
      new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("[")); },
        pull() { return new Promise(() => {}); },
      })), 15, 64);
    await expect(stalledBody.getOperationLog(did)).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
