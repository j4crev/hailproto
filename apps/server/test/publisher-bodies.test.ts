import { describe, expect, it, vi } from "vitest";
import { AccountApiClient } from "@hailproto/client-support/account-api";
import { decodePayload, encodeDeterministic, type HailSpt2Body } from "@hailproto/codec";
import { BODY_CONTAINER_LIMITS, BODY_MAX_BYTES, bodyFromDocument, validateBodyBytes } from "../src/bodies/service.js";
import { outboundBody } from "../src/accounts/messaging.js";
import { accountRequestBytes } from "../src/accounts/routes.js";

describe("publisher content under the 1 MiB body budget", () => {
  it.each(["Product update — pricing, availability, and service information. ", "更新情報：製品、サービス、ご利用条件について。 "])("round trips long structured publishing content: %s", sentence => {
    const body: HailSpt2Body = { version: 1, profile: "spt-2", blocks: Array.from({length: 100}, (_, index): HailSpt2Body["blocks"] => [
      { _type: "block" as const, style: "h2" as const, children: [{_type:"span" as const,text:`Section ${index + 1}`,marks:[]}], markDefs:[] },
      { _type: "block" as const, style: "normal" as const, children: [
        {_type:"span" as const,text:sentence.repeat(55),marks:[]},
        {_type:"span" as const,text:"Read details",marks:["details"]}],
        markDefs:[{_key:"details",_type:"spt.link" as const,href:`https://example.com/update/${index}`}]}]).flat() };
    const bytes = bodyFromDocument(body);
    expect(bytes.length).toBeGreaterThan(262_144);
    expect(bytes.length).toBeLessThan(BODY_MAX_BYTES);
    expect(decodePayload("hail.body.spt-2",bytes)).toEqual(body);
    expect(Buffer.from(outboundBody({body})).equals(Buffer.from(bytes))).toBe(true);
    expect(validateBodyBytes(bytes)).toBe("spt-2");
  });

  it("leaves room for intent metadata around a maximum-sized body", () => {
    expect(encodeDeterministic({body:new Uint8Array(BODY_MAX_BYTES),connections:[]},BODY_CONTAINER_LIMITS).length).toBeGreaterThan(BODY_MAX_BYTES);
  });

  it("bounds message JSON separately from encoded content", async () => {
    const json = JSON.stringify({text:"\u0001".repeat(300_000)});
    expect(await accountRequestBytes(new Request("https://example.com",{method:"POST",body:json}),8*1024*1024)).not.toBeNull();
    expect(await accountRequestBytes(new Request("https://example.com",{method:"POST",body:json}))).toBeNull();
  });

  it("reads large messages while retaining the smaller unrelated account-response bound", async () => {
    const client = AccountApiClient.fromSession("https://example.com",`hails_${"a".repeat(43)}`);
    const payload = { text: "x".repeat(1_048_000) };
    const fetch = vi.spyOn(globalThis,"fetch").mockImplementation(async () => new Response(JSON.stringify(payload), {headers:{"Content-Type":"application/json"}}));
    try {
      expect(await client.request("/inbox/sender/message")).toEqual(payload);
      expect(await client.request("/conversations/peer")).toEqual(payload);
      expect(await client.request("/connection-threads/sender/message")).toEqual(payload);
      await expect(client.request("/profile")).rejects.toThrow();
    } finally { fetch.mockRestore(); }
  });
});
