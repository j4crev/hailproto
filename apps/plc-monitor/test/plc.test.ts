import { describe, expect, it, vi } from "vitest";
import { BoundedMonitorPlcClient, type MonitorPlcClient } from "../src/plc.js";
import { assertWebhookUrl, PlcMonitor } from "../src/monitor.js";
import type { MonitorSigner } from "../src/signing.js";
import type { SQL } from "bun";
import { PinnedHttpsAlertTransport, publicAddress } from "../src/notifier.js";

const did = `did:plc:${"a".repeat(24)}`;

describe("monitor network boundaries", () => {
  it("rejects invalid attestation subjects before any reads or signing", async () => {
    const read = vi.fn(), sign = vi.fn();
    const client = { getOperationLog: read, getDocumentData: read, getAuditableLog: read } as unknown as MonitorPlcClient;
    const monitor = new PlcMonitor({} as SQL, client);
    const signer = { signCoverage: sign } as unknown as MonitorSigner;
    for (const [transfer, origin] of [["invalid", "https://monitor.example.com"],
      ["00000000-0000-0000-0000-000000000000", "https://monitor.example.com/"],
      ["00000000-0000-0000-0000-000000000000", "https://127.0.0.1"]]) {
      await expect(monitor.attest(did, transfer!, "bafkreia", origin!, signer)).rejects.toThrow();
    }
    expect(read).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled();
  });

  it("requires a reviewed checkpoint for public enrollment before key/database/network access", async () => {
    const child = Bun.spawn([process.execPath, "src/cli/enroll.ts", did, "bafkreiexample", "https://owner.example.com/alerts"], {
      cwd: new URL("../", import.meta.url).pathname,
      env: { ...process.env, PLC_DIRECTORY_URL: "https://plc.directory", DATABASE_URL: "not-a-database-url",
        MONITOR_PRIVATE_KEY_FILE: "/must-not-read/nonexistent.pkcs8" }, stdout: "pipe", stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit).toBe(1); expect(stdout).toBe(""); expect(stderr).toContain("owner-reviewed full-state checkpoint");
    expect(stderr).not.toContain("ENOENT");
  });

  it("pins reads to the configured PLC origin, rejects redirects and bounds export pages", async () => {
    const request = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(""));
    const client = new BoundedMonitorPlcClient("https://plc.directory/", request, 50, 1024);
    expect(await client.exportAfter(5, 20)).toEqual([]);
    expect(request.mock.calls[0]?.[0]).toBe("https://plc.directory/export?after=5&count=20");
    expect(request.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "error" });
    await expect(client.exportAfter(-1, 1)).rejects.toThrow("range");
    await expect(client.exportAfter(5, 1001)).rejects.toThrow("range");
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects duplicate JSON, excessive streamed bytes and hung PLC headers", async () => {
    const duplicate = new BoundedMonitorPlcClient("https://plc.directory", async () =>
      new Response('[{"a":1,"a":2}]'), 40, 128);
    await expect(duplicate.getOperationLog(did)).rejects.toThrow("Duplicate");
    const huge = new BoundedMonitorPlcClient("https://plc.directory", async () =>
      new Response(new Uint8Array(129)), 40, 128);
    await expect(huge.getOperationLog(did)).rejects.toThrow("limit");
    const stalled = new BoundedMonitorPlcClient("https://plc.directory",
      () => new Promise(() => {}), 15, 128);
    await expect(stalled.getOperationLog(did)).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("permits only public DNS-pinned HTTPS webhook targets without query credentials", async () => {
    expect(publicAddress("1.1.1.1")).toBe(true);
    expect(publicAddress("127.0.0.1")).toBe(false);
    expect(publicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(() => assertWebhookUrl("https://user.example.com/hook?token=secret")).toThrow();
    expect(() => assertWebhookUrl("https://127.0.0.1/hook")).toThrow();
    const transport = new PinnedHttpsAlertTransport(async () => [{ address: "10.0.0.1", family: 4 }]);
    await expect(transport.send("https://user.example.com/hook", new Uint8Array([1]),
      new Uint8Array(64), "did:key:zvalid")).rejects.toThrow("exclusively public");
  });
});
