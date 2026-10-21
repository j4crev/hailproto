import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P256Keypair, Secp256k1Keypair } from "@atproto/crypto";
import { assureValidSig, didForCreateOp, signOperation, type UnsignedOperation } from "@did-plc/lib";
import { encodeBase64Url } from "@hailproto/codec";
import { base58btc } from "multiformats/bases/base58";
import { expect, it, vi } from "vitest";
import { createUserVault, unlockUserVault } from "../src/vault.js";
import { createAccount } from "../src/account-creation.js";
import { AccountApiClient } from "../src/account-api.js";

async function edKey() {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  return `did:key:${base58btc.encode(new Uint8Array([0xed, 1, ...new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))]))}`;
}

it("MC-01: requires the frozen profile on strict-public managed account records",async()=>{
  const provider="https://provider.example.com",identity=await edKey(),owner=await P256Keypair.create();
  const account={type:"hailp.account",version:1,provider,accountId:"",did:`did:plc:${"a".repeat(24)}`,
    address:"owner@provider.example.com",migrationState:null,custodyProfile:"managed",monitorVerificationMode:"strict-public-v1",
    identityPublicKey:identity,ownerRecoveryPublicKey:owner.did(),scopes:["account:read"],credential:undefined};
  vi.stubGlobal("fetch",async()=>new Response(JSON.stringify(account),{headers:{"Content-Type":"application/json"}}));
  try {
    const client=AccountApiClient.signup(provider,`hailp_${encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`);
    await expect(client.account()).rejects.toThrow("contract");
    vi.stubGlobal("fetch",async()=>new Response(JSON.stringify({...account,managedProfileVersion:"hail-managed-custody-v1"}),
      {headers:{"Content-Type":"application/json"}}));
    await expect(client.account()).resolves.toMatchObject({custodyProfile:"managed",managedProfileVersion:"hail-managed-custody-v1"});
  }finally{vi.unstubAllGlobals();}
});

it("MC-02/03: signs only the reviewed managed new-genesis subset and rechecks it when binding", async () => {
  const generated = await createUserVault();
  try {
    const vault = structuredClone(generated.vault), signer = await unlockUserVault(vault, generated.recoverySecret);
    const rotation = await P256Keypair.create({ exportable: true }), identity = await edKey(), messaging = await edKey();
    const unsigned: UnsignedOperation = { type: "plc_operation", prev: null,
      rotationKeys: [vault.recovery.publicDidKey, rotation.did()],
      verificationMethods: { "hail-identity": identity, "hail-messaging": messaging },
      services: { hail: { type: "HailMessaging", endpoint: "https://provider.example.com/tenants/opaque/hail" } }, alsoKnownAs: [] };
    const signed = await signer.signManagedGenesis(unsigned);
    expect(await assureValidSig([vault.recovery.publicDidKey], signed.operation)).toBe(vault.recovery.publicDidKey);
    expect(await didForCreateOp(signed.operation)).toBe(signed.did);
    const secp = await Secp256k1Keypair.create();
    expect(await signer.signManagedGenesis({ ...unsigned, rotationKeys: [vault.recovery.publicDidKey, secp.did()] })).toHaveProperty("did");
    const invalid = [
      { ...unsigned, prev: "not-genesis" },
      { ...unsigned, rotationKeys: [rotation.did(), vault.recovery.publicDidKey] },
      { ...unsigned, rotationKeys: [vault.recovery.publicDidKey, vault.recovery.publicDidKey] },
      { ...unsigned, rotationKeys: [vault.recovery.publicDidKey, identity] },
      { ...unsigned, rotationKeys: [vault.recovery.publicDidKey, "did:key:zINVALID"] },
      { ...unsigned, rotationKeys: [...unsigned.rotationKeys, secp.did()] },
      { ...unsigned, verificationMethods: { "hail-identity": messaging, "hail-messaging": messaging } },
      { ...unsigned, verificationMethods: { "hail-identity": rotation.did(), "hail-messaging": messaging } },
      { ...unsigned, verificationMethods: { "hail-identity": `did:key:${base58btc.encode(new Uint8Array([0xed, 1, 1]))}`, "hail-messaging": messaging } },
      { ...unsigned, verificationMethods: { "hail-identity": identity } },
      { ...unsigned, verificationMethods: { ...unsigned.verificationMethods, unrelated: identity } },
      { ...unsigned, verificationMethods: { "hail-identity": vault.identity.publicDidKey, "hail-messaging": messaging } },
      { ...unsigned, verificationMethods: { "hail-identity": identity, "hail-messaging": vault.identity.publicDidKey } },
      { ...unsigned, alsoKnownAs: ["at://private-owner.example.com"] },
      { ...unsigned, services: {} },
      { ...unsigned, services: { ...unsigned.services, unrelated: unsigned.services.hail! } },
      { ...unsigned, services: { hail: { type: "OtherService", endpoint: "https://provider.example.com/hail" } } },
      { ...unsigned, unexpected: true },
    ];
    for (const operation of invalid) await expect(signer.signManagedGenesis(operation)).rejects.toThrow();
    for (const endpoint of ["http://provider.example.com/hail", "https://user:password@provider.example.com/hail",
      "https://127.0.0.1/hail", "https://provider.example.com./hail", "https://provider.example.com/hail?query",
      "https://provider.example.com/hail#fragment", "https://provider.example.com/hail/", "https://provider.example.com/a//b",
      "https://provider.example.com/a/%2fb", "https://provider.example.com/a/../b", "https://PROVIDER.example.com/hail"]) {
      await expect(signer.signManagedGenesis({ ...unsigned, services: { hail: { type: "HailMessaging", endpoint } } })).rejects.toThrow();
    }
    await expect(signer.signManagedGenesis({ ...unsigned,
      services: { hail: { type: "HailMessaging", endpoint: `https://provider.example.com/${"a".repeat(7600)}` } } })).rejects.toThrow("directory limit");
    // Old permissive signers could create valid owner signatures over wrong-role
    // state. Binding/recovery import must reject that evidence independently.
    const ownerControlled = await signer.signPlcOperation({ ...unsigned,
      verificationMethods: { "hail-identity": vault.identity.publicDidKey, "hail-messaging": messaging } });
    expect(await assureValidSig([vault.recovery.publicDidKey], ownerControlled.operation)).toBe(vault.recovery.publicDidKey);
    await expect(signer.bindDid(ownerControlled.did, ownerControlled.operation, true)).rejects.toThrow();
    const providerSigned = await signOperation(unsigned, rotation);
    await expect(signer.bindDid(await didForCreateOp(providerSigned), providerSigned, true)).rejects.toThrow();
    expect(vault.did).toBeNull();
    await signer.bindDid(signed.did, signed.operation, true);
    expect(vault.did).toBe(signed.did);
    await expect(signer.signManagedGenesis(unsigned)).rejects.toThrow("Bound vault");
  } finally { generated.recoverySecret.fill(0); }
});

it("MC-04: retains managed signup bytes after response loss and rejects changed bound-vault retries before transport", async () => {
  const generated = await createUserVault(), directory = await mkdtemp(join(tmpdir(), "hail-managed-signup-"));
  const vault = join(directory, "vault.json"), statePath = join(directory, "state.json"), credential = join(directory, "credential.json");
  const provider = "https://provider.example.com", address = "owner@provider.example.com", accountId = randomUUID();
  const credentialId = randomUUID(), expiresAt = new Date(Date.now() + 60_000).toISOString();
  const rotation = await P256Keypair.create(), identity = await edKey(), messaging = await edKey();
  const requests: { url: string; body: Record<string, any> }[] = [];
  let lost = true;
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
  const transport = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string); requests.push({ url, body });
    if (url.endsWith("/onboarding")) return json({ accountId, address, custodyProfile: "managed",
      managedProfileVersion: "hail-managed-custody-v1",
      userRecoveryKey: generated.vault.recovery.publicDidKey, userIdentityKey: identity,
      providerRotationKey: rotation.did(), providerMessagingKey: messaging, sourceServiceBase: `${provider}/hail` });
    if (lost) { lost = false; return new Response(null, { status: 503 }); }
    const token = new Headers(init.headers).get("Authorization")!.slice("Bearer ".length);
    return json({ did: await didForCreateOp(body.operation), credential: {
      type: "hailp.api-credential", version: 1, provider, accountId, token,
      credentialId, scopes: ["account:read"], expiresAt } });
  });
  vi.stubGlobal("fetch", transport);
  try {
    await writeFile(vault, JSON.stringify(generated.vault), { mode: 0o600 });
    const signup = () => createAccount(provider, address, "managed", vault, statePath, credential,
      async () => encodeBase64Url(generated.recoverySecret));
    await expect(signup()).rejects.toMatchObject({ status: 503 });
    const retained = await readFile(statePath, "utf8"), original = JSON.parse(retained), boundVault = await readFile(vault, "utf8");
    expect(JSON.parse(boundVault).did).toBe(original.did);
    for (const change of [
      (state: any) => { state.operation.verificationMethods["hail-messaging"] = identity; },
      (state: any) => { state.operation.sig = "invalid"; },
      (state: any) => { state.did = `did:plc:${"a".repeat(24)}`; },
      (state: any) => { state.preparation.userIdentityKey = generated.vault.identity.publicDidKey; },
    ]) {
      const changed = structuredClone(original); change(changed);
      await writeFile(statePath, JSON.stringify(changed));
      const count = transport.mock.calls.length;
      await expect(signup()).rejects.toThrow(); expect(transport).toHaveBeenCalledTimes(count);
      expect(await readFile(vault, "utf8")).toBe(boundVault);
    }
    await writeFile(statePath, retained);
    const completed = await signup(); expect(completed.did).toBe(original.did);
    expect(requests[1]!.body).toEqual(requests[2]!.body);
    expect(requests[1]!.body.binding).toBeNull();
    expect(await readFile(vault, "utf8")).toBe(boundVault);
    expect(await signup()).toEqual(completed);
    expect(requests[3]!.body).toEqual(requests[1]!.body);
  } finally { vi.unstubAllGlobals(); generated.recoverySecret.fill(0); await rm(directory, { recursive: true, force: true }); }
});
