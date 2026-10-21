import { createHash } from "node:crypto";
import {
  createWebCryptoSigner,
  encodeBase64Url,
  signPayload,
  type HailGrant,
} from "@hailproto/codec";
import { base58btc } from "multiformats/bases/base58";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { GrantReceiveError, GrantReceiver } from "../src/grants/receiver.js";
import type {
  GrantStore,
  ReceivedGrantRevision,
  SignedGrantRevision,
} from "../src/grants/store.js";
import type { AccountRecord } from "../src/onboarding/repository.js";
import type { HailDidResolver } from "../src/plc/resolver.js";

const grantId = "01954144-8097-7a9d-a7a8-ef29a823eaf1";
const grantorDid = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const granteeDid = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
const serviceBase = "https://hailproto.app/hail";
const nowSeconds = 1_790_467_200;
const evidence = { document: {}, data: {}, log: [] };
const account: AccountRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  canonicalAddress: "updates@store.example.com",
  did: granteeDid,
  state: "active",
  activationAttemptId: null,
  activationVerificationMode: "public",
};

let identityPrivateKey: CryptoKey;
let identityDidKey: string;

beforeAll(async () => {
  const keys = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  identityPrivateKey = keys.privateKey;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const multicodecKey = new Uint8Array(34);
  multicodecKey.set([0xed, 0x01]);
  multicodecKey.set(raw, 2);
  identityDidKey = `did:key:${base58btc.encode(multicodecKey)}`;
});

function digest(representation: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(representation).digest());
}

function etag(representation: Uint8Array): string {
  return `"${encodeBase64Url(digest(representation))}"`;
}

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
    issued_at: nowSeconds,
    updated_at: nowSeconds,
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

async function signed(value: HailGrant): Promise<Uint8Array> {
  return signPayload(
    "hail.grant",
    value,
    createWebCryptoSigner(value.key_id, identityPrivateKey),
  );
}

function fixture(accountResult: AccountRecord | null = account) {
  let current: SignedGrantRevision | null = null;
  const findCurrentByGrantId = vi.fn(async () => current);
  const acceptReceivedRevision = vi.fn(async (input: ReceivedGrantRevision) => {
    current = {
      ...input,
      localRole: "grantee",
      receivedAt: new Date(nowSeconds * 1_000),
    };
    return current;
  });
  const store = { findCurrentByGrantId, acceptReceivedRevision } as unknown as GrantStore;
  const accounts = { getAccountByDid: vi.fn(async () => accountResult) };
  const resolver: HailDidResolver = {
    resolve: vi.fn(async (did: string) => ({
      did,
      identityDidKey,
      messagingDidKey: "did:key:zMessaging",
      serviceBase,
      evidence,
    })),
  };
  return {
    receiver: new GrantReceiver(accounts, store, resolver, serviceBase, () =>
      new Date(nowSeconds * 1_000),
    ),
    accounts,
    resolver,
    findCurrentByGrantId,
    acceptReceivedRevision,
  };
}

describe("GrantReceiver", () => {
  it("accepts revision 1, returns an exact retry as 412, and accepts revocation", async () => {
    const { receiver, acceptReceivedRevision } = fixture();
    const initial = await signed(payload());

    await expect(
      receiver.receive(grantId, initial, { ifMatch: null, ifNoneMatch: "*" }),
    ).resolves.toEqual({ status: 201, etag: etag(initial), created: true });
    await expect(
      receiver.receive(grantId, initial, { ifMatch: null, ifNoneMatch: "*" }),
    ).resolves.toEqual({ status: 412, etag: etag(initial), created: false });

    const revokedPayload = payload({
      revision: 2,
      previous: digest(initial),
      status: "revoked",
      updated_at: nowSeconds + 1,
    });
    const revoked = await signed(revokedPayload);
    await expect(
      receiver.receive(grantId, revoked, { ifMatch: etag(initial), ifNoneMatch: null }),
    ).resolves.toEqual({ status: 204, etag: etag(revoked), created: false });
    await expect(
      receiver.receive(grantId, revoked, { ifMatch: etag(initial), ifNoneMatch: null }),
    ).resolves.toEqual({ status: 204, etag: etag(revoked), created: false });
    expect(acceptReceivedRevision).toHaveBeenCalledTimes(2);
  });

  it("uses uniform non-disclosing 400 errors for invalid signatures and unavailable grantees", async () => {
    const valid = await signed(payload());
    const invalid = valid.slice();
    invalid[invalid.length - 1] = (invalid.at(-1) ?? 0) ^ 1;

    for (const [receiver, representation] of [
      [fixture().receiver, invalid],
      [fixture(null).receiver, valid],
    ] as const) {
      await expect(
        receiver.receive(grantId, representation, { ifMatch: null, ifNoneMatch: "*" }),
      ).rejects.toMatchObject({
        status: 400,
        message: "Bad Request",
        disclose: false,
      } satisfies Partial<GrantReceiveError>);
    }
  });

  it("requires authenticated initial and update preconditions", async () => {
    const { receiver } = fixture();
    const initial = await signed(payload());
    await expect(
      receiver.receive(grantId, initial, { ifMatch: null, ifNoneMatch: null }),
    ).rejects.toMatchObject({ status: 428 });

    await receiver.receive(grantId, initial, { ifMatch: null, ifNoneMatch: "*" });
    const update = await signed(
      payload({ revision: 2, previous: digest(initial), updated_at: nowSeconds + 1 }),
    );
    await expect(
      receiver.receive(grantId, update, { ifMatch: null, ifNoneMatch: null }),
    ).rejects.toMatchObject({ status: 428 });
  });

  it("validates initial and update conditions before exact-retry convergence", async () => {
    const { receiver } = fixture();
    const initial = await signed(payload());
    await receiver.receive(grantId, initial, { ifMatch: null, ifNoneMatch: "*" });

    await expect(
      receiver.receive(grantId, initial, { ifMatch: null, ifNoneMatch: null }),
    ).rejects.toMatchObject({ status: 428 });
    await expect(
      receiver.receive(grantId, initial, { ifMatch: null, ifNoneMatch: `"${"A".repeat(43)}"` }),
    ).rejects.toMatchObject({ status: 400 });

    const update = await signed(
      payload({
        revision: 2,
        previous: digest(initial),
        status: "revoked",
        updated_at: nowSeconds + 1,
      }),
    );
    await receiver.receive(grantId, update, { ifMatch: etag(initial), ifNoneMatch: null });

    await expect(
      receiver.receive(grantId, update, { ifMatch: null, ifNoneMatch: null }),
    ).rejects.toMatchObject({ status: 428 });
    await expect(
      receiver.receive(grantId, update, { ifMatch: `W/${etag(initial)}`, ifNoneMatch: null }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("returns 421 for a fresh grantee service mismatch before local account lookup", async () => {
    const context = fixture();
    vi.mocked(context.resolver.resolve).mockImplementation(async (did: string) => ({
      did,
      identityDidKey,
      messagingDidKey: "did:key:zMessaging",
      serviceBase: did === granteeDid ? "https://former-provider.example/hail" : serviceBase,
      evidence,
    }));

    await expect(
      context.receiver.receive(grantId, await signed(payload()), {
        ifMatch: null,
        ifNoneMatch: "*",
      }),
    ).rejects.toMatchObject({ status: 421, disclose: false });
    expect(context.accounts.getAccountByDid).not.toHaveBeenCalled();
    expect(context.findCurrentByGrantId).not.toHaveBeenCalled();
  });

  it("rereads an identical concurrent revision-1 winner and converges as 412", async () => {
    const context = fixture();
    const initialPayload = payload();
    const initial = await signed(initialPayload);
    const initialDigest = digest(initial);
    const winner: SignedGrantRevision = {
      localAccountId: account.id,
      localRole: "grantee",
      payload: initialPayload,
      representation: initial,
      digest: initialDigest,
      signingPublicKey: identityDidKey,
      signingPlcEvidence: evidence,
      receivedAt: new Date(nowSeconds * 1_000),
    };
    context.findCurrentByGrantId.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    context.acceptReceivedRevision.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }),
    );

    await expect(
      context.receiver.receive(grantId, initial, { ifMatch: null, ifNoneMatch: "*" }),
    ).resolves.toEqual({ status: 412, etag: etag(initial), created: false });
    expect(context.findCurrentByGrantId).toHaveBeenCalledTimes(2);
  });

  it("rejects conflicting bytes at the same revision and revision gaps", async () => {
    const { receiver } = fixture();
    const initial = await signed(payload());
    await receiver.receive(grantId, initial, { ifMatch: null, ifNoneMatch: "*" });

    const conflicting = await signed(
      payload({ scope: [{ type: "categories", values: ["security-alerts"] }] }),
    );
    await expect(
      receiver.receive(grantId, conflicting, { ifMatch: null, ifNoneMatch: "*" }),
    ).rejects.toMatchObject({ status: 409 });

    const gap = await signed(
      payload({ revision: 3, previous: digest(initial), updated_at: nowSeconds + 2 }),
    );
    await expect(
      receiver.receive(grantId, gap, { ifMatch: etag(initial), ifNoneMatch: null }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
