import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebCryptoVerifier, encodeBase64Url, encodePayload, verifySignedPayload, type HailGrant } from "@hailproto/codec";
import { base58btc } from "multiformats/bases/base58";
import { expect, it, vi } from "vitest";
import { createUserVault, unlockUserIdentity, unlockUserVault } from "../src/vault.js";
import { createGrant } from "../src/grant-creation.js";
import { signGrantRevocation } from "../src/grant-revocation.js";
import type { AccountApiClient } from "../src/account-api.js";

const input = vi.hoisted(() => ({ secret: "" }));
vi.mock("../src/cli/private-input.js", () => ({ readRecoverySecret: async () => input.secret }));

it("creates, retries and revokes Grants without decrypting recovery, while full unlock still requires it", async () => {
  const generated = await createUserVault();
  const dir = await mkdtemp(join(tmpdir(), "hail-identity-only-"));
  try {
    const vault = structuredClone(generated.vault);
    vault.did = `did:plc:${"a".repeat(24)}`;
    // An unreadable recovery ciphertext makes any accidental full unlock fail.
    vault.recovery.ciphertext = "AA";
    input.secret = encodeBase64Url(generated.recoverySecret);
    await expect(unlockUserVault(vault, generated.recoverySecret)).rejects.toThrow();
    await expect(unlockUserIdentity(vault, randomBytes(32))).rejects.toThrow();
    await expect(unlockUserIdentity({ ...vault, identity: { ...vault.identity, ciphertext: "AA" } }, generated.recoverySecret)).rejects.toThrow();
    const other = await createUserVault();
    try {
      await expect(unlockUserIdentity({ ...vault, identity: { ...vault.identity,
        publicDidKey: other.vault.identity.publicDidKey } }, generated.recoverySecret)).rejects.toThrow();
    } finally { other.recoverySecret.fill(0); }
    const signer = await unlockUserIdentity(vault, generated.recoverySecret);
    expect(Object.keys(signer)).toEqual(["vault", "signGrant", "signAddressBinding", "signTransferGrant", "signTransferCancellation", "signTransferAddressSelection", "signAccountAccess"]);
    const now = Math.floor(Date.now() / 1000);
    const hash = { algorithm: "sha-256" as const, value: new Uint8Array(32) };
    const grant: HailGrant = { type: "hail.grant", version: 1,
      grant_id: "01954144-8097-7a9d-a7a8-ef29a823eaf1", revision: 1, previous: null,
      grantor: vault.did, grantee: `did:plc:${"b".repeat(24)}`,
      scope: [{ type: "categories", values: ["updates"] }], status: "active",
      issued_at: now, updated_at: now, expires_at: null,
      consent_context: { grantee_address: "bob@example.com", address_binding_hash: hash, sender_profile_hash: hash },
      key_id: `${vault.did}#hail-identity` };
    const publicBytes = base58btc.decode(vault.identity.publicDidKey.slice(8));
    const publicKey = await crypto.subtle.importKey("raw", publicBytes.slice(2), "Ed25519", false, ["verify"]);
    const verifier = createWebCryptoVerifier(async () => publicKey);
    const signed = await signer.signGrant(grant);
    expect((await verifySignedPayload("hail.grant", signed, verifier)).payload).toEqual(grant);
    await expect(signer.signGrant({ ...grant, grantor: grant.grantee })).rejects.toThrow("signer DID");
    await expect(signer.signGrant({ ...grant, key_id: `${vault.did}#hail-messaging` })).rejects.toThrow("signer DID");

    const vaultPath = join(dir, "vault.json");
    await writeFile(vaultPath, JSON.stringify(vault), { mode: 0o600 });
    let proposals = 0;
    const client = { account: async () => ({ did: vault.did, custodyProfile: "owner-controlled",
      migrationState: null, scopes: ["grants:write"] }),
      propose: async () => { proposals++; return grant; },
      submit: async (bytes: Uint8Array) => (await verifySignedPayload("hail.grant", bytes, verifier)).payload,
    } as unknown as AccountApiClient;
    const output = join(dir, "grant.cose");
    expect(await createGrant(client, "bob@example.com", "updates", vaultPath, output, null)).toEqual(grant);
    expect(await createGrant(client, "bob@example.com", "updates", vaultPath, output, null)).toEqual(grant);
    expect(proposals).toBe(1);
    expect(new Uint8Array(await readFile(output))).toEqual(signed);

    const revokedPath = join(dir, "revoked.cose");
    const revoke = () => signGrantRevocation(vaultPath, signed, grant.grant_id, "bob@example.com",
      revokedPath, generated.recoverySecret, vault.did!);
    const revoked = await revoke();
    expect((await verifySignedPayload("hail.grant", revoked, verifier)).payload.status).toBe("revoked");
    expect(await revoke()).toEqual(revoked);
    await expect(signGrantRevocation(vaultPath, signed, grant.grant_id, "bob@example.com",
      revokedPath, generated.recoverySecret, grant.grantee)).rejects.toThrow("authenticated account");

    const proposal = join(dir, "proposal.json");
    await writeFile(proposal, JSON.stringify({ type: "hail.user-grant-proposal", version: 1,
      grantorAddress: "alice@example.com", granteeAddress: "bob@example.com",
      payload: encodeBase64Url(encodePayload("hail.grant", grant)) }), { mode: 0o600 });
    const legacyOutput = join(dir, "legacy.cose");
    const child = Bun.spawn(["bun", "src/cli/sign-private-poc-grant.ts", vaultPath, proposal,
      "alice@example.com", "bob@example.com", legacyOutput], { cwd: new URL("..", import.meta.url).pathname,
      stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(`${input.secret}\n`);
    child.stdin.end();
    const error = await new Response(child.stderr).text();
    expect(await child.exited, error).toBe(0);
    expect(new Uint8Array(await readFile(legacyOutput))).toEqual(signed);
  } finally {
    input.secret = "";
    generated.recoverySecret.fill(0);
    await rm(dir, { recursive: true, force: true });
  }
});
