import { createHash } from "node:crypto";
import {
  createWebCryptoSigner,
  encodeBase64Url,
  signPayload,
  type HailSenderProfile,
} from "@hailproto/codec";
import { describe, expect, it, vi } from "vitest";
import { KeyEncryptor } from "../src/identity/key-encryption.js";
import { generateAccountKeys } from "../src/identity/keys.js";
import { SenderProfileVerifier } from "../src/profiles/verifier.js";

const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";

async function signedProfile(revision = 1, updatedAt = 1_790_467_200) {
  const accountId = crypto.randomUUID();
  const encryptor = new KeyEncryptor("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  const keys = await generateAccountKeys(accountId, encryptor);
  const messaging = keys.keys.find((key) => key.role === "hail-messaging");
  if (!messaging) throw new Error("Messaging key missing");
  const privateBytes = await encryptor.decrypt(
    accountId,
    messaging.role,
    messaging.algorithm,
    messaging.publicKey,
    messaging,
  );
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(privateBytes),
    "Ed25519",
    false,
    ["sign"],
  );
  privateBytes.fill(0);
  const payload: HailSenderProfile = {
    type: "hail.sender-profile",
    version: 1,
    did,
    revision,
    display_name: "Alice",
    offers_uncategorized: false,
    categories: [{ id: "receipts", label: "Receipts" }],
    updated_at: updatedAt,
    key_id: `${did}#hail-messaging`,
  };
  const representation = await signPayload(
    "hail.sender-profile",
    payload,
    createWebCryptoSigner(payload.key_id, privateKey),
  );
  const digest = new Uint8Array(createHash("sha256").update(representation).digest());
  return { keys, payload, representation, etag: encodeBase64Url(digest) };
}

describe("SenderProfileVerifier", () => {
  it("verifies exact remote bytes, ETag, DID, and current messaging key", async () => {
    const fixture = await signedProfile();
    const resolver = {
      resolve: vi.fn(async () => ({
        did,
        identityDidKey: fixture.keys.identityDidKey,
        messagingDidKey: fixture.keys.messagingDidKey,
        serviceBase: "https://hailproto.app/hail",
        evidence: { document: {}, data: {}, log: [] },
      })),
    };
    const fetchRequest = vi.fn(async (_request: Request) =>
      new Response(Uint8Array.from(fixture.representation), {
        status: 200,
        headers: {
          "Content-Type": "application/cose;cose-type=cose-sign1",
          ETag: `"${fixture.etag}"`,
        },
      }),
    );
    const store = {
      getLatestVerifiedSenderProfile: vi.fn(async () => null),
      retainVerifiedSenderProfile: vi.fn(async () => undefined),
    };
    const verifier = new SenderProfileVerifier(
      resolver,
      fetchRequest,
      vi.fn(async () => undefined),
      () => new Date("2026-09-27T00:05:00Z"),
      store,
    );

    const result = await verifier.verify(did);

    expect(result.profile).toEqual(fixture.payload);
    expect(result.etag).toBe(fixture.etag);
    const request = fetchRequest.mock.calls[0]?.[0];
    expect(request?.redirect).toBe("manual");
    expect(request?.headers.get("authorization")).toBeNull();
    expect(store.retainVerifiedSenderProfile).toHaveBeenCalledWith(result);
  });

  it("rejects a representation whose ETag is not its digest", async () => {
    const fixture = await signedProfile();
    const resolver = {
      async resolve() {
        return {
          did,
          identityDidKey: fixture.keys.identityDidKey,
          messagingDidKey: fixture.keys.messagingDidKey,
          serviceBase: "https://hailproto.app/hail",
          evidence: { document: {}, data: {}, log: [] },
        };
      },
    };
    const verifier = new SenderProfileVerifier(
      resolver,
      async () =>
        new Response(Uint8Array.from(fixture.representation), {
          status: 200,
          headers: {
            "Content-Type": 'application/cose; cose-type="cose-sign1"',
            ETag: `"${"A".repeat(43)}"`,
          },
        }),
      async () => undefined,
    );

    await expect(verifier.verify(did)).rejects.toThrow("ETag does not match");
  });

  it("re-verifies retained exact bytes against current PLC state after 304", async () => {
    const fixture = await signedProfile();
    const digest = new Uint8Array(createHash("sha256").update(fixture.representation).digest());
    const retained = {
      did,
      serviceBase: "https://hailproto.app/hail",
      messagingDidKey: fixture.keys.messagingDidKey,
      profile: fixture.payload,
      representation: fixture.representation,
      digest,
      etag: fixture.etag,
      plcEvidence: { document: {}, data: {}, log: [] },
      verifiedAt: new Date("2026-09-27T00:00:00Z"),
    };
    const verifier = new SenderProfileVerifier(
      {
        async resolve() {
          return {
            did,
            identityDidKey: fixture.keys.identityDidKey,
            messagingDidKey: fixture.keys.messagingDidKey,
            serviceBase: "https://hailproto.app/hail",
            evidence: { document: {}, data: {}, log: [] },
          };
        },
      },
      async () => new Response(null, { status: 304, headers: { ETag: `"${fixture.etag}"` } }),
      async () => undefined,
      () => new Date("2026-09-27T00:05:00Z"),
    );

    const result = await verifier.verify(did, retained);

    expect(result.profile).toEqual(fixture.payload);
    expect(result.representation).toEqual(fixture.representation);
  });

  it("rejects rollback against retained evidence", async () => {
    const newer = await signedProfile(2, 1_790_467_201);
    const older = await signedProfile(1, 1_790_467_200);
    const resolved = {
      did,
      identityDidKey: older.keys.identityDidKey,
      messagingDidKey: older.keys.messagingDidKey,
      serviceBase: "https://hailproto.app/hail",
      evidence: { document: {}, data: {}, log: [] },
    };
    const retained = {
      did,
      serviceBase: resolved.serviceBase,
      messagingDidKey: newer.keys.messagingDidKey,
      profile: newer.payload,
      representation: newer.representation,
      digest: new Uint8Array(createHash("sha256").update(newer.representation).digest()),
      etag: newer.etag,
      plcEvidence: { document: {}, data: {}, log: [] },
      verifiedAt: new Date("2026-09-27T00:00:00Z"),
    };
    const verifier = new SenderProfileVerifier(
      { resolve: async () => resolved },
      async () =>
        new Response(Uint8Array.from(older.representation), {
          status: 200,
          headers: {
            "Content-Type": 'application/cose; cose-type="cose-sign1"',
            ETag: `"${older.etag}"`,
          },
        }),
      async () => undefined,
      () => new Date("2026-09-27T00:05:00Z"),
    );

    await expect(verifier.verify(did, retained)).rejects.toThrow("rollback");
  });

  it("rejects retained evidence for another DID before network access", async () => {
    const fixture = await signedProfile();
    const fetchRequest = vi.fn(async () => new Response(null, { status: 500 }));
    const verifier = new SenderProfileVerifier(
      {
        async resolve() {
          throw new Error("must not resolve");
        },
      },
      fetchRequest,
      async () => undefined,
    );
    const retained = {
      did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb",
      serviceBase: "https://hailproto.dev/hail",
      messagingDidKey: fixture.keys.messagingDidKey,
      profile: fixture.payload,
      representation: fixture.representation,
      digest: new Uint8Array(createHash("sha256").update(fixture.representation).digest()),
      etag: fixture.etag,
      plcEvidence: { document: {}, data: {}, log: [] },
      verifiedAt: new Date(),
    };

    await expect(verifier.verify(did, retained)).rejects.toThrow("another DID");
    expect(fetchRequest).not.toHaveBeenCalled();
  });
});
