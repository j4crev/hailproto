import { createWebCryptoVerifier, verifySignedPayload } from "@hailproto/codec";
import { describe, expect, it, vi } from "vitest";
import { ed25519PublicKeyFromDidKey } from "../src/identity/did-key.js";
import { KeyEncryptor } from "../src/identity/key-encryption.js";
import { generateAccountKeys } from "../src/identity/keys.js";
import type { AccountRecord } from "../src/onboarding/repository.js";
import {
  parseSenderProfileDefinition,
  SenderProfileConflictError,
  SenderProfileService,
  type SenderProfileRepository,
} from "../src/profiles/service.js";
import type { StoredSenderProfile } from "../src/profiles/store.js";

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const avatar = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","base64").toString("base64url");

async function fixture() {
  const account: AccountRecord = {
    id: crypto.randomUUID(),
    tenantId: crypto.randomUUID(),
    canonicalAddress: "alice@hailproto.app",
    did,
    state: "active",
    activationAttemptId: null,
    activationVerificationMode: "public",
  };
  const encryptor = new KeyEncryptor(encryptionKey);
  const keys = await generateAccountKeys(account.id, encryptor);
  const messaging = keys.keys.find((key) => key.role === "hail-messaging");
  if (!messaging) throw new Error("Messaging key missing");
  let latest: StoredSenderProfile | null = null;
  const repository: SenderProfileRepository = {
    getAccountByAddress: vi.fn(async () => account),
    getKey: vi.fn(async () => ({ accountId: account.id, ...messaging })),
    getLatestSenderProfile: vi.fn(async () => latest),
    insertSenderProfile: vi.fn(async (profile, expected) => {
      if ((latest?.revision ?? 0) !== expected) throw new Error("revision conflict");
      latest = profile;
    }),
  };
  const resolver = {
    resolve: vi.fn(async () => ({
      did,
      identityDidKey: keys.identityDidKey,
      messagingDidKey: keys.messagingDidKey,
      serviceBase: "https://hailproto.app/hail",
      evidence: { document: {}, data: {}, log: [] },
    })),
  };
  return { account, encryptor, keys, repository, resolver };
}

describe("SenderProfileService", () => {
  it("creates, self-verifies, and idempotently reuses a profile", async () => {
    const { account, encryptor, keys, repository, resolver } = await fixture();
    const service = new SenderProfileService(
      repository,
      encryptor,
      resolver,
      "https://hailproto.app/hail",
      () => new Date("2026-09-27T00:00:00Z"),
    );
    const definition = {
      display_name: "Alice",
      offers_uncategorized: false,
      categories: [
        { id: "security-alerts", label: "Security alerts" },
        { id: "receipts", label: "Receipts" },
      ],
    };

    const created = await service.createOrReuse(account.canonicalAddress, definition);
    const retried = await service.createOrReuse(account.canonicalAddress, definition);

    expect(created.revision).toBe(1);
    expect(created.payload.categories.map((category) => category.id)).toEqual([
      "receipts",
      "security-alerts",
    ]);
    expect(retried).toBe(created);
    expect(repository.insertSenderProfile).toHaveBeenCalledTimes(1);
    const publicKey = await ed25519PublicKeyFromDidKey(keys.messagingDidKey);
    const verified = await verifySignedPayload(
      "hail.sender-profile",
      created.cose,
      createWebCryptoVerifier(async () => publicKey),
    );
    expect(verified.payload).toEqual(created.payload);
  });

  it("creates a strictly newer revision when authoring content changes", async () => {
    const { encryptor, repository, resolver } = await fixture();
    const service = new SenderProfileService(
      repository,
      encryptor,
      resolver,
      "https://hailproto.app/hail",
      () => new Date("2026-09-27T00:00:00Z"),
    );
    const first = await service.createOrReuse("alice@hailproto.app", {
      display_name: "Alice",
      offers_uncategorized: false,
      categories: [],
    },0);
    await expect(service.createOrReuse("alice@hailproto.app", {
      display_name:"Alice Updated",offers_uncategorized:false,categories:[],
    },0)).rejects.toBeInstanceOf(SenderProfileConflictError);
    const second = await service.createOrReuse("alice@hailproto.app", {
      display_name: "Alice Updated",
      offers_uncategorized: false,
      categories: [],
    },1);

    expect(second.revision).toBe(2);
    expect(second.updatedAt).toBe(first.updatedAt + 1);
    expect(await service.getLatest("alice@hailproto.app")).toBe(second);
  });

  it("strictly parses profile definitions",()=>{
    expect(parseSenderProfileDefinition({display_name:"Alice",offers_uncategorized:false,
      categories:[{id:"updates",label:"Updates"}]}).categories).toHaveLength(1);
    expect(()=>parseSenderProfileDefinition({display_name:"Alice",offers_uncategorized:false,categories:[],extra:true})).toThrow("invalid shape");
    const v2=parseSenderProfileDefinition({version:2,display_name:"Alice",offers_uncategorized:false,categories:[],avatar});
    expect(v2.avatar?.role).toBe("avatar");
    expect(v2.avatar?.width).toBe(1);
    expect(()=>parseSenderProfileDefinition({version:1,display_name:"Alice",offers_uncategorized:false,categories:[],avatar})).toThrow("v1");
  });

  it("creates and reuses a v2 profile with one bundled avatar",async()=>{
    const {account,encryptor,repository,resolver}=await fixture();
    const service=new SenderProfileService(repository,encryptor,resolver,"https://hailproto.app/hail");
    const definition=parseSenderProfileDefinition({version:2,display_name:"Alice",offers_uncategorized:false,categories:[],avatar});
    const created=await service.createOrReuse(account.canonicalAddress,definition);
    expect(created.payload.version).toBe(2);
    if(created.payload.version!==2)throw new Error("Expected Sender Profile v2");
    expect(created.payload.assets?.assets).toHaveLength(1);
    expect(await service.createOrReuse(account.canonicalAddress,definition)).toBe(created);
  });

  it("persists avatar removal in a signed revision without changing other profile fields", async () => {
    const {account, encryptor, repository, resolver, keys} = await fixture();
    const service = new SenderProfileService(repository, encryptor, resolver, "https://hailproto.app/hail");
    const base = {version: 2, display_name: "Alice", description: "About", offers_uncategorized: true,
      categories: [{id: "general", label: "General"}, {id: "news", label: "News"}]};
    const first = await service.createOrReuse(account.canonicalAddress, parseSenderProfileDefinition({...base, avatar}), 0);
    await expect(service.createOrReuse(account.canonicalAddress, parseSenderProfileDefinition(base), 0)).rejects.toBeInstanceOf(SenderProfileConflictError);
    const removed = await service.createOrReuse(account.canonicalAddress, parseSenderProfileDefinition(base), 1);
    expect(removed.payload).toMatchObject({...base, revision: 2});
    expect(removed.payload).not.toHaveProperty("assets");
    expect(await service.getLatest(account.canonicalAddress)).toBe(removed);
    expect(first.payload).toHaveProperty("assets");
    const publicKey = await ed25519PublicKeyFromDidKey(keys.messagingDidKey);
    const verified = await verifySignedPayload("hail.sender-profile", removed.cose, createWebCryptoVerifier(async () => publicKey));
    expect(verified.payload).toEqual(removed.payload);
  });

  it("rejects malformed and oversized avatar bytes before signing", () => {
    for (const bytes of [Buffer.from("not a PNG"), Buffer.concat([Buffer.from(avatar, "base64url"), Buffer.alloc(32768)])]) {
      expect(() => parseSenderProfileDefinition({version: 2, display_name: "Alice", offers_uncategorized: false, categories: [],
        avatar: bytes.toString("base64url")})).toThrow();
    }
  });

  it("refuses to sign when current PLC state names another messaging key", async () => {
    const { encryptor, repository, resolver } = await fixture();
    resolver.resolve.mockResolvedValue({
      did,
      identityDidKey: "did:key:zIdentity",
      messagingDidKey: "did:key:zWrong",
      serviceBase: "https://hailproto.app/hail",
      evidence: { document: {}, data: {}, log: [] },
    });
    const service = new SenderProfileService(
      repository,
      encryptor,
      resolver,
      "https://hailproto.app/hail",
    );

    await expect(
      service.createOrReuse("alice@hailproto.app", {
        display_name: "Alice",
        offers_uncategorized: false,
        categories: [],
      }),
    ).rejects.toThrow("does not authorize");
    expect(repository.insertSenderProfile).not.toHaveBeenCalled();
  });
});
