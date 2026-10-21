import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P256Keypair } from "@atproto/crypto";
import { encodeBase64Url, encodeDeterministic, type HailAddressBinding, type HailValue } from "@hailproto/codec";
import { base58btc } from "multiformats/bases/base58";
import { expect, it, vi } from "vitest";
import type { AccountApiClient } from "../src/account-api.js";
import { transitionToManaged, transitionToOwner } from "../src/custody-transition.js";
import { createUserVault, unlockUserVault, type UserVaultFile } from "../src/vault.js";

async function edKey() {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  return `did:key:${base58btc.encode(new Uint8Array([0xed, 1,
    ...new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))]))}`;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "hail-custody-transition-"));
  const vaultPath = join(directory, "vault.json"), statePath = join(directory, "state.json");
  const generated = await createUserVault(), owner = await unlockUserVault(generated.vault, generated.recoverySecret);
  const providerRotation = await P256Keypair.create(), messaging = await edKey();
  const genesis = await owner.signPlcOperation({ type: "plc_operation", prev: null,
    rotationKeys: [generated.vault.recovery.publicDidKey, providerRotation.did()],
    verificationMethods: { "hail-identity": generated.vault.identity.publicDidKey, "hail-messaging": messaging },
    alsoKnownAs: [], services: { hail: { type: "HailMessaging", endpoint: "https://provider.example.com/hail" } } });
  await owner.bindDid(genesis.did, genesis.operation);
  await writeFile(vaultPath, JSON.stringify(generated.vault), { mode: 0o600 });
  const currentState = { did: genesis.did, rotationKeys: genesis.operation.rotationKeys,
    verificationMethods: genesis.operation.verificationMethods, alsoKnownAs: genesis.operation.alsoKnownAs,
    services: genesis.operation.services };
  return { directory, vaultPath, statePath, generated, genesis, currentState };
}

function account(f: Awaited<ReturnType<typeof fixture>>, custodyProfile: "owner-controlled" | "managed", identityPublicKey: string) {
  return { provider: "https://provider.example.com", accountId: "11111111-1111-1111-1111-111111111111",
    did: f.genesis.did, address: "owner@provider.example.com", migrationState: null, custodyProfile,
    scopes: ["account:write"], monitorVerificationMode: null, identityPublicKey,
    ownerRecoveryPublicKey: f.generated.vault.recovery.publicDidKey, credential: null };
}

function preparation(f: Awaited<ReturnType<typeof fixture>>, oldIdentityKey: string, newIdentityKey: string,
  direction: "owner-to-managed" | "managed-to-owner", currentState = f.currentState) {
  const previousOperationCid = f.genesis.cid;
  return { transitionId: randomUUID(), accountId: "11111111-1111-1111-1111-111111111111", did: f.genesis.did,
    direction, ownerRecoveryKey: f.generated.vault.recovery.publicDidKey, oldIdentityKey, newIdentityKey,
    previousOperationCid, historyCheckpointDigest: encodeBase64Url(randomBytes(32)),
    bindingDigest: encodeBase64Url(randomBytes(32)), generationFrom: 1, generationTo: 2,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), currentState,
    unsignedOperation: { type: "plc_operation", prev: previousOperationCid, rotationKeys: currentState.rotationKeys,
      verificationMethods: { ...currentState.verificationMethods, "hail-identity": newIdentityKey },
      alsoKnownAs: currentState.alsoKnownAs, services: currentState.services } };
}

it("retains owner-to-managed state before commit and retries without preparing or reopening the vault", async () => {
  const f = await fixture(), managedIdentity = await edKey();
  const prepared = { ...preparation(f, f.generated.vault.identity.publicDidKey, managedIdentity, "owner-to-managed"),
    bindingCose: "binding" };
  let loseCommit = true;
  const request = vi.fn(async (path: string) => {
    if (path === "/custody/managed") return prepared;
    if (path === "/custody/managed/commit") {
      if (loseCommit) { loseCommit = false; throw new Error("response lost"); }
      return { transitionId: prepared.transitionId, did: f.genesis.did, state: "complete", generation: 2 };
    }
    throw new Error(`Unexpected request ${path}`);
  });
  const client = { account: vi.fn(async () => account(f, "owner-controlled", f.generated.vault.identity.publicDidKey)),
    request } as unknown as AccountApiClient;
  const recovery = vi.fn(async () => encodeBase64Url(f.generated.recoverySecret));
  try {
    await expect(transitionToManaged(client, f.vaultPath, f.statePath, recovery)).rejects.toThrow("response lost");
    const retained = await readFile(f.statePath, "utf8");
    expect(JSON.parse(retained)).toMatchObject({ transitionId: prepared.transitionId, direction: "owner-to-managed" });
    expect((await stat(f.statePath)).mode & 0o777).toBe(0o600);
    const legacy=JSON.parse(retained);delete legacy.generationTo;await writeFile(f.statePath,JSON.stringify(legacy));
    await rm(f.vaultPath);
    const result = await transitionToManaged(client, undefined, f.statePath, recovery);
    expect(result).toMatchObject({ custodyProfile: "managed", identityPublicKey: managedIdentity, generation: 2 });
    expect(request.mock.calls.filter(([path]) => path === "/custody/managed")).toHaveLength(1);
    expect(request.mock.calls.filter(([path]) => path === "/custody/managed/commit")).toHaveLength(2);
    expect(recovery).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(f.statePath,"utf8"))).toEqual(legacy);
  } finally { f.generated.recoverySecret.fill(0); await rm(f.directory, { recursive: true, force: true }); }
});

it("persists the replacement vault and managed-to-owner state before completing", async () => {
  const f = await fixture(), managedIdentity = await edKey();
  const managedState = { ...f.currentState,
    verificationMethods: { ...f.currentState.verificationMethods, "hail-identity": managedIdentity } };
  let prepared: ReturnType<typeof preparation> | undefined,loseCommit=true;
  const request = vi.fn(async (path: string, body?: Record<string, unknown>) => {
    if (path === "/custody/owner-controlled/review") {
      const newIdentityKey = body!.newIdentityKey as string;
      const savedVault = JSON.parse(await readFile(f.vaultPath, "utf8")) as UserVaultFile;
      expect(savedVault.identity.publicDidKey).toBe(newIdentityKey);
      expect(JSON.parse(await readFile(f.statePath, "utf8"))).toMatchObject({
        type: "hailp.custody-transition-key", newIdentityKey });
      expect((await stat(f.vaultPath)).mode & 0o777).toBe(0o600);
      expect((await stat(f.statePath)).mode & 0o777).toBe(0o600);
      const now = Math.floor(Date.now() / 1000);
      const binding: HailAddressBinding = { type: "hail.address-binding", version: 1,
        address: "owner@provider.example.com", did: f.genesis.did, issued_at: now, expires_at: now + 3600,
        key_id: `${f.genesis.did}#hail-identity` };
      return { direction: "managed-to-owner", accountId: account(f, "managed", managedIdentity).accountId,
        did: f.genesis.did, ownerRecoveryKey: f.generated.vault.recovery.publicDidKey,
        oldIdentityKey: managedIdentity, newIdentityKey, binding: encodeBase64Url(encodeDeterministic(binding as unknown as HailValue)),
        activeGrants: [], unsignedOperation: {} };
    }
    if (path === "/custody/owner-controlled") {
      prepared = preparation(f, managedIdentity, body!.newIdentityKey as string, "managed-to-owner", managedState);
      return prepared;
    }
    if (path === "/custody/managed/commit") {
      if(loseCommit){loseCommit=false;throw new Error("response lost");}
      return {transitionId: prepared!.transitionId, did: f.genesis.did, state: "complete", generation: 2};
    }
    throw new Error(`Unexpected request ${path}`);
  });
  const client = { account: vi.fn(async () => account(f, "managed", managedIdentity)), request } as unknown as AccountApiClient;
  const recovery=vi.fn(async () => encodeBase64Url(f.generated.recoverySecret));
  try {
    await expect(transitionToOwner(client,f.vaultPath,f.statePath,recovery)).rejects.toThrow("response lost");
    const retained=await readFile(f.statePath,"utf8"),savedAfterLoss=JSON.parse(await readFile(f.vaultPath,"utf8")) as UserVaultFile;
    const result = await transitionToOwner(client, f.vaultPath, f.statePath,recovery);
    const savedVault = JSON.parse(await readFile(f.vaultPath, "utf8")) as UserVaultFile;
    const savedState = JSON.parse(await readFile(f.statePath, "utf8"));
    expect(savedVault.identity.publicDidKey).toBe(result.identityPublicKey);
    expect(savedVault.identity.publicDidKey).toBe(savedAfterLoss.identity.publicDidKey);
    expect(savedVault.identity.publicDidKey).not.toBe(f.generated.vault.identity.publicDidKey);
    expect(savedState).toMatchObject({ type: "hailp.custody-transition-state", direction: "managed-to-owner",
      transitionId: prepared!.transitionId, newIdentityKey: savedVault.identity.publicDidKey });
    expect(result).toMatchObject({ custodyProfile: "owner-controlled", generation: 2 });
    expect(await readFile(f.statePath,"utf8")).toBe(retained);
    expect(request.mock.calls.filter(([path])=>path==="/custody/owner-controlled/review")).toHaveLength(1);
    expect(request.mock.calls.filter(([path])=>path==="/custody/owner-controlled")).toHaveLength(1);
    expect(recovery).toHaveBeenCalledTimes(1);
  } finally { f.generated.recoverySecret.fill(0); await rm(f.directory, { recursive: true, force: true }); }
});

it("refuses malformed or changed provider preparations", async () => {
  for (const kind of ["malformed", "changed"] as const) {
    const f = await fixture(), managedIdentity = await edKey();
    const prepared = { ...preparation(f, f.generated.vault.identity.publicDidKey, managedIdentity, "owner-to-managed"),
      bindingCose: "binding" };
    if (kind === "malformed") prepared.currentState = null as never;
    else prepared.unsignedOperation = { ...prepared.unsignedOperation, alsoKnownAs: ["at://changed.example.com"] };
    const request = vi.fn(async (path: string) => {
      if (path === "/custody/managed") return prepared;
      throw new Error("commit must not be reached");
    });
    const client = { account: async () => account(f, "owner-controlled", f.generated.vault.identity.publicDidKey),
      request } as unknown as AccountApiClient;
    try {
      await expect(transitionToManaged(client, f.vaultPath, f.statePath,
        async () => encodeBase64Url(f.generated.recoverySecret))).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
      await expect(stat(f.statePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { f.generated.recoverySecret.fill(0); await rm(f.directory, { recursive: true, force: true }); }
  }
});
