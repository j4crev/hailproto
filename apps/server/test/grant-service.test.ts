import { createHash } from "node:crypto";
import {
  createWebCryptoVerifier,
  createWebCryptoSigner,
  signPayload,
  verifySignedPayload,
  type HailGrant,
  type HailGrantScope,
} from "@hailproto/codec";
import { base58btc } from "multiformats/bases/base58";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { VerifiedAddress } from "../src/discovery/verifier.js";
import { GrantService, type GrantDefinition } from "../src/grants/service.js";
import type {
  AuthoritativeGrantRevision1,
  AuthoritativeGrantRevocation,
  GrantStore,
  SignedGrantRevision,
} from "../src/grants/store.js";
import { ed25519PublicKeyFromDidKey } from "../src/identity/did-key.js";
import type { KeyEncryptor } from "../src/identity/key-encryption.js";
import type { AccountKeyRecord, AccountRecord } from "../src/onboarding/repository.js";
import type { HailDidResolver } from "../src/plc/resolver.js";
import type { VerifiedSenderProfile } from "../src/profiles/store.js";

const now = new Date("2026-09-27T12:34:56.789Z");
const nowSeconds = Math.floor(now.getTime() / 1_000);
const grantorDid = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const granteeDid = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
const grantorService = "https://grantor.example.com/hail";
const granteeService = "https://grantee.example.com/hail";
const evidence = { document: {}, data: {}, log: [] };
const addressDigest = new Uint8Array(32).fill(3);
const profileDigest = new Uint8Array(32).fill(4);

let identityPkcs8: Uint8Array;
let identityDidKey: string;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  identityPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const multicodecKey = new Uint8Array(34);
  multicodecKey.set([0xed, 0x01]);
  multicodecKey.set(raw, 2);
  identityDidKey = `did:key:${base58btc.encode(multicodecKey)}`;
});

const account: AccountRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  canonicalAddress: "alice@grantor.example.com",
  did: grantorDid,
  state: "active",
  activationAttemptId: null,
  activationVerificationMode: "public",
};

function identityKey(): AccountKeyRecord {
  return {
    accountId: account.id,
    role: "hail-identity",
    algorithm: "ed25519",
    publicKey: identityDidKey,
    ciphertext: new Uint8Array([1]),
    nonce: new Uint8Array(12),
    encryptionVersion: 1,
    kekId: "poc-v1",
  };
}

function verifiedAddress(): VerifiedAddress {
  return {
    address: "notices@grantee.example.com",
    did: granteeDid,
    serviceBase: granteeService,
    messagingDidKey: "did:key:zGranteeMessaging",
    identityDidKey: "did:key:zGranteeIdentity",
    plcEvidence: evidence,
    verifiedAt: now,
    binding: {
      type: "hail.address-binding",
      version: 1,
      address: "notices@grantee.example.com",
      did: granteeDid,
      issued_at: nowSeconds,
      expires_at: nowSeconds + 3600,
      key_id: `${granteeDid}#hail-identity`,
    },
    representation: new Uint8Array([10, 11]),
    digest: addressDigest,
  };
}

function verifiedProfile(): VerifiedSenderProfile {
  return {
    did: granteeDid,
    serviceBase: granteeService,
    messagingDidKey: "did:key:zGranteeMessaging",
    profile: {
      type: "hail.sender-profile",
      version: 1,
      did: granteeDid,
      revision: 7,
      updated_at: nowSeconds - 60,
      display_name: "Grantee",
      offers_uncategorized: false,
      categories: [
        { id: "receipts", label: "Receipts" },
        { id: "security-alerts", label: "Security alerts" },
      ],
      key_id: `${granteeDid}#hail-messaging`,
    },
    representation: new Uint8Array([12, 13]),
    digest: profileDigest,
    etag: "retained-profile-etag",
    plcEvidence: evidence,
    verifiedAt: now,
  };
}

function fixture() {
  let active: SignedGrantRevision | null = null;
  let current: SignedGrantRevision | null = null;
  const accounts = {
    getAccountByAddress: vi.fn(async () => account),
    getKey: vi.fn(async () => identityKey()),
  };
  const decrypt = vi.fn(async () => Uint8Array.from(identityPkcs8));
  const encryptor = { decrypt } as unknown as KeyEncryptor;
  const address = verifiedAddress();
  const profile = verifiedProfile();
  const addressVerifier = { verify: vi.fn(async () => address) };
  const profileVerifier = { verify: vi.fn(async () => profile) };
  const resolver: HailDidResolver = {
    resolve: vi.fn(async (did: string) => ({
      did,
      identityDidKey: did === grantorDid ? identityDidKey : address.identityDidKey,
      messagingDidKey: address.messagingDidKey,
      serviceBase: did === grantorDid ? grantorService : granteeService,
      evidence,
    })),
  };
  const insertAuthoritativeRevision1 = vi.fn(async (input: AuthoritativeGrantRevision1) => {
    active = { ...input.revision, receivedAt: now };
    current = active;
  });
  const appendAuthoritativeRevocation = vi.fn(async (input: AuthoritativeGrantRevocation) => {
    current = { ...input.revision, receivedAt: now };
    active = null;
  });
  const grants = {
    findActiveAuthoritativeByDidPair: vi.fn(async () => active),
    findCurrentByGrantId: vi.fn(async () => current),
    insertAuthoritativeRevision1,
    appendAuthoritativeRevocation,
  } as unknown as GrantStore;
  const service = new GrantService(
    accounts,
    grants,
    encryptor,
    resolver,
    addressVerifier,
    profileVerifier,
    grantorService,
    () => new Date(now),
  );
  return {
    service,
    accounts,
    decrypt,
    address,
    profile,
    addressVerifier,
    profileVerifier,
    resolver,
    insertAuthoritativeRevision1,
    appendAuthoritativeRevocation,
  };
}

const definition: GrantDefinition = {
  scope: { type: "categories", values: ["security-alerts", "receipts"] },
  expiresAt: nowSeconds + 3600,
};

function uuidTimestamp(uuid: string): number {
  return Number.parseInt(uuid.replaceAll("-", "").slice(0, 12), 16);
}

describe("GrantService", () => {
  it("imports user-signed terminal revocation without provider custody or sender discovery", async () => {
    const context = fixture();
    const initial = await context.service.prepareUserSignedGrant(account.canonicalAddress,
      context.address.address, definition);
    const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(identityPkcs8), "Ed25519", false, ["sign"]);
    const sign = (payload: HailGrant) => signPayload("hail.grant", payload,
      createWebCryptoSigner(`${grantorDid}#hail-identity`, key));
    const stored = await context.service.acceptUserSignedGrant(account.canonicalAddress,
      context.address.address, await sign(initial));
    context.addressVerifier.verify.mockClear().mockRejectedValue(new Error("Sender address offline"));
    context.profileVerifier.verify.mockClear().mockRejectedValue(new Error("Sender profile offline"));
    const payload: HailGrant = { ...stored.payload, status: "revoked", revision: 2,
      previous: stored.digest, updated_at: stored.payload.updated_at + 1 };
    const representation = await sign(payload);
    const revoked = await context.service.acceptUserSignedGrant(account.canonicalAddress,
      context.address.address, representation);
    expect(revoked.payload).toEqual(payload);
    expect(await context.service.acceptUserSignedGrant(account.canonicalAddress,
      context.address.address, representation)).toEqual(revoked);
    expect(context.appendAuthoritativeRevocation).toHaveBeenCalledOnce();
    expect(context.accounts.getKey).not.toHaveBeenCalled();
    expect(context.decrypt).not.toHaveBeenCalled();
    expect(context.addressVerifier.verify).not.toHaveBeenCalled();
    expect(context.profileVerifier.verify).not.toHaveBeenCalled();
    await expect(context.service.acceptUserSignedGrant(account.canonicalAddress,
      context.address.address, await sign({ ...payload, updated_at: payload.updated_at + 1 })))
      .rejects.toThrow("conflict");
  });

  it("imports only an exact user-key-signed Grant against current address and profile evidence", async () => {
    const context = fixture();
    const proposed = await context.service.prepareUserSignedGrant(account.canonicalAddress,
      context.address.address, definition);
    expect(proposed.scope).toEqual([{ type: "categories", values: ["receipts", "security-alerts"] }]);
    expect(context.accounts.getKey).not.toHaveBeenCalled();
    expect(context.decrypt).not.toHaveBeenCalled();
    const signer = await crypto.subtle.importKey("pkcs8", Uint8Array.from(identityPkcs8),
      "Ed25519", false, ["sign"]);
    const representation = await signPayload("hail.grant", proposed,
      createWebCryptoSigner(`${grantorDid}#hail-identity`, signer));
    const imported = await context.service.acceptUserSignedGrant(account.canonicalAddress,
      context.address.address, representation);
    expect(imported.payload).toEqual(proposed);
    expect(imported.signingPublicKey).toBe(identityDidKey);
    expect(context.insertAuthoritativeRevision1).toHaveBeenCalledOnce();
    expect(context.accounts.getKey).not.toHaveBeenCalled();
    expect(context.decrypt).not.toHaveBeenCalled();
    expect((await context.service.acceptUserSignedGrant(account.canonicalAddress,
      context.address.address, representation)).representation).toEqual(representation);
    const forged = Uint8Array.from(representation);
    forged[forged.length - 1] = forged[forged.length - 1]! ^ 1;
    await expect(context.service.acceptUserSignedGrant(account.canonicalAddress,
      context.address.address, forged)).rejects.toThrow();
  });

  it("creates revision 1 signed by hail-identity with UUIDv7, timestamps, and consent hashes", async () => {
    const context = fixture();
    const created = await context.service.createOrReuse(
      "Alice@Grantor.Example.Com",
      "Notices@Grantee.Example.Com",
      definition,
    );

    expect(created.payload).toMatchObject({
      type: "hail.grant",
      version: 1,
      revision: 1,
      previous: null,
      grantor: grantorDid,
      grantee: granteeDid,
      scope: [{ type: "categories", values: ["receipts", "security-alerts"] }],
      status: "active",
      issued_at: nowSeconds,
      updated_at: nowSeconds,
      expires_at: nowSeconds + 3600,
      key_id: `${grantorDid}#hail-identity`,
    });
    expect(created.payload.grant_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(uuidTimestamp(created.payload.grant_id)).toBe(now.getTime());
    expect(created.payload.consent_context.address_binding_hash).toEqual({
      algorithm: "sha-256",
      value: addressDigest,
    });
    expect(created.payload.consent_context.sender_profile_hash).toEqual({
      algorithm: "sha-256",
      value: profileDigest,
    });
    expect(created.digest).toEqual(
      new Uint8Array(createHash("sha256").update(created.representation).digest()),
    );

    const publicKey = await ed25519PublicKeyFromDidKey(identityDidKey);
    await expect(
      verifySignedPayload(
        "hail.grant",
        created.representation,
        createWebCryptoVerifier(async (keyId) => {
          expect(keyId).toBe(`${grantorDid}#hail-identity`);
          return publicKey;
        }),
      ),
    ).resolves.toMatchObject({ payload: created.payload });
    expect(context.accounts.getKey).toHaveBeenCalledWith(account.id, "hail-identity");
    expect(context.decrypt).toHaveBeenCalledOnce();
    expect(context.insertAuthoritativeRevision1).toHaveBeenCalledWith({
      revision: expect.objectContaining({ payload: created.payload }),
      consent: { address: context.address, senderProfile: context.profile },
      destinationServiceBase: granteeService,
    });
  });

  it("validates categories against the retained verified Sender Profile", async () => {
    const context = fixture();

    await expect(
      context.service.createOrReuse("alice@grantor.example.com", "notices@grantee.example.com", {
        scope: { type: "categories", values: ["not-offered"] },
        expiresAt: null,
      }),
    ).rejects.toThrow("category not offered");
    expect(context.profileVerifier.verify).toHaveBeenCalledWith(granteeDid);
    expect(context.decrypt).not.toHaveBeenCalled();
    expect(context.insertAuthoritativeRevision1).not.toHaveBeenCalled();
  });

  it("idempotently reuses an active grant with the same normalized definition and evidence", async () => {
    const context = fixture();
    const first = await context.service.createOrReuse(
      account.canonicalAddress,
      context.address.address,
      definition,
    );
    const retried = await context.service.createOrReuse(
      account.canonicalAddress,
      context.address.address,
      {
        ...definition,
        scope: { type: "categories", values: ["receipts", "security-alerts"] },
      },
    );

    expect(retried.payload.grant_id).toBe(first.payload.grant_id);
    expect(retried.representation).toEqual(first.representation);
    expect(context.insertAuthoritativeRevision1).toHaveBeenCalledOnce();
    expect(context.decrypt).toHaveBeenCalledOnce();
  });

  it("rejects a different definition for an active grant pair", async () => {
    const context = fixture();
    await context.service.createOrReuse(account.canonicalAddress, context.address.address, definition);

    await expect(
      context.service.createOrReuse(account.canonicalAddress, context.address.address, {
        scope: { type: "categories", values: ["receipts"] },
        expiresAt: definition.expiresAt,
      }),
    ).rejects.toThrow("active Grant already exists");
    expect(context.insertAuthoritativeRevision1).toHaveBeenCalledOnce();
  });

  it.each([
    ["identity key", { identityDidKey: "did:key:zNotCurrent" }],
    ["service", { serviceBase: "https://former-provider.example/hail" }],
  ])("requires the grantor PLC current %s", async (_label, override) => {
    const context = fixture();
    vi.mocked(context.resolver.resolve).mockResolvedValueOnce({
      did: grantorDid,
      identityDidKey,
      messagingDidKey: "did:key:zGrantorMessaging",
      serviceBase: grantorService,
      evidence,
      ...override,
    });

    await expect(
      context.service.createOrReuse(account.canonicalAddress, context.address.address, definition),
    ).rejects.toThrow("Current PLC state does not authorize");
    expect(context.addressVerifier.verify).not.toHaveBeenCalled();
    expect(context.decrypt).not.toHaveBeenCalled();
  });

  it("creates a terminal revocation carrying scope and consent while advancing lineage metadata", async () => {
    const context = fixture();
    const created = await context.service.createOrReuse(
      account.canonicalAddress,
      context.address.address,
      definition,
    );
    const revoked = await context.service.revoke(account.canonicalAddress, created.payload.grant_id);

    expect(revoked.payload).toMatchObject({
      grant_id: created.payload.grant_id,
      revision: 2,
      status: "revoked",
      issued_at: created.payload.issued_at,
      updated_at: created.payload.updated_at + 1,
      expires_at: created.payload.expires_at,
      scope: created.payload.scope,
      consent_context: created.payload.consent_context,
    });
    expect(revoked.payload.previous).toEqual(created.digest);
    expect(context.appendAuthoritativeRevocation).toHaveBeenCalledWith({
      revision: expect.objectContaining({ payload: revoked.payload }),
      expectedCurrentRevision: 1,
      expectedCurrentDigest: created.digest,
    });

    const terminalRetry = await context.service.revoke(
      account.canonicalAddress,
      created.payload.grant_id,
    );
    expect(terminalRetry).toStrictEqual(revoked);
    expect(context.appendAuthoritativeRevocation).toHaveBeenCalledOnce();
    expect(context.decrypt).toHaveBeenCalledTimes(2);
  });

  it("revokes without resolving or otherwise depending on the grantee PLC", async () => {
    const context = fixture();
    const created = await context.service.createOrReuse(
      account.canonicalAddress,
      context.address.address,
      definition,
    );
    vi.mocked(context.resolver.resolve).mockClear();
    vi.mocked(context.resolver.resolve).mockImplementation(async (did: string) => {
      if (did === granteeDid) throw new Error("Grantee PLC is unavailable");
      return {
        did,
        identityDidKey,
        messagingDidKey: "did:key:zGrantorMessaging",
        serviceBase: grantorService,
        evidence,
      };
    });

    await expect(
      context.service.revoke(account.canonicalAddress, created.payload.grant_id),
    ).resolves.toMatchObject({ payload: { status: "revoked" } });
    expect(context.resolver.resolve).toHaveBeenCalledOnce();
    expect(context.resolver.resolve).toHaveBeenCalledWith(grantorDid);
  });
});
