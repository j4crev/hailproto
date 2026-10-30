import { expect, it } from "vitest";
import { createSignupBackup, encodeBase64Url, verifySignupBackup, signSignupGenesis } from "./signup-recovery.js";
import { unlockUserVault } from "../../../server/test/client-support/vault.js";
import { assureValidSig, didForCreateOp } from "@did-plc/lib";
import { cidForCbor } from "@atproto/common";
import type { PublicOnboardingPreparation } from "../../../server/src/onboarding/public.js";

it("verifies the actual saved signup backup and remains compatible with hailp", async () => {
  const generated = await createSignupBackup();
  try {
    const text = JSON.stringify(generated.vault), secret = encodeBase64Url(generated.recoverySecret);
    await verifySignupBackup(text, secret, generated.vault);
    const restored = await unlockUserVault(JSON.parse(text), generated.recoverySecret);
    expect(restored.vault.recovery.publicDidKey).toBe(generated.vault.recovery.publicDidKey);
    await expect(verifySignupBackup(text, "A".repeat(43), generated.vault)).rejects.toThrow();
    await expect(verifySignupBackup(text, secret + "A", generated.vault)).rejects.toThrow();
    await expect(verifySignupBackup(" ".repeat(16_385), secret, generated.vault)).rejects.toThrow();
    await expect(verifySignupBackup(JSON.stringify({ ...generated.vault, token: "unexpected" }), secret, generated.vault))
      .rejects.toThrow("representation");
    await expect(verifySignupBackup(JSON.stringify({ ...generated.vault, did: `did:plc:${"a".repeat(24)}` }), secret, generated.vault))
      .rejects.toThrow("different signup");
    const changed = structuredClone(generated.vault);
    changed.recovery.ciphertext = "AA";
    await expect(verifySignupBackup(JSON.stringify(changed), secret, generated.vault)).rejects.toThrow();
    const other = await createSignupBackup();
    try { await expect(verifySignupBackup(JSON.stringify(other.vault), secret, generated.vault)).rejects.toThrow("different signup"); }
    finally { other.recoverySecret.fill(0); }
  } finally { generated.recoverySecret.fill(0); }
});

it("signs exactly reviewed managed genesis with official PLC-compatible DID, CID and signature", async () => {
  const [owner, provider, messaging] = await Promise.all([createSignupBackup(), createSignupBackup(), createSignupBackup()]);
  try {
    const expected = { provider: "https://provider.example", address: "alice@provider.example",
      monitorOrigin: "https://monitor.example", monitorKey: messaging.vault.identity.publicDidKey };
    const prepared: PublicOnboardingPreparation = {
      accountId: "12345678-1234-1234-1234-123456789abc", address: expected.address,
      userRecoveryKey: owner.vault.recovery.publicDidKey, userIdentityKey: provider.vault.identity.publicDidKey,
      providerRotationKey: provider.vault.recovery.publicDidKey, providerMessagingKey: messaging.vault.identity.publicDidKey,
      sourceServiceBase: `${expected.provider}/hail`, custodyProfile: "managed", managedProfileVersion: "hail-managed-custody-v1",
      monitorOrigin: expected.monitorOrigin, monitorPublicKey: expected.monitorKey, monitorAssurance: "reduced-assurance-alpha-v1",
    };
    const customExpected={...expected,address:"alice@j4crev.com",addressAuthorization:"haild_"+"A".repeat(43)};
    const customPrepared={...prepared,address:customExpected.address};
    expect((await signSignupGenesis(owner.vault,owner.recoverySecret,customPrepared,customExpected)).did).toMatch(/^did:plc:/);
    await expect(signSignupGenesis(owner.vault,owner.recoverySecret,customPrepared,{...customExpected,addressAuthorization:undefined})).rejects.toThrow();
    await expect(signSignupGenesis(owner.vault,owner.recoverySecret,{...customPrepared,address:"bob@j4crev.com"},customExpected)).rejects.toThrow();
    const signed = await signSignupGenesis(owner.vault, owner.recoverySecret, prepared, expected);
    expect(await assureValidSig([owner.vault.recovery.publicDidKey], signed.operation)).toBe(owner.vault.recovery.publicDidKey);
    expect(await didForCreateOp(signed.operation)).toBe(signed.did);
    expect((await cidForCbor(signed.operation)).toString()).toBe(signed.cid);
    const cli = await unlockUserVault(structuredClone(owner.vault), owner.recoverySecret);
    const { sig, ...unsigned } = signed.operation;
    expect(await cli.signManagedGenesis(unsigned)).toEqual({ operation: signed.operation, did: signed.did });
    expect(owner.vault.did).toBeNull(); // Caller must durably retain the result before submission.
    for (const changed of [
      { sourceServiceBase: "https://attacker.example/hail" }, { address: "bob@provider.example" },
      { userRecoveryKey: provider.vault.recovery.publicDidKey }, { custodyProfile: "owner-controlled" },
      { monitorAssurance: "independent" }, { monitorPublicKey: provider.vault.identity.publicDidKey },
      { userIdentityKey: owner.vault.identity.publicDidKey }, { providerMessagingKey: provider.vault.identity.publicDidKey },
      { providerRotationKey: provider.vault.identity.publicDidKey },
    ]) await expect(signSignupGenesis(owner.vault, owner.recoverySecret, { ...prepared, ...changed } as PublicOnboardingPreparation, expected))
      .rejects.toThrow();
    await expect(signSignupGenesis({ ...owner.vault, did: signed.did }, owner.recoverySecret, prepared, expected)).rejects.toThrow("Bound vault");
  } finally { for (const generated of [owner, provider, messaging]) generated.recoverySecret.fill(0); }
});
