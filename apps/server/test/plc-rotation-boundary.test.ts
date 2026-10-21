import { cidForCbor } from "@atproto/common";
import { P256Keypair } from "@atproto/crypto";
import { formatDidDoc, signOperation, validateOperationLog, type DocumentData } from "@did-plc/lib";
import { base58btc } from "multiformats/bases/base58";
import { createWebCryptoSigner, signPayload, type HailEnvelope } from "@hailproto/codec";
import { describe, expect, it, vi } from "vitest";
import { bodyDigest, bodyFromText } from "../src/bodies/service.js";
import { BodyRetriever } from "../src/delivery/retriever.js";
import { EnvelopeReceiver } from "../src/envelopes/receiver.js";
import type { EnvelopeRepository } from "../src/envelopes/repository.js";
import { uuidV7 } from "../src/identity/uuid-v7.js";
import { prepareGenesis } from "../src/plc/genesis.js";
import { PlcHailDidResolver, type HailDidResolver } from "../src/plc/resolver.js";
import type { PlcDirectoryClient } from "../src/plc/client.js";

async function messagingKey() {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const prefixed = new Uint8Array(34);
  prefixed.set([0xed, 0x01]);
  prefixed.set(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)), 2);
  return { privateKey: pair.privateKey, didKey: `did:key:${base58btc.encode(prefixed)}` };
}

describe("validated PLC rotation and service migration fixture", () => {
  it("rejects removed messaging keys and uses only the validated current endpoint", async () => {
    const rotation = await P256Keypair.create({ exportable: true });
    const [identity, oldKey, newKey] = await Promise.all([messagingKey(), messagingKey(), messagingKey()]);
    const oldBase = "https://old-provider.example/hail";
    const newBase = "https://new-provider.example/hail";
    const genesis = await prepareGenesis({ rotationKey: rotation, identityDidKey: identity.didKey,
      messagingDidKey: oldKey.didKey, hailServiceBase: oldBase });
    const successor = await signOperation({
      type: "plc_operation", rotationKeys: [rotation.did()],
      verificationMethods: { "hail-identity": identity.didKey, "hail-messaging": newKey.didKey },
      alsoKnownAs: [], services: { hail: { type: "HailMessaging", endpoint: newBase } },
      prev: (await cidForCbor(genesis.operation)).toString(),
    }, rotation);
    const first = genesis.expectedState;
    const second = await validateOperationLog(genesis.did, [genesis.operation, successor]);
    expect(second?.verificationMethods["hail-messaging"]).toBe(newKey.didKey);
    let current: DocumentData = first;
    const plc: PlcDirectoryClient = {
      getDocument: async () => {
        const { "@context": _context, ...document } = formatDidDoc(current);
        return { ...document,
          verificationMethod: document.verificationMethod.map(entry => ({ ...entry,
            id: entry.id.startsWith("#") ? `${current.did}${entry.id}` : entry.id })),
          service: document.service.map(entry => ({ ...entry,
            id: entry.id.startsWith("#") ? `${current.did}${entry.id}` : entry.id })) };
      },
      getDocumentData: async () => current,
      getOperationLog: async () => current === first ? [genesis.operation] : [genesis.operation, successor],
      health: async () => ({}), getAuditableLog: async () => [], sendOperation: async () => {},
    };
    const validated = new PlcHailDidResolver(plc);
    const replicaResolved = await validated.resolve(genesis.did);
    expect(replicaResolved.serviceBase).toBe(oldBase);
    expect(replicaResolved.evidence.document).not.toHaveProperty("@context");

    const bob = `did:plc:${"b".repeat(24)}`;
    const resolver: HailDidResolver = { resolve: (did) => did === genesis.did
      ? validated.resolve(did)
      : Promise.resolve({ did: bob, identityDidKey: identity.didKey,
        messagingDidKey: identity.didKey, serviceBase: "https://bob.example/hail",
        evidence: { document: {}, data: {}, log: [] } }) };
    const candidate = vi.fn(async () => true);
    const accept = vi.fn<EnvelopeRepository["accept"]>(async () => "accepted");
    const receiver = new EnvelopeReceiver({ async getAccountByDid() { return {
      id: crypto.randomUUID(), did: bob, tenantId: crypto.randomUUID(), canonicalAddress: "bob@example.com",
      state: "active", activationAttemptId: null, activationVerificationMode: "public",
    }; } }, { candidate, accept }, resolver, "https://bob.example/hail");
    const body = bodyFromText("Current PLC key only");
    const now = Math.floor(Date.now() / 1000);
    const envelope: HailEnvelope = { type: "hail.envelope", version: 1, message_id: uuidV7(),
      from: genesis.did, to: bob, authorization: { type: "grant", grant_id: uuidV7() },
      category: "updates", created_at: now, expires_at: now + 3600,
      body: { digest: { algorithm: "sha-256", value: bodyDigest(body) }, size: body.length,
        media_type: "application/hail-body+cbor", profile: "spt-1", available_until: now + 31 * 86400,
        access: { type: "bearer", token: new Uint8Array(32), expires_at: now + 31 * 86400 } },
      reply: { allowed: false } };
    const oldSigned = await signPayload("hail.envelope", envelope,
      createWebCryptoSigner(`${genesis.did}#hail-messaging`, oldKey.privateKey));
    expect(await receiver.receive(oldSigned)).toBe("accepted");
    expect(accept).toHaveBeenCalledTimes(1);

    current = second!;
    expect((await validated.resolve(genesis.did)).serviceBase).toBe(newBase);
    expect((await validated.resolve(genesis.did)).messagingDidKey).toBe(newKey.didKey);
    expect(await receiver.receive(oldSigned)).toBe("ignored");
    expect(accept).toHaveBeenCalledTimes(1);
    const newSigned = await signPayload("hail.envelope", { ...envelope, message_id: uuidV7() },
      createWebCryptoSigner(`${genesis.did}#hail-messaging`, newKey.privateKey));
    expect(await receiver.receive(newSigned)).toBe("accepted");
    expect(accept).toHaveBeenCalledTimes(2);

    current = first;
    const fetched: string[] = [];
    const fetchBody = async (request: Request) => {
      fetched.push(request.url);
      if (fetched.length === 1) {
        current = second!; // PLC migration becomes visible after the old endpoint returns 404.
        return new Response(null, { status: 404 });
      }
      return new Response(Uint8Array.from(body), { headers: { "Content-Type": "application/hail-body+cbor" } });
    };
    const result = await new BodyRetriever(validated, fetchBody, async () => {}).retrieve(envelope);
    expect(result).toEqual({ kind: "success", bytes: body });
    expect(fetched).toEqual([
      `${oldBase}/bodies/${Buffer.from(envelope.body.digest.value).toString("base64url")}`,
      `${newBase}/bodies/${Buffer.from(envelope.body.digest.value).toString("base64url")}`,
    ]);
  });
});
