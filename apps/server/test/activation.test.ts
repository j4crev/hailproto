import { describe, expect, it, vi } from "vitest";
import type { VerifiedAddress } from "../src/discovery/verifier.js";
import type { PublishedAddressBinding } from "../src/discovery/store.js";
import {
  ActivationService,
  type ActivationRepository,
} from "../src/onboarding/activation.js";
import type { AccountRecord } from "../src/onboarding/repository.js";

const account: AccountRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  canonicalAddress: "alice@hailproto.app",
  did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
  state: "address-staged",
  activationAttemptId: null,
  activationVerificationMode: null,
};

const binding: PublishedAddressBinding = {
  id: "33333333-3333-4333-8333-333333333333",
  accountId: account.id,
  canonicalAddress: account.canonicalAddress,
  did: account.did!,
  cose: new Uint8Array([1, 2, 3]),
  digest: new Uint8Array(32).fill(4),
  issuedAt: new Date("2026-09-27T00:00:00Z"),
  expiresAt: new Date("2026-12-26T00:00:00Z"),
  publishedAt: null,
};

function repository(accountRecord: AccountRecord = account): ActivationRepository {
  return {
    getAccount: vi.fn(async () => accountRecord),
    getBindingForAccount: vi.fn(async () => binding),
    getKey: vi.fn(async () => ({
      accountId: account.id,
      role: "hail-messaging" as const,
      algorithm: "ed25519" as const,
      publicKey: "did:key:zMessaging",
      ciphertext: new Uint8Array([1]),
      nonce: new Uint8Array(12),
      encryptionVersion: 1 as const,
      kekId: "poc-v1" as const,
    })),
    beginActivation: vi.fn(async () => "44444444-4444-4444-8444-444444444444"),
    cancelActivation: vi.fn(async () => undefined),
    activateAccount: vi.fn(async () => undefined),
    promoteActivation: vi.fn(async () => undefined),
  };
}

function verifiedAddress(overrides: Partial<VerifiedAddress> = {}): VerifiedAddress {
  return {
    address: account.canonicalAddress,
    did: account.did!,
    serviceBase: "https://hailproto.app/hail",
    messagingDidKey: "did:key:zMessaging",
    identityDidKey: "did:key:zIdentity",
    plcEvidence: { document: {}, data: {}, log: [] },
    verifiedAt: new Date("2026-09-27T00:00:00Z"),
    binding: {
      version: 1,
      type: "hail.address-binding",
      address: account.canonicalAddress,
      did: account.did!,
      issued_at: 1,
      expires_at: 2,
      key_id: `${account.did}#hail-identity`,
    },
    representation: binding.cose,
    digest: binding.digest,
    ...overrides,
  };
}

describe("ActivationService", () => {
  it("activates only after the published representation verifies", async () => {
    const store = repository();
    const service = new ActivationService(
      store,
      { verify: vi.fn(async () => verifiedAddress()) },
      "https://hailproto.app/hail",
      "local",
    );

    await service.activate(account.id);

    expect(store.beginActivation).toHaveBeenCalledWith(account.id, binding.id);
    expect(store.activateAccount).toHaveBeenCalledWith(
      account.id,
      binding.id,
      binding.digest,
      "44444444-4444-4444-8444-444444444444",
      "local",
    );
    expect(store.cancelActivation).not.toHaveBeenCalled();
  });

  it("withdraws publication when verification does not match staged state", async () => {
    const store = repository();
    const service = new ActivationService(
      store,
      { verify: vi.fn(async () => verifiedAddress({ did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb" })) },
      "https://hailproto.app/hail",
      "local",
    );

    await expect(service.activate(account.id)).rejects.toThrow(
      "Published identity does not match staged account state",
    );
    expect(store.cancelActivation).toHaveBeenCalledWith(
      account.id,
      binding.id,
      "44444444-4444-4444-8444-444444444444",
    );
    expect(store.activateAccount).not.toHaveBeenCalled();
  });

  it("re-verifies a local activation before promoting it to public evidence", async () => {
    const store = repository({
      ...account,
      state: "active",
      activationVerificationMode: "local",
    });
    const verify = vi.fn(async () => verifiedAddress());
    const service = new ActivationService(
      store,
      { verify },
      "https://hailproto.app/hail",
      "public",
    );

    await service.activate(account.id);

    expect(verify).toHaveBeenCalledWith(account.canonicalAddress);
    expect(store.beginActivation).not.toHaveBeenCalled();
    expect(store.promoteActivation).toHaveBeenCalledWith(account.id, binding.id, binding.digest);
  });

  it("does not treat local activation as completed public activation", async () => {
    const store = repository({
      ...account,
      state: "active",
      activationVerificationMode: "local",
    });
    const service = new ActivationService(
      store,
      { verify: vi.fn(async () => verifiedAddress({ did: "did:plc:wrong" })) },
      "https://hailproto.app/hail",
      "public",
    );

    await expect(service.activate(account.id)).rejects.toThrow(
      "Published identity does not match staged account state",
    );
    expect(store.promoteActivation).not.toHaveBeenCalled();
    expect(store.cancelActivation).not.toHaveBeenCalled();
  });
});
