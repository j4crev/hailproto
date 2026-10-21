import { encodeBase64Url, type HailGrant } from "@hailproto/codec";
import { describe, expect, it, vi } from "vitest";
import { COSE_SIGN1_MEDIA_TYPE } from "../src/discovery/routes.js";
import { GrantPublisher } from "../src/grants/publisher.js";
import type { GrantPublicationClaim, GrantStore } from "../src/grants/store.js";
import type { HailDidResolver } from "../src/plc/resolver.js";

const grantId = "01954144-8097-7a9d-a7a8-ef29a823eaf1";
const grantorDid = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const granteeDid = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
const currentServiceBase = "https://current.example/hail";
const now = new Date("2026-09-27T12:00:00.000Z");
const representation = new Uint8Array([0xd2, 0x84, 0x43, 0x01]);
const digest = new Uint8Array(32).fill(7);
const predecessor = new Uint8Array(32).fill(6);
const expectedEtag = `"${encodeBase64Url(digest)}"`;

function payload(overrides: Partial<HailGrant> = {}): HailGrant {
  return {
    type: "hail.grant",
    version: 1,
    grant_id: grantId,
    revision: 1,
    previous: null,
    grantor: grantorDid,
    grantee: granteeDid,
    scope: [{ type: "categories", values: ["receipts"] }],
    status: "active",
    issued_at: 1_790_467_200,
    updated_at: 1_790_467_200,
    expires_at: null,
    consent_context: {
      grantee_address: "updates@store.example.com",
      address_binding_hash: { algorithm: "sha-256", value: new Uint8Array(32).fill(3) },
      sender_profile_hash: { algorithm: "sha-256", value: new Uint8Array(32).fill(4) },
    },
    key_id: `${grantorDid}#hail-identity`,
    ...overrides,
  };
}

function claim(overrides: Partial<GrantPublicationClaim> = {}): GrantPublicationClaim {
  return {
    grant: {
      localAccountId: "11111111-1111-4111-8111-111111111111",
      localRole: "grantor",
      payload: payload(),
      representation,
      digest,
      signingPublicKey: "did:key:zIdentity",
      signingPlcEvidence: { document: {}, data: {}, log: [] },
      receivedAt: now,
    },
    destinationServiceBase: "https://stale.example/hail",
    leaseToken: "lease-token",
    leaseExpiresAt: new Date(now.getTime() + 30_000),
    attemptCount: 1,
    ...overrides,
  };
}

function fixture(publication: GrantPublicationClaim, response: Response) {
  const acknowledgePublication = vi.fn(async () => undefined);
  const retryPublication = vi.fn(async () => undefined);
  const blockPublication = vi.fn(async () => undefined);
  const grants = {
    claimDuePublication: vi.fn(async () => publication),
    acknowledgePublication,
    retryPublication,
    blockPublication,
  } as unknown as GrantStore;
  const resolve = vi.fn(async (did: string) => ({
    did,
    identityDidKey: "did:key:zIdentity",
    messagingDidKey: "did:key:zMessaging",
    serviceBase: currentServiceBase,
    evidence: { document: {}, data: {}, log: [] },
  }));
  const fetchRequest = vi.fn(async (_request: Request) => response);
  const validateTarget = vi.fn();
  const publisher = new GrantPublisher(
    grants,
    { resolve } satisfies HailDidResolver,
    fetchRequest,
    validateTarget,
    () => now,
    () => 0,
  );
  return {
    publisher,
    grants,
    resolve,
    fetchRequest,
    validateTarget,
    acknowledgePublication,
    retryPublication,
    blockPublication,
  };
}

function response(status: number, headers: Record<string, string> = {}, body: BodyInit | null = null) {
  return new Response(body, { status, headers });
}

describe("GrantPublisher", () => {
  it("acknowledges an exact initial 201 and publishes to the current PLC endpoint", async () => {
    const location = `${currentServiceBase}/grants/${grantId}`;
    const state = fixture(claim(), response(201, { ETag: expectedEtag, Location: location }));

    await expect(state.publisher.publishOne()).resolves.toBe("acknowledged");

    expect(state.grants.claimDuePublication).toHaveBeenCalledWith(30_000, now);
    expect(state.resolve).toHaveBeenCalledWith(granteeDid);
    expect(state.validateTarget).toHaveBeenCalledWith(new URL(location));
    const request = state.fetchRequest.mock.calls[0]?.[0];
    expect(request?.url).toBe(location);
    expect(request?.method).toBe("PUT");
    expect(request?.headers.get("content-type")).toBe(COSE_SIGN1_MEDIA_TYPE);
    expect(request?.headers.get("if-none-match")).toBe("*");
    expect(request?.headers.has("if-match")).toBe(false);
    expect(new Uint8Array(await request!.arrayBuffer())).toEqual(representation);
    expect(state.acknowledgePublication).toHaveBeenCalledWith({
      grantId,
      revision: 1,
      leaseToken: "lease-token",
      httpStatus: 201,
      etag: expectedEtag,
    });
  });

  it("treats an initial 412 with the matching ETag as convergence", async () => {
    const state = fixture(claim(), response(412, { ETag: expectedEtag }));

    await expect(state.publisher.publishOne()).resolves.toBe("acknowledged");
    expect(state.acknowledgePublication).toHaveBeenCalledWith(
      expect.objectContaining({ httpStatus: 412, etag: expectedEtag }),
    );
    expect(state.blockPublication).not.toHaveBeenCalled();
  });

  it("acknowledges a revision update with its predecessor as If-Match", async () => {
    const publication = claim({
      grant: {
        ...claim().grant,
        payload: payload({ revision: 2, previous: predecessor, updated_at: 1_790_467_201 }),
      },
    });
    const state = fixture(publication, response(204, { ETag: expectedEtag }));

    await expect(state.publisher.publishOne()).resolves.toBe("acknowledged");
    const request = state.fetchRequest.mock.calls[0]?.[0];
    expect(request?.headers.get("if-match")).toBe(`"${encodeBase64Url(predecessor)}"`);
    expect(request?.headers.has("if-none-match")).toBe(false);
    expect(state.acknowledgePublication).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 2, httpStatus: 204 }),
    );
  });

  it("backs off transient responses with deterministic jitter", async () => {
    const state = fixture(claim({ attemptCount: 3 }), response(503));

    await expect(state.publisher.publishOne()).resolves.toBe("retry");
    expect(state.retryPublication).toHaveBeenCalledWith({
      grantId,
      revision: 1,
      leaseToken: "lease-token",
      httpStatus: 503,
      error: "Grant publication returned transient HTTP 503",
      nextAttemptAt: new Date(now.getTime() + 90_000),
    });
  });

  it("honors Retry-After on a transient response", async () => {
    const state = fixture(claim(), response(429, { "Retry-After": "120" }));

    await expect(state.publisher.publishOne()).resolves.toBe("retry");
    expect(state.retryPublication).toHaveBeenCalledWith(
      expect.objectContaining({
        httpStatus: 429,
        nextAttemptAt: new Date(now.getTime() + 120_000),
      }),
    );
  });

  it("blocks a permanent conflict", async () => {
    const state = fixture(claim(), response(409));

    await expect(state.publisher.publishOne()).resolves.toBe("blocked");
    expect(state.blockPublication).toHaveBeenCalledWith({
      grantId,
      revision: 1,
      leaseToken: "lease-token",
      httpStatus: 409,
      error: "Grant publication was permanently rejected with HTTP 409",
    });
    expect(state.retryPublication).not.toHaveBeenCalled();
  });

  it("retries a malformed success response", async () => {
    const location = `${currentServiceBase}/grants/${grantId}`;
    const state = fixture(
      claim(),
      response(201, { ETag: expectedEtag, Location: location }, "unexpected"),
    );

    await expect(state.publisher.publishOne()).resolves.toBe("retry");
    expect(state.acknowledgePublication).not.toHaveBeenCalled();
    expect(state.retryPublication).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Successful Grant publication response must have no content",
        nextAttemptAt: new Date(now.getTime() + 22_500),
      }),
    );
  });

  it("bounds an oversized chunked response and retries publication", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40_000));
        controller.enqueue(new Uint8Array(40_000));
      },
      cancel,
    });
    const state = fixture(claim(), new Response(body, { status: 503 }));

    await expect(state.publisher.publishOne()).resolves.toBe("retry");
    expect(cancel).toHaveBeenCalledOnce();
    expect(state.retryPublication).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Grant publication response exceeds its size limit",
        nextAttemptAt: new Date(now.getTime() + 22_500),
      }),
    );
    expect(state.acknowledgePublication).not.toHaveBeenCalled();
    expect(state.blockPublication).not.toHaveBeenCalled();
  });
});
