import { createWebCryptoSigner, signPayload, type HailAddressBinding } from "@hailproto/codec";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AddressVerifier } from "../src/discovery/verifier.js";
import { createProviderDiscovery, providerDiscoveryForOrigin, type ProviderDiscovery } from "../src/discovery/delegation.js";
import { ADDRESS_BINDING_REL, COSE_SIGN1_MEDIA_TYPE } from "../src/discovery/routes.js";
import { KeyEncryptor } from "../src/identity/key-encryption.js";
import { generateAccountKeys, importEd25519PrivateKey } from "../src/identity/keys.js";
import type { PlcDirectoryClient } from "../src/plc/client.js";

const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const address = "j4@j4crev.com";
const now = new Date("2026-10-30T12:00:00Z");
let representation: Uint8Array;
let identityDidKey: string;
let messagingDidKey: string;

beforeAll(async () => {
  const id = crypto.randomUUID();
  const encryptor = new KeyEncryptor("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  const generated = await generateAccountKeys(id, encryptor);
  identityDidKey = generated.identityDidKey;
  messagingDidKey = generated.messagingDidKey;
  const key = generated.keys.find(key => key.role === "hail-identity")!;
  const bytes = await encryptor.decrypt(id, key.role, key.algorithm, key.publicKey, key);
  const privateKey = await importEd25519PrivateKey(bytes);
  bytes.fill(0);
  const payload: HailAddressBinding = {
    type: "hail.address-binding", version: 1, address, did,
    issued_at: now.getTime() / 1000 - 60, expires_at: now.getTime() / 1000 + 3600,
    key_id: `${did}#hail-identity`,
  };
  representation = await signPayload("hail.address-binding", payload, createWebCryptoSigner(payload.key_id, privateKey));
});

function fixture(discover: ProviderDiscovery, options: {subject?: string; status?: number; deny?: boolean; corrupt?: boolean} = {}) {
  const fetch = vi.fn(async (request: Request) => {
    if (new URL(request.url).pathname === "/.well-known/webfinger") {
      if (options.status) return new Response(null, { status: options.status });
      return new Response(JSON.stringify({ subject: options.subject ?? `acct:${address}`, links: [{
        rel: ADDRESS_BINDING_REL, type: COSE_SIGN1_MEDIA_TYPE,
        href: "https://haili.app/.well-known/hail/addresses/binding",
      }] }), { headers: { "Content-Type": "application/jrd+json" } });
    }
    const bytes = Uint8Array.from(representation);
    if (options.corrupt) bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    return new Response(bytes, { headers: { "Content-Type": COSE_SIGN1_MEDIA_TYPE } });
  });
  const validate = vi.fn(async (_url: URL) => { if (options.deny) throw new Error("private network"); });
  const resolver = { resolve: vi.fn(async () => ({ did, identityDidKey, messagingDidKey,
    serviceBase: "https://haili.app/hail", evidence: { document: {}, data: {}, log: [] } })) };
  const verifier = new AddressVerifier({} as PlcDirectoryClient, fetch, validate, () => now, resolver, discover);
  return { verifier, fetch, validate, resolver };
}

describe("DNS-delegated signed address verification", () => {
  it("verifies native-domain WebFinger and signed bindings without TXT discovery", async () => {
    const dns = vi.fn(async () => { throw new Error("DNS must not be queried"); });
    const discover = providerDiscoveryForOrigin("https://j4crev.com", dns);
    const { verifier, fetch, validate } = fixture(discover);
    expect((await verifier.verify("J4@J4CREV.COM")).representation).toEqual(representation);
    expect(dns).not.toHaveBeenCalled();
    expect(new URL(fetch.mock.calls[0]![0].url).origin).toBe("https://j4crev.com");
    expect(validate).toHaveBeenCalledTimes(2);
    await expect(fixture(discover, { corrupt: true }).verifier.verify(address)).rejects.toThrow();
  });

  it("contacts only the provider, preserving the original address and exact signed bytes", async () => {
    const resolveTxt = vi.fn(async () => [["v=hail1; provider=haili.app"]]);
    const discover = createProviderDiscovery(() => ({ resolveTxt, cancel() {} }));
    const { verifier, fetch, validate } = fixture(providerDiscoveryForOrigin("https://haili.app", discover));
    const result = await verifier.verify("J4@J4CREV.COM");
    expect(result.address).toBe(address);
    expect(result.did).toBe(did);
    expect(result.representation).toEqual(representation);
    expect(result.serviceBase).toBe("https://haili.app/hail");
    expect(resolveTxt).toHaveBeenCalledExactlyOnceWith("_hail-provider.j4crev.com");
    const request = fetch.mock.calls[0]![0];
    const url = new URL(request.url);
    expect(url.origin).toBe("https://haili.app");
    expect(url.searchParams.get("resource")).toBe(`acct:${address}`);
    expect(url.searchParams.get("rel")).toBe(ADDRESS_BINDING_REL);
    expect(request.redirect).toBe("manual");
    expect(request.headers.get("authorization")).toBeNull();
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("retains domain-hosted WebFinger when delegation is absent", async () => {
    const { verifier, fetch } = fixture(async () => null);
    expect((await verifier.verify(address)).did).toBe(did);
    expect(new URL(fetch.mock.calls[0]![0].url).origin).toBe("https://j4crev.com");
  });

  it("does not fetch HTTPS after DNS failure", async () => {
    const { verifier, fetch } = fixture(async () => { throw new Error("SERVFAIL"); });
    await expect(verifier.verify(address)).rejects.toThrow("SERVFAIL");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not fall back when the delegated provider fails", async () => {
    const { verifier, fetch } = fixture(async () => "haili.app", { status: 503 });
    await expect(verifier.verify(address)).rejects.toThrow("did not return 200");
    expect(fetch).toHaveBeenCalledOnce();
    expect(new URL(fetch.mock.calls[0]![0].url).hostname).toBe("haili.app");
  });

  it("retains network target validation", async () => {
    const { verifier, fetch } = fixture(async () => "haili.app", { deny: true });
    await expect(verifier.verify(address)).rejects.toThrow("private network");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a provider-domain subject substituted for the custom address", async () => {
    const { verifier } = fixture(async () => "haili.app", { subject: "acct:j4@haili.app" });
    await expect(verifier.verify(address)).rejects.toThrow("subject does not match");
  });

  it("still rejects an invalid binding signature", async () => {
    const { verifier } = fixture(async () => "haili.app", { corrupt: true });
    await expect(verifier.verify(address)).rejects.toThrow();
  });

  it("rejects a correctly signed binding for another local part", async () => {
    const { verifier } = fixture(async () => "haili.app", { subject: "acct:other@j4crev.com" });
    await expect(verifier.verify("other@j4crev.com")).rejects.toThrow("names another address");
  });
});
