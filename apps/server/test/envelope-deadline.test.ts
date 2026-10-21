import { base58btc } from "multiformats/bases/base58";
import { createWebCryptoSigner, signPayload } from "@hailproto/codec";
import { describe, expect, it, vi } from "vitest";
import { EnvelopeReceiver } from "../src/envelopes/receiver.js";
import type { EnvelopeRepository } from "../src/envelopes/repository.js";
import type { HailDidResolver, ResolvedHailDid } from "../src/plc/resolver.js";

const alice = `did:plc:${"a".repeat(24)}`;
const bob = `did:plc:${"b".repeat(24)}`;
const id = "01954144-8097-7a9d-a7a8-ef29a823eaf1";

async function signedEnvelope(): Promise<{ bytes: Uint8Array; publicKey: string }> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const key = new Uint8Array(34);
  key.set([0xed, 0x01]);
  key.set(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)), 2);
  const now = Math.floor(Date.now() / 1000);
  const bytes = await signPayload("hail.envelope", {
    type: "hail.envelope", version: 1, message_id: id, from: alice, to: bob,
    authorization: { type: "grant", grant_id: id }, category: "updates",
    created_at: now, expires_at: now + 3600,
    body: { digest: { algorithm: "sha-256", value: new Uint8Array(32) }, size: 1,
      media_type: "application/hail-body+cbor", profile: "spt-1", available_until: now + 31 * 86400,
      access: { type: "bearer", token: new Uint8Array(32), expires_at: now + 31 * 86400 } },
    reply: { allowed: false },
  }, createWebCryptoSigner(`${alice}#hail-messaging`, pair.privateKey));
  return { bytes, publicKey: `did:key:${base58btc.encode(key)}` };
}

describe("bounded envelope validation", () => {
  it("does not start DID resolution when a preliminary relationship is absent", async () => {
    const { bytes } = await signedEnvelope();
    const resolve = vi.fn<HailDidResolver["resolve"]>();
    const accept = vi.fn<EnvelopeRepository["accept"]>();
    const receiver = new EnvelopeReceiver({ getAccountByDid: vi.fn() },
      { candidate: async () => false, accept }, { resolve }, "https://bob.example/hail");
    expect(await receiver.receive(bytes)).toBe("ignored");
    expect(resolve).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });

  it("stops before replay reservation when sender PLC resolution outlives the deadline", async () => {
    const { bytes, publicKey } = await signedEnvelope();
    let release!: (value: ResolvedHailDid) => void;
    const resolve = vi.fn<HailDidResolver["resolve"]>(() => new Promise((done) => { release = done; }));
    const accept = vi.fn<EnvelopeRepository["accept"]>();
    const candidate = vi.fn(async () => true);
    const receiver = new EnvelopeReceiver({ getAccountByDid: vi.fn() }, { candidate, accept },
      { resolve }, "https://bob.example/hail");
    const controller = new AbortController();
    const pending = receiver.receive(bytes, controller.signal);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    controller.abort(new Error("PLC operation exceeded processing deadline"));
    release({ did: alice, messagingDidKey: publicKey, identityDidKey: publicKey,
      serviceBase: "https://alice.example/hail", evidence: { document: {}, data: {}, log: [] } });
    expect(await pending).toBe("ignored");
    expect(candidate).toHaveBeenCalledOnce();
    expect(accept).not.toHaveBeenCalled();
  });
});
