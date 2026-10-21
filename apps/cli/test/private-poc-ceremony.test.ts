import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { P256Keypair } from "@atproto/crypto";
import { assureValidSig, didForCreateOp, type Operation } from "@did-plc/lib";
import { encodeBase64Url } from "@hailproto/codec";
import { base58btc } from "multiformats/bases/base58";
import { describe, expect, it } from "vitest";
import { createUserVault, type UserVaultFile } from "../src/vault.js";

describe("POC user-owned genesis ceremony", () => {
  it("recovers the exact signed output after a restart without deriving a new DID", async () => {
    const folder = await mkdtemp("/tmp/opencode/hail-poc-client-");
    const vaultPath = join(folder, "user.vault.json");
    const preparationPath = join(folder, "provider-preparation.json");
    const outputPath = join(folder, "user-signed.json");
    const created = await createUserVault();
    try {
      await writeFile(vaultPath, JSON.stringify(created.vault), { mode: 0o600 });
      const rotation = await P256Keypair.create({ exportable: true });
      const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
      const publicBytes = new Uint8Array(34);
      publicBytes.set([0xed, 0x01]);
      publicBytes.set(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)), 2);
      const prepared = { accountId: crypto.randomUUID(), address: "alice@hailproto.app",
        userRecoveryKey: created.vault.recovery.publicDidKey,
        userIdentityKey: created.vault.identity.publicDidKey,
        providerRotationKey: rotation.did(),
        providerMessagingKey: `did:key:${base58btc.encode(publicBytes)}`,
        sourceServiceBase: "https://hailproto.app/hail" };
      await writeFile(preparationPath, JSON.stringify(prepared), { mode: 0o600 });
      const invoke = async () => {
        const child = Bun.spawn(["bun", "src/cli/sign-private-poc-onboarding.ts",
          vaultPath, preparationPath, outputPath], { cwd: new URL("..", import.meta.url).pathname,
          stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        child.stdin.write(`${encodeBase64Url(created.recoverySecret)}\n`);
        child.stdin.end();
        const status = await child.exited;
        if (status !== 0) throw new Error(await new Response(child.stderr).text());
      };
      await invoke();
      const first = await readFile(outputPath, "utf8");
      const signed = JSON.parse(first) as { did: string; operation: Operation };
      expect((await didForCreateOp(signed.operation))).toBe(signed.did);
      expect(await assureValidSig([created.vault.recovery.publicDidKey], signed.operation))
        .toBe(created.vault.recovery.publicDidKey);
      const updated = JSON.parse(await readFile(vaultPath, "utf8")) as UserVaultFile;
      expect(updated.did).toBe(signed.did);
      await invoke();
      expect(await readFile(outputPath, "utf8")).toBe(first);
      expect((JSON.parse(await readFile(vaultPath, "utf8")) as UserVaultFile).did).toBe(signed.did);
    } finally {
      created.recoverySecret.fill(0);
      await rm(folder, { recursive: true, force: true });
    }
  });
});
