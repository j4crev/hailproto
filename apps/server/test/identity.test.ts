import { P256Keypair } from "@atproto/crypto";
import { validateOperationLog } from "@did-plc/lib";
import { describe, expect, it } from "vitest";
import { canonicalizeHailAddress } from "../src/identity/address.js";
import { KeyEncryptor } from "../src/identity/key-encryption.js";
import { generateAccountKeys, importEd25519PrivateKey } from "../src/identity/keys.js";
import { prepareGenesis } from "../src/plc/genesis.js";

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("canonicalizeHailAddress", () => {
  it("canonicalizes ASCII case", () => {
    expect(canonicalizeHailAddress("Alice@HAILPROTO.APP")).toBe("alice@hailproto.app");
  });

  it("rejects a domain without a registrable suffix", () => {
    expect(() => canonicalizeHailAddress("alice@localhost")).toThrow();
  });
});

describe("account keys", () => {
  it("generates distinct role keys and decrypts the bound private material", async () => {
    const accountId = crypto.randomUUID();
    const encryptor = new KeyEncryptor(encryptionKey);
    const generated = await generateAccountKeys(accountId, encryptor);

    expect(
      new Set([
        generated.rotationDidKey,
        generated.identityDidKey,
        generated.messagingDidKey,
      ]).size,
    ).toBe(3);

    const rotation = generated.keys.find((key) => key.role === "plc-rotation");
    const identity = generated.keys.find((key) => key.role === "hail-identity");
    if (!rotation || !identity) throw new Error("Generated role keys are incomplete");

    const rotationBytes = await encryptor.decrypt(
      accountId,
      rotation.role,
      rotation.algorithm,
      rotation.publicKey,
      rotation,
    );
    expect((await P256Keypair.import(rotationBytes)).did()).toBe(generated.rotationDidKey);

    const identityBytes = await encryptor.decrypt(
      accountId,
      identity.role,
      identity.algorithm,
      identity.publicKey,
      identity,
    );
    const identityPrivateKey = await importEd25519PrivateKey(identityBytes);
    expect(identityPrivateKey.algorithm.name).toBe("Ed25519");

    await expect(
      encryptor.decrypt(
        accountId,
        identity.role,
        identity.algorithm,
        `${identity.publicKey}tampered`,
        identity,
      ),
    ).rejects.toThrow();
  });
});

describe("PLC genesis", () => {
  it("creates a valid regular operation containing only Hail state", async () => {
    const keys = await generateAccountKeys(crypto.randomUUID(), new KeyEncryptor(encryptionKey));
    const genesis = await prepareGenesis({
      rotationKey: keys.rotationKey,
      identityDidKey: keys.identityDidKey,
      messagingDidKey: keys.messagingDidKey,
      hailServiceBase: "https://hailproto.app/hail",
    });

    expect(genesis.operation.type).toBe("plc_operation");
    expect(genesis.operation.prev).toBeNull();
    expect(genesis.operation.alsoKnownAs).toEqual([]);
    expect(genesis.operation.services).toEqual({
      hail: { type: "HailMessaging", endpoint: "https://hailproto.app/hail" },
    });
    expect(genesis.dagCbor.length).toBeLessThanOrEqual(4_000);
    expect(await validateOperationLog(genesis.did, [genesis.operation])).toEqual(
      genesis.expectedState,
    );
  });
});
