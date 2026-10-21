import { createHash, randomBytes, randomUUID } from "node:crypto";
import { base58btc } from "multiformats/bases/base58";
import { createWebCryptoSigner, encodeBase64Url, inspectSignedPayload, signPayload, type HailEnvelope } from "@hailproto/codec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProviderDatabase } from "../src/db/database.js";
import { EnvelopeRepository } from "../src/envelopes/repository.js";
import { EnvelopeReceiver } from "../src/envelopes/receiver.js";
import { uuidV7 } from "../src/identity/uuid-v7.js";
import { BodyRepository } from "../src/bodies/repository.js";
import { bodyFromText } from "../src/bodies/service.js";
import { bodyDigest } from "../src/bodies/service.js";
import { DeliveryRepository } from "../src/delivery/repository.js";
import { DeliveryWorker } from "../src/delivery/worker.js";
import { DeliveryStatusSigner } from "../src/delivery/status.js";
import { DeliveryStatusReceiver } from "../src/delivery/status-receiver.js";
import { TerminalStatusPublisher } from "../src/delivery/status-publisher.js";
import { KeyEncryptor } from "../src/identity/key-encryption.js";
import { Hono } from "hono";
import { registerDeliveryStatusRoutes } from "../src/delivery/status-routes.js";
import type { HailDidResolver, ResolvedHailDid } from "../src/plc/resolver.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;
const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
const did = () => `did:plc:${Array.from(randomBytes(24), (n) => alphabet[n % 32]).join("")}`;

integration("envelope acceptance with PostgreSQL", () => {
  const bob = did();
  const alice = did();
  const accountId = randomUUID();
  const aliceAccountId = randomUUID();
  const grantId = uuidV7();
  const now = Math.floor(Date.now() / 1000);
  let db: ProviderDatabase;
  let store: EnvelopeRepository;
  let receiver: EnvelopeReceiver;
  let privateKey: CryptoKey;
  let statusMessageId: string;
  let keyDid: string;
  let resolver: HailDidResolver;
  let encryptor: KeyEncryptor;

  beforeAll(async () => {
    const { ProviderDatabase } = await import("../src/db/database.js");
    db = new ProviderDatabase(process.env.DATABASE_URL!);
    await db.migrate();
    store = new EnvelopeRepository(db.sql);
    const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
    privateKey = pair.privateKey;
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const keyBytes = new Uint8Array(34);
    keyBytes.set([0xed, 0x01]); keyBytes.set(raw, 2);
    keyDid = `did:key:${base58btc.encode(keyBytes)}`;
    encryptor = new KeyEncryptor(encodeBase64Url(randomBytes(32)));
    const sender: ResolvedHailDid = {
      did: alice, messagingDidKey: keyDid,
      identityDidKey: keyDid,
      serviceBase: "https://alice.example/hail", evidence: { document: {}, data: {}, log: [] },
    };
    const recipient = { ...sender, did: bob, serviceBase: "https://bob.example/hail" };
    resolver = { async resolve(value) {
      if (value === alice) return sender;
      if (value === bob) return recipient;
      throw new Error("Unknown DID");
    } };
    receiver = new EnvelopeReceiver({ async getAccountByDid(value) {
      const id = value === bob ? accountId : value === alice ? aliceAccountId : null;
      return id ? { id, did: value, state: "active", activationVerificationMode: "public",
        tenantId: randomUUID(), canonicalAddress: "account@example.com", activationAttemptId: null } : null;
    } }, store, resolver, recipient.serviceBase, () => now);
    await db.sql`
      INSERT INTO provider_accounts (id, tenant_id, canonical_address, did, onboarding_state,
        activated_at, activation_binding_digest, activation_verification_mode)
      VALUES (${accountId}, ${randomUUID()}, ${`bob-${accountId}@example.com`}, ${bob}, 'active', now(),
        ${new Uint8Array(32).fill(2)}, 'public')
    `;
    await db.sql`
      INSERT INTO provider_accounts (id, tenant_id, canonical_address, did, onboarding_state,
        activated_at, activation_binding_digest, activation_verification_mode)
      VALUES (${aliceAccountId}, ${randomUUID()}, ${`alice-${aliceAccountId}@example.com`}, ${alice}, 'active', now(),
        ${new Uint8Array(32).fill(4)}, 'public')
    `;
    const revisionDigest = randomBytes(32);
    await db.sql`
      INSERT INTO grant_lineages (grant_id, local_account_id, local_role, grantor_did,
        grantee_did, current_revision, current_digest, current_status)
      VALUES (${grantId}, ${accountId}, 'grantor', ${bob}, ${alice}, 1, ${revisionDigest}, 'active')
    `;
    await db.sql`
      INSERT INTO grant_revisions (grant_id, revision, status, issued_at, updated_at, expires_at,
        previous_digest, scope_payload, consent_address_binding_sha256,
        consent_sender_profile_sha256, cose, representation_digest, signing_public_key,
        signing_plc_document, signing_plc_data, signing_plc_operation_log)
      VALUES (${grantId}, 1, 'active', ${now}, ${now}, ${now + 86400}, NULL,
        ${JSON.stringify([{ type: "categories", values: ["updates"] }])}::jsonb,
        ${randomBytes(32)}, ${randomBytes(32)}, ${new Uint8Array([1])}, ${revisionDigest},
        'fixture', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb)
    `;
  });

  afterAll(async () => {
    if (!db) return;
    await db.sql`DELETE FROM sent_delivery_status WHERE sender_did = ${alice}`;
    await db.sql`DELETE FROM delivery_status_wrappers WHERE sender_did = ${alice}`;
    await db.sql`DELETE FROM delivery_status_payloads WHERE sender_did = ${alice}`;
    await db.sql`DELETE FROM terminal_status_publications WHERE sender_did = ${alice}`;
    await db.sql`DELETE FROM delivered_messages WHERE sender_did = ${alice}`;
    await db.sql`DELETE FROM verified_body_provenance WHERE sender_did = ${alice}`;
    await db.sql`DELETE FROM delivery_work WHERE sender_did = ${alice}`;
    await db.sql`DELETE FROM received_envelopes WHERE grant_id = ${grantId}`;
    await db.sql`DELETE FROM sent_envelopes WHERE sender_account_id = ${accountId}`;
    await db.sql`DELETE FROM sent_envelopes WHERE sender_account_id = ${aliceAccountId}`;
    await db.sql`DELETE FROM body_authorizations WHERE sender_account_id = ${accountId}`;
    await db.sql`DELETE FROM body_authorizations WHERE sender_account_id = ${aliceAccountId}`;
    await db.sql`DELETE FROM detached_bodies WHERE sender_account_id = ${accountId}`;
    await db.sql`DELETE FROM detached_bodies WHERE sender_account_id = ${aliceAccountId}`;
    await db.sql`DELETE FROM grant_revisions WHERE grant_id = ${grantId}`;
    await db.sql`DELETE FROM grant_lineages WHERE grant_id = ${grantId}`;
    await db.sql`DELETE FROM provider_accounts WHERE id = ${accountId}`;
    await db.sql`DELETE FROM provider_accounts WHERE id = ${aliceAccountId}`;
    await db.close();
  });

  const payload = (category = "updates", messageId = uuidV7()): HailEnvelope => ({
    type: "hail.envelope", version: 1, message_id: messageId, from: alice, to: bob,
    authorization: { type: "grant", grant_id: grantId }, category,
    created_at: now, expires_at: now + 86400,
    body: { digest: { algorithm: "sha-256", value: randomBytes(32) }, size: 44,
      media_type: "application/hail-body+cbor", profile: "spt-1", available_until: now + 31 * 86400,
      access: { type: "bearer", token: randomBytes(32), expires_at: now + 31 * 86400 } },
    reply: { allowed: false },
  });
  const signed = (value: HailEnvelope) => signPayload("hail.envelope", value,
    createWebCryptoSigner(`${alice}#hail-messaging`, privateKey));

  it("accepts once, treats exact retries as duplicates, and fences message-ID conflicts", async () => {
    const original = payload();
    const bytes = await signed(original);
    expect(await receiver.receive(bytes)).toBe("accepted");
    expect(await receiver.receive(bytes)).toBe("duplicate");
    expect(await receiver.receive(await signed({ ...original, body: { ...original.body, size: 43 } }))).toBe("conflict");
    const rows = await db.sql<{ outcome: string; envelope_digest: Uint8Array }[]>`
      SELECT outcome, envelope_digest FROM received_envelopes WHERE sender_did = ${alice} AND message_id = ${original.message_id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("accepted");
    expect(Buffer.from(rows[0]!.envelope_digest)).toEqual(createHash("sha256").update(inspectSignedPayload("hail.envelope", bytes).payloadBytes).digest());
    const work = await db.sql<{ state: string }[]>`
      SELECT state FROM delivery_work WHERE sender_did = ${alice} AND message_id = ${original.message_id}
    `;
    expect(work[0]?.state).toBe("accepted");
  });

  it("rejects invalid signatures without reservation and persists an authenticated category rejection", async () => {
    const wrong = payload();
    const bytes = await signed(wrong);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    expect(await receiver.receive(bytes)).toBe("ignored");
    const outOfScope = payload("promotion");
    expect(await receiver.receive(await signed(outOfScope))).toBe("unauthorized");
    const rows = await db.sql<{ outcome: string }[]>`
      SELECT outcome FROM received_envelopes WHERE sender_did = ${alice} AND message_id = ${outOfScope.message_id}
    `;
    expect(rows[0]?.outcome).toBe("unauthorized");
  });

  it("commits a signed sent envelope and hashed body authorization together", async () => {
    const body = await new BodyRepository(db.sql).publish(bob, bodyFromText("Sent body"));
    const value = { ...payload(), from: bob, to: alice,
      body: { ...payload().body, digest: { algorithm: "sha-256" as const, value: body.digest }, size: body.bytes.length } };
    const bytes = await signPayload("hail.envelope", value,
      createWebCryptoSigner(`${bob}#hail-messaging`, privateKey));
    await store.createSent(value, bytes, accountId);
    expect(await store.sent(bob, value.message_id)).toEqual(new Uint8Array(bytes));
    const auth = await db.sql<{ token_hash: Uint8Array; available_until: string | number | bigint }[]>`
      SELECT token_hash, available_until FROM body_authorizations WHERE sender_account_id = ${accountId}
    `;
    expect(auth).toHaveLength(1);
    expect(Buffer.from(auth[0]!.token_hash)).toEqual(createHash("sha256").update(value.body.access.token).digest());
    await expect(store.createSent(value, bytes, accountId)).rejects.toThrow();
    const existing = await db.sql`SELECT message_id FROM sent_envelopes WHERE sender_account_id = ${accountId}`;
    expect(existing).toHaveLength(1);
  });

  it("claims accepted work after restart and atomically publishes a verified delivered message", async () => {
    const body = bodyFromText("Delivered after restart");
    const value = payload();
    value.body.digest.value = bodyDigest(body);
    value.body.size = body.length;
    expect(await receiver.receive(await signed(value))).toBe("accepted");
    await db.sql`
      UPDATE delivery_work SET next_attempt_at = now() + interval '1 day'
      WHERE sender_did = ${alice} AND message_id <> ${value.message_id}
    `;
    const restarted = new DeliveryRepository(db.sql);
    const claim = await restarted.claimDue();
    expect(claim?.messageId).toBe(value.message_id);
    expect(await new DeliveryRepository(db.sql).claimDue()).toBeNull();
    expect(await restarted.deliver(claim!, body)).toBe("delivered");
    expect(await restarted.deliver(claim!, body)).toBe("lost-lease");
    const messages = await db.sql<{ message_id: string }[]>`
      SELECT message_id FROM delivered_messages WHERE sender_did = ${alice} AND message_id = ${value.message_id}
    `;
    expect(messages).toHaveLength(1);
    const status = await db.sql<{ state: string; status_revision: number }[]>`
      SELECT state, status_revision FROM delivery_work WHERE sender_did = ${alice} AND message_id = ${value.message_id}
    `;
    expect(status[0]?.state).toBe("delivered");
    expect(status[0]?.status_revision).toBe(2);
  });

  it("recovers an expired lease and resumes an on-hold delivery without duplicating messages", async () => {
    const body = bodyFromText("Retry after crash");
    const value = payload();
    value.body.digest.value = bodyDigest(body);
    value.body.size = body.length;
    expect(await receiver.receive(await signed(value))).toBe("accepted");
    await db.sql`UPDATE delivery_work SET next_attempt_at = now() + interval '1 day'
      WHERE sender_did = ${alice} AND message_id <> ${value.message_id} AND state IN ('accepted', 'on-hold')`;
    const store = new DeliveryRepository(db.sql);
    const crashed = await store.claimDue();
    expect(crashed?.messageId).toBe(value.message_id);
    await db.sql`UPDATE delivery_work SET lease_expires_at = now() - interval '1 second'
      WHERE sender_did = ${alice} AND message_id = ${value.message_id}`;
    const retry = new DeliveryWorker(new DeliveryRepository(db.sql), {
      async retrieve() { return { kind: "retry" as const, reason: "body-temporarily-unavailable" as const, retryAfter: null }; },
    }, () => new Date(), () => 0);
    expect(await retry.processOne()).toBe("on-hold");
    const hold = await db.sql<{ state: string; status_revision: number; attempt_count: number }[]>`
      SELECT state, status_revision, attempt_count FROM delivery_work
      WHERE sender_did = ${alice} AND message_id = ${value.message_id}`;
    expect(hold[0]?.state).toBe("on-hold");
    expect(hold[0]?.status_revision).toBe(2);
    expect(hold[0]?.attempt_count).toBe(2);
    await db.sql`UPDATE delivery_work SET next_attempt_at = now() - interval '1 second'
      WHERE sender_did = ${alice} AND message_id = ${value.message_id}`;
    const resumed = new DeliveryWorker(new DeliveryRepository(db.sql), {
      async retrieve() { return { kind: "success" as const, bytes: body }; },
    });
    expect(await resumed.processOne()).toBe("delivered");
    const rows = await db.sql<{ state: string }[]>`
      SELECT state FROM delivery_work WHERE sender_did = ${alice} AND message_id = ${value.message_id}`;
    expect(rows[0]?.state).toBe("delivered");
    const messages = await db.sql`SELECT message_id FROM delivered_messages
      WHERE sender_did = ${alice} AND message_id = ${value.message_id}`;
    expect(messages).toHaveLength(1);
  });

  it("makes a permanent integrity failure terminal without publishing a message", async () => {
    const value = payload();
    expect(await receiver.receive(await signed(value))).toBe("accepted");
    await db.sql`UPDATE delivery_work SET next_attempt_at = now() + interval '1 day'
      WHERE sender_did = ${alice} AND message_id <> ${value.message_id} AND state IN ('accepted', 'on-hold')`;
    const worker = new DeliveryWorker(new DeliveryRepository(db.sql), {
      async retrieve() { return { kind: "fail" as const, reason: "body-integrity-failed" as const }; },
    });
    expect(await worker.processOne()).toBe("failed");
    expect(await worker.processOne()).toBe("idle");
    const status = await db.sql<{ state: string; reason: string }[]>`
      SELECT state, reason FROM delivery_work WHERE sender_did = ${alice} AND message_id = ${value.message_id}`;
    expect(status[0]?.state).toBe("failed");
    expect(status[0]?.reason).toBe("body-integrity-failed");
    const delivered = await db.sql`SELECT message_id FROM delivered_messages
      WHERE sender_did = ${alice} AND message_id = ${value.message_id}`;
    expect(delivered).toHaveLength(0);
  });

  it("fails accepted work after its signed deadline even if verified bytes arrive", async () => {
    const bytes = bodyFromText("Too late for delivery");
    const value = payload();
    value.created_at = now - 2_000;
    value.expires_at = now - 1_000;
    value.body.digest.value = bodyDigest(bytes);
    value.body.size = bytes.length;
    const representation = await signed(value);
    await db.sql`
      INSERT INTO received_envelopes (sender_did, message_id, recipient_did, grant_id,
        local_account_id, envelope_cose, envelope_digest, payload_digest, signing_public_key,
        signing_plc_document, signing_plc_data, signing_plc_operation_log, outcome, accepted_at)
      VALUES (${alice}, ${value.message_id}, ${bob}, ${grantId}, ${accountId}, ${representation},
        ${createHash("sha256").update(inspectSignedPayload("hail.envelope", representation).payloadBytes).digest()}, ${randomBytes(32)}, 'fixture',
        '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 'accepted', now() - interval '1 day')
    `;
    await db.sql`INSERT INTO delivery_work (sender_did, message_id) VALUES (${alice}, ${value.message_id})`;
    await db.sql`UPDATE delivery_work SET next_attempt_at = now() + interval '1 day'
      WHERE sender_did = ${alice} AND message_id <> ${value.message_id} AND state IN ('accepted', 'on-hold')`;
    const store = new DeliveryRepository(db.sql);
    const claim = await store.claimDue();
    expect(claim?.messageId).toBe(value.message_id);
    expect(await store.deliver(claim!, bytes)).toBe("expired");
    const status = await db.sql<{ state: string; reason: string }[]>`
      SELECT state, reason FROM delivery_work WHERE sender_did = ${alice} AND message_id = ${value.message_id}`;
    expect(status[0]?.state).toBe("failed");
    expect(status[0]?.reason).toBe("delivery-expired");
    const visible = await db.sql`SELECT message_id FROM delivered_messages
      WHERE sender_did = ${alice} AND message_id = ${value.message_id}`;
    expect(visible).toHaveLength(0);
  });

  it("signs acceptance and converges a terminal push at Alice with idempotent acknowledgement", async () => {
    const body = await new BodyRepository(db.sql).publish(alice, bodyFromText("Signed status round trip"));
    const value = payload();
    statusMessageId = value.message_id;
    value.body.digest.value = body.digest;
    value.body.size = body.bytes.length;
    const envelope = await signed(value);
    await store.createSent(value, envelope, aliceAccountId);
    expect(await receiver.receive(envelope)).toBe("accepted");
    const encrypted = await encryptor.encrypt(accountId, "hail-messaging", "ed25519", keyDid,
      new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey)));
    const signer = new DeliveryStatusSigner(db.sql, {
      async getKey() { return { accountId, role: "hail-messaging" as const,
        algorithm: "ed25519" as const, publicKey: keyDid, ...encrypted }; },
    }, encryptor, resolver, "https://bob.example/hail");
    const aliceReceiver = new DeliveryStatusReceiver(db.sql, {
      async getAccountByDid(value) { return value === alice ? {
        id: aliceAccountId, did: alice, state: "active" as const,
        activationVerificationMode: "public" as const, tenantId: randomUUID(),
        canonicalAddress: "alice@example.com", activationAttemptId: null,
      } : null; },
    }, resolver, "https://alice.example/hail");
    const path = encodeBase64Url(createHash("sha256").update(inspectSignedPayload("hail.envelope", envelope).payloadBytes).digest());
    const accepted = await signer.signCurrent(alice, value.message_id);
    expect(accepted).not.toBeNull();
    expect(inspectSignedPayload("hail.delivery-status", accepted!).payload).toMatchObject({
      state: "accepted", revision: 1, message_id: value.message_id, from: bob, to: alice,
    });
    expect(await aliceReceiver.receive(path, accepted!)).toBe("acknowledged");
    expect(await aliceReceiver.receive(path, accepted!)).toBe("acknowledged");
    await db.sql`UPDATE delivery_work SET next_attempt_at = now() + interval '1 day'
      WHERE sender_did = ${alice} AND message_id <> ${value.message_id} AND state IN ('accepted', 'on-hold')`;
    const delivery = new DeliveryRepository(db.sql);
    const claim = await delivery.claimDue();
    expect(claim?.messageId).toBe(value.message_id);
    expect(await delivery.deliver(claim!, body.bytes)).toBe("delivered");
    await db.sql`UPDATE terminal_status_publications SET next_attempt_at = now() + interval '1 day'
      WHERE sender_did = ${alice} AND message_id <> ${value.message_id}`;
    const app = new Hono();
    registerDeliveryStatusRoutes(app, aliceReceiver);
    const unacknowledged = new TerminalStatusPublisher(db.sql, signer, resolver,
      async () => new Response('{"outcome":"received"}', { status: 202, headers: { "Content-Type": "application/json" } }),
      async () => {}, () => new Date(), () => 0);
    expect(await unacknowledged.publishOne()).toBe("retry");
    const retry = await db.sql<{ attempt_count: number; state: string; next_attempt_at: Date }[]>`
      SELECT attempt_count, state, next_attempt_at FROM terminal_status_publications
      WHERE sender_did = ${alice} AND message_id = ${value.message_id}`;
    expect(retry[0]?.attempt_count).toBe(1);
    expect(retry[0]?.state).toBe("retry");
    expect(retry[0]!.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 20_000);
    await db.sql`UPDATE terminal_status_publications SET next_attempt_at = now() - interval '1 second'
      WHERE sender_did = ${alice} AND message_id = ${value.message_id}`;
    const publisher = new TerminalStatusPublisher(db.sql, signer, resolver,
      (request) => Promise.resolve(app.request(request)), async () => {});
    expect(await publisher.publishOne()).toBe("acknowledged");
    expect(await publisher.publishOne()).toBe("idle");
    const publication = await db.sql<{ attempt_count: number; state: string }[]>`
      SELECT attempt_count, state FROM terminal_status_publications
      WHERE sender_did = ${alice} AND message_id = ${value.message_id}`;
    expect(publication[0]?.attempt_count).toBe(2);
    expect(publication[0]?.state).toBe("acknowledged");
    const tracking = await db.sql<{ current_revision: number; current_state: string }[]>`
      SELECT current_revision, current_state FROM sent_delivery_status
      WHERE sender_did = ${alice} AND message_id = ${value.message_id}`;
    expect(tracking[0]?.current_revision).toBe(2);
    expect(tracking[0]?.current_state).toBe("delivered");
    expect(await aliceReceiver.receive(path, accepted!)).toBe("acknowledged");
    const malformedSignature = Uint8Array.from(accepted!);
    malformedSignature[malformedSignature.length - 1] = malformedSignature[malformedSignature.length - 1]! ^ 1;
    expect(await aliceReceiver.receive(path, malformedSignature)).toBe("unknown");
    const terminal = await signer.signCurrent(alice, value.message_id);
    expect(await aliceReceiver.receive(path, terminal!)).toBe("acknowledged");
    const terminalPayload = inspectSignedPayload("hail.delivery-status", terminal!).payload;
    const failedPayload = { type: "hail.delivery-status" as const, version: 1 as const,
      message_id: terminalPayload.message_id, envelope_digest: terminalPayload.envelope_digest,
      from: terminalPayload.from, to: terminalPayload.to, occurred_at: terminalPayload.occurred_at,
      state: "failed" as const, reason: "delivery-expired" as const };
    const conflicting = await signPayload("hail.delivery-status", {
      ...failedPayload, revision: 2,
    }, createWebCryptoSigner(`${bob}#hail-messaging`, privateKey));
    expect(await aliceReceiver.receive(path, conflicting)).toBe("conflict");
    const later = await signPayload("hail.delivery-status", {
      ...failedPayload, revision: 3,
    }, createWebCryptoSigner(`${bob}#hail-messaging`, privateKey));
    expect(await aliceReceiver.receive(path, later)).toBe("conflict");
  });

  it("re-signs the same terminal payload after messaging-key rotation without changing its revision", async () => {
    const wrappers = await db.sql<{ cose: Uint8Array; signing_public_key: string }[]>`
      SELECT cose, signing_public_key FROM delivery_status_wrappers
      WHERE sender_did = ${alice} AND message_id = ${statusMessageId} AND revision = 2
    `;
    expect(wrappers).toHaveLength(1);
    expect(wrappers[0]?.signing_public_key).toBe(keyDid);
    const previous = inspectSignedPayload("hail.delivery-status", wrappers[0]!.cose);
    const newPair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
    const newKeyBytes = new Uint8Array(34);
    newKeyBytes.set([0xed, 0x01]);
    newKeyBytes.set(new Uint8Array(await crypto.subtle.exportKey("raw", newPair.publicKey)), 2);
    const nextDidKey = `did:key:${base58btc.encode(newKeyBytes)}`;
    const encrypted = await encryptor.encrypt(accountId, "hail-messaging", "ed25519", nextDidKey,
      new Uint8Array(await crypto.subtle.exportKey("pkcs8", newPair.privateKey)));
    const rotatedResolver: HailDidResolver = { async resolve(did) {
      const resolved = await resolver.resolve(did);
      return did === bob ? { ...resolved, messagingDidKey: nextDidKey } : resolved;
    } };
    const newSigner = new DeliveryStatusSigner(db.sql, {
      async getKey() { return { accountId, role: "hail-messaging" as const,
        algorithm: "ed25519" as const, publicKey: nextDidKey, ...encrypted }; },
    }, encryptor, rotatedResolver, "https://bob.example/hail");
    const rewrapped = await newSigner.signCurrent(alice, statusMessageId);
    expect(rewrapped).not.toBeNull();
    const inspected = inspectSignedPayload("hail.delivery-status", rewrapped!);
    expect(inspected.payloadBytes).toEqual(previous.payloadBytes);
    expect(inspected.payload.revision).toBe(2);
    expect(Buffer.from(rewrapped!)).not.toEqual(Buffer.from(wrappers[0]!.cose));
    const retained = await db.sql<{ signing_public_key: string }[]>`
      SELECT signing_public_key FROM delivery_status_wrappers
      WHERE sender_did = ${alice} AND message_id = ${statusMessageId} AND revision = 2
    `;
    expect(retained.map((row) => row.signing_public_key).sort()).toEqual([keyDid, nextDidKey].sort());
    const aliceReceiver = new DeliveryStatusReceiver(db.sql, {
      async getAccountByDid(value) { return value === alice ? {
        id: aliceAccountId, did: alice, state: "active" as const,
        activationVerificationMode: "public" as const, tenantId: randomUUID(),
        canonicalAddress: "alice@example.com", activationAttemptId: null,
      } : null; },
    }, rotatedResolver, "https://alice.example/hail");
    const path = encodeBase64Url(inspected.payload.envelope_digest.value);
    expect(await aliceReceiver.receive(path, rewrapped!)).toBe("acknowledged");
    expect(await aliceReceiver.receive(path, wrappers[0]!.cose)).toBe("unknown");
  });

  it("accepts a first-observed terminal snapshot and records the missing accepted revision", async () => {
    const body = await new BodyRepository(db.sql).publish(alice, bodyFromText("First terminal status"));
    const value = payload();
    value.body.digest.value = body.digest;
    value.body.size = body.bytes.length;
    const envelope = await signed(value);
    await store.createSent(value, envelope, aliceAccountId);
    const digest = createHash("sha256").update(inspectSignedPayload("hail.envelope", envelope).payloadBytes).digest();
    const terminal = await signPayload("hail.delivery-status", {
      type: "hail.delivery-status", version: 1, message_id: value.message_id,
      from: bob, to: alice, envelope_digest: { algorithm: "sha-256", value: digest },
      revision: 2, state: "delivered", occurred_at: now,
    }, createWebCryptoSigner(`${bob}#hail-messaging`, privateKey));
    const aliceReceiver = new DeliveryStatusReceiver(db.sql, {
      async getAccountByDid(value) { return value === alice ? {
        id: aliceAccountId, did: alice, state: "active" as const,
        activationVerificationMode: "public" as const, tenantId: randomUUID(),
        canonicalAddress: "alice@example.com", activationAttemptId: null,
      } : null; },
    }, resolver, "https://alice.example/hail");
    expect(await aliceReceiver.receive(encodeBase64Url(digest), terminal)).toBe("acknowledged");
    const rows = await db.sql<{ current_revision: number; revision_gap: number }[]>`
      SELECT current_revision, revision_gap FROM sent_delivery_status
      WHERE sender_did = ${alice} AND message_id = ${value.message_id}`;
    expect(rows[0]?.current_revision).toBe(2);
    expect(rows[0]?.revision_gap).toBe(1);
  });

  it("does not accept an envelope after a committed revocation", async () => {
    await db.sql`UPDATE grant_lineages SET current_status = 'revoked' WHERE grant_id = ${grantId}`;
    const value = payload();
    expect(await receiver.receive(await signed(value))).toBe("unauthorized");
    const accepted = await db.sql`SELECT message_id FROM received_envelopes
      WHERE grant_id = ${grantId} AND message_id = ${value.message_id} AND outcome = 'accepted'`;
    expect(accepted).toHaveLength(0);
  });

  it("serializes acceptance behind an in-flight revocation", async () => {
    await db.sql`UPDATE grant_lineages SET current_status = 'active' WHERE grant_id = ${grantId}`;
    let receiving: Promise<Awaited<ReturnType<EnvelopeReceiver["receive"]>>> | undefined;
    await db.sql.begin(async (tx) => {
      await tx`SELECT grant_id FROM grant_lineages WHERE grant_id = ${grantId} FOR UPDATE`;
      receiving = receiver.receive(await signed(payload()));
      await new Promise((resolve) => setTimeout(resolve, 40));
      await tx`UPDATE grant_lineages SET current_status = 'revoked' WHERE grant_id = ${grantId}`;
    });
    expect(await receiving).toBe("unauthorized");
  });
});
