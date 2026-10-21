import { randomBytes, randomUUID } from "node:crypto";
import { base58btc } from "multiformats/bases/base58";
import { createWebCryptoSigner, encodeBase64Url, signPayload, type HailEnvelope } from "@hailproto/codec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BodyRepository } from "../src/bodies/repository.js";
import { bodyFromText } from "../src/bodies/service.js";
import type { ProviderDatabase } from "../src/db/database.js";
import { DeliveryRepository } from "../src/delivery/repository.js";
import { EnvelopeReceiver } from "../src/envelopes/receiver.js";
import { EnvelopeRepository } from "../src/envelopes/repository.js";
import { EnvelopeService } from "../src/envelopes/service.js";
import { GrantRepository } from "../src/grants/repository.js";
import { KeyEncryptor } from "../src/identity/key-encryption.js";
import { uuidV7 } from "../src/identity/uuid-v7.js";
import type { HailDidResolver, ResolvedHailDid } from "../src/plc/resolver.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;
const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
const did = () => `did:plc:${Array.from(randomBytes(24), (n) => alphabet[n % 32]).join("")}`;

integration("reply capabilities PostgreSQL integration", () => {
  const alice = did();
  const bob = did();
  const aliceId = randomUUID();
  const bobId = randomUUID();
  const grantId = uuidV7();
  const now = Math.floor(Date.now() / 1000);
  let db: ProviderDatabase;
  let envelopes: EnvelopeRepository;
  let bobReceiver: EnvelopeReceiver;
  let aliceReceiver: EnvelopeReceiver;
  let bobService: EnvelopeService;
  let aliceService: EnvelopeService;
  let privateKey: CryptoKey;
  let bobBody: Uint8Array;
  let bobDigest: string;

  async function original(allowedUntil: number | null): Promise<HailEnvelope> {
    const body = await new BodyRepository(db.sql).publish(alice, bodyFromText("Invitation to reply"));
    const payload: HailEnvelope = {
      type: "hail.envelope", version: 1, from: alice, to: bob, message_id: uuidV7(),
      authorization: { type: "grant", grant_id: grantId }, category: "updates",
      created_at: allowedUntil !== null && allowedUntil < now ? now - 1000 : now,
      expires_at: now + 3600,
      body: { digest: { algorithm: "sha-256", value: body.digest }, size: body.bytes.length,
        media_type: "application/hail-body+cbor", profile: "spt-1", available_until: now + 31 * 86400,
        access: { type: "bearer", token: randomBytes(32), expires_at: now + 31 * 86400 } },
      reply: allowedUntil === null ? { allowed: false } : { allowed: true, until: allowedUntil },
    };
    const representation = await signPayload("hail.envelope", payload,
      createWebCryptoSigner(`${alice}#hail-messaging`, privateKey));
    await envelopes.createSent(payload, representation, aliceId);
    expect(await bobReceiver.receive(representation)).toBe("accepted");
    await db.sql`UPDATE delivery_work SET next_attempt_at = now() + interval '1 day'
      WHERE sender_did = ${alice} AND message_id = ${payload.message_id}`;
    return payload;
  }

  beforeAll(async () => {
    const { ProviderDatabase } = await import("../src/db/database.js");
    db = new ProviderDatabase(process.env.DATABASE_URL!);
    await db.migrate();
    envelopes = new EnvelopeRepository(db.sql);
    const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
    privateKey = pair.privateKey;
    const publicBytes = new Uint8Array(34);
    publicBytes.set([0xed, 0x01]);
    publicBytes.set(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)), 2);
    const didKey = `did:key:${base58btc.encode(publicBytes)}`;
    const encryptor = new KeyEncryptor(encodeBase64Url(randomBytes(32)));
    const privateBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
    const encrypted = await encryptor.encrypt(bobId, "hail-messaging", "ed25519", didKey, privateBytes);
    const aliceEncrypted = await encryptor.encrypt(aliceId, "hail-messaging", "ed25519", didKey, privateBytes);
    const resolved = (value: string): ResolvedHailDid => ({ did: value, messagingDidKey: didKey,
      identityDidKey: didKey, serviceBase: value === alice ? "https://alice.example/hail" : "https://bob.example/hail",
      evidence: { document: {}, data: {}, log: [] } });
    const resolver: HailDidResolver = { async resolve(value) {
      if (value !== alice && value !== bob) throw new Error("Unknown DID");
      return resolved(value);
    } };
    const accounts = { async getAccountByDid(value: string) {
      const id = value === alice ? aliceId : value === bob ? bobId : null;
      return id ? { id, did: value, state: "active" as const, activationVerificationMode: "public" as const,
        tenantId: id, canonicalAddress: `${id}@example.com`, activationAttemptId: null } : null;
    } };
    bobReceiver = new EnvelopeReceiver(accounts, envelopes, resolver, "https://bob.example/hail");
    aliceReceiver = new EnvelopeReceiver(accounts, envelopes, resolver, "https://alice.example/hail");
    bobService = new EnvelopeService({ ...accounts, async getKey() {
      return { accountId: bobId, role: "hail-messaging" as const,
        algorithm: "ed25519" as const, publicKey: didKey, ...encrypted };
    } }, new GrantRepository(db.sql), envelopes, encryptor, resolver, "https://bob.example/hail");
    aliceService = new EnvelopeService({ ...accounts, async getKey() {
      return { accountId: aliceId, role: "hail-messaging" as const,
        algorithm: "ed25519" as const, publicKey: didKey, ...aliceEncrypted };
    } }, new GrantRepository(db.sql), envelopes, encryptor, resolver, "https://alice.example/hail");
    for (const [id, value, nonce] of [[aliceId, alice, 1], [bobId, bob, 2]] as const) {
      await db.sql`
        INSERT INTO provider_accounts (id, tenant_id, canonical_address, did, onboarding_state,
          activated_at, activation_binding_digest, activation_verification_mode)
        VALUES (${id}, ${randomUUID()}, ${`${id}@example.com`}, ${value}, 'active', now(),
          ${new Uint8Array(32).fill(nonce)}, 'public')
      `;
    }
    const revisionDigest = randomBytes(32);
    await db.sql`
      INSERT INTO grant_lineages (grant_id, local_account_id, local_role, grantor_did,
        grantee_did, current_revision, current_digest, current_status)
      VALUES (${grantId}, ${bobId}, 'grantor', ${bob}, ${alice}, 1, ${revisionDigest}, 'active')
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
    const body = await new BodyRepository(db.sql).publish(bob, bodyFromText("Reply without a Grant"));
    bobBody = body.bytes;
    bobDigest = encodeBase64Url(body.digest);
  });

  afterAll(async () => {
    if (!db) return;
    await db.sql`DELETE FROM terminal_status_publications WHERE sender_did IN (${alice}, ${bob})`;
    await db.sql`DELETE FROM delivered_messages WHERE sender_did IN (${alice}, ${bob})`;
    await db.sql`DELETE FROM verified_body_provenance WHERE sender_did IN (${alice}, ${bob})`;
    await db.sql`DELETE FROM delivery_work WHERE sender_did IN (${alice}, ${bob})`;
    await db.sql`DELETE FROM reply_capabilities WHERE original_sender_did IN (${alice}, ${bob})`;
    await db.sql`DELETE FROM sent_envelopes WHERE sender_did = ${alice} AND authorization_type = 'reply'`;
    await db.sql`DELETE FROM received_envelopes WHERE sender_did = ${alice} AND authorization_type = 'reply'`;
    await db.sql`DELETE FROM received_envelopes WHERE sender_did = ${bob}`;
    await db.sql`DELETE FROM sent_envelopes WHERE sender_did = ${bob}`;
    await db.sql`DELETE FROM received_envelopes WHERE sender_did = ${alice}`;
    await db.sql`DELETE FROM sent_envelopes WHERE sender_did = ${alice}`;
    await db.sql`DELETE FROM body_authorizations WHERE sender_account_id IN (${aliceId}, ${bobId})`;
    await db.sql`DELETE FROM detached_bodies WHERE sender_account_id IN (${aliceId}, ${bobId})`;
    await db.sql`DELETE FROM grant_revisions WHERE grant_id = ${grantId}`;
    await db.sql`DELETE FROM grant_lineages WHERE grant_id = ${grantId}`;
    await db.sql`DELETE FROM provider_accounts WHERE id IN (${aliceId}, ${bobId})`;
    await db.close();
  });

  it("claims one of two competing replies, holds the claim, releases on failure, and consumes on delivery", async () => {
    const invitation = await original(now + 86400);
    const [first, second] = await Promise.all([
      bobService.createReply(bob, invitation.message_id, bobDigest),
      bobService.createReply(bob, invitation.message_id, bobDigest),
    ]);
    expect(first.payload.category).toBeUndefined();
    expect(first.payload.authorization).toEqual({ type: "reply", reply_to: invitation.message_id });
    const outcomes = await Promise.all([
      aliceReceiver.receive(first.representation), aliceReceiver.receive(second.representation),
    ]);
    expect(outcomes.slice().sort()).toEqual(["accepted", "unauthorized"]);
    const accepted = outcomes[0] === "accepted" ? first : second;
    const rejected = outcomes[0] === "accepted" ? second : first;
    expect(await aliceReceiver.receive(accepted.representation)).toBe("duplicate");
    expect(await aliceReceiver.receive(rejected.representation)).toBe("duplicate");
    const store = new DeliveryRepository(db.sql);
    const claimed = await store.claimDue();
    expect(claimed?.messageId).toBe(accepted.payload.message_id);
    await store.hold(claimed!, "body-temporarily-unavailable", new Date(Date.now() + 10_000));
    const held = await db.sql<{ state: string; claimed_message_id: string }[]>`
      SELECT state, claimed_message_id FROM reply_capabilities
      WHERE original_sender_did = ${alice} AND original_message_id = ${invitation.message_id}
    `;
    expect(held[0]?.state).toBe("claimed");
    expect(held[0]?.claimed_message_id).toBe(accepted.payload.message_id);
    await db.sql`UPDATE delivery_work SET next_attempt_at = now() - interval '1 second'
      WHERE sender_did = ${bob} AND message_id = ${accepted.payload.message_id}`;
    const reclaimed = await store.claimDue();
    expect(reclaimed?.messageId).toBe(accepted.payload.message_id);
    await store.fail(reclaimed!, "body-integrity-failed");
    const freed = await db.sql<{ state: string; claimed_message_id: string | null }[]>`
      SELECT state, claimed_message_id FROM reply_capabilities
      WHERE original_sender_did = ${alice} AND original_message_id = ${invitation.message_id}
    `;
    expect(freed[0]?.state).toBe("available");
    expect(freed[0]?.claimed_message_id).toBeNull();
    const replacement = await bobService.createReply(bob, invitation.message_id, bobDigest);
    expect(await aliceReceiver.receive(replacement.representation)).toBe("accepted");
    const finalClaim = await store.claimDue();
    expect(finalClaim?.messageId).toBe(replacement.payload.message_id);
    expect(await store.deliver(finalClaim!, bobBody)).toBe("delivered");
    const consumed = await db.sql<{ state: string; claimed_message_id: string }[]>`
      SELECT state, claimed_message_id FROM reply_capabilities
      WHERE original_sender_did = ${alice} AND original_message_id = ${invitation.message_id}
    `;
    expect(consumed[0]?.state).toBe("consumed");
    expect(consumed[0]?.claimed_message_id).toBe(replacement.payload.message_id);
    expect(await aliceReceiver.receive(replacement.representation)).toBe("duplicate");
    const sibling = await bobService.createReply(bob, invitation.message_id, bobDigest);
    expect(await aliceReceiver.receive(sibling.representation)).toBe("unauthorized");
  });

  it("rejects an expired invitation locally and at the recipient", async () => {
    const invitation = await original(now - 700);
    await expect(bobService.createReply(bob, invitation.message_id, bobDigest)).rejects.toThrow("unexpired");
    const payload: HailEnvelope = {
      type: "hail.envelope", version: 1, from: bob, to: alice, message_id: uuidV7(),
      authorization: { type: "reply", reply_to: invitation.message_id },
      created_at: now, expires_at: now + 3600,
      body: { digest: { algorithm: "sha-256", value: randomBytes(32) }, size: bobBody.length,
        media_type: "application/hail-body+cbor", profile: "spt-1", available_until: now + 31 * 86400,
        access: { type: "bearer", token: randomBytes(32), expires_at: now + 31 * 86400 } },
      reply: { allowed: false },
    };
    const bytes = await signPayload("hail.envelope", payload,
      createWebCryptoSigner(`${bob}#hail-messaging`, privateKey));
    expect(await aliceReceiver.receive(bytes)).toBe("unauthorized");
    const unchanged = await db.sql<{ state: string }[]>`
      SELECT state FROM reply_capabilities
      WHERE original_sender_did = ${alice} AND original_message_id = ${invitation.message_id}
    `;
    expect(unchanged[0]?.state).toBe("available");
  });

  it("rejects unsolicited replies before PLC work or replay reservation", async () => {
    const notInvited = await original(null);
    await expect(bobService.createReply(bob, notInvited.message_id, bobDigest)).rejects.toThrow("invitation");
    const fake: HailEnvelope = {
      type: "hail.envelope", version: 1, from: bob, to: alice, message_id: uuidV7(),
      authorization: { type: "reply", reply_to: notInvited.message_id },
      created_at: now, expires_at: now + 3600,
      body: { digest: { algorithm: "sha-256", value: randomBytes(32) }, size: bobBody.length,
        media_type: "application/hail-body+cbor", profile: "spt-1", available_until: now + 31 * 86400,
        access: { type: "bearer", token: randomBytes(32), expires_at: now + 31 * 86400 } },
      reply: { allowed: false },
    };
    const signed = await signPayload("hail.envelope", fake,
      createWebCryptoSigner(`${bob}#hail-messaging`, privateKey));
    expect(await aliceReceiver.receive(signed)).toBe("ignored");
    const reserved = await db.sql`SELECT message_id FROM received_envelopes
      WHERE sender_did = ${bob} AND message_id = ${fake.message_id}`;
    expect(reserved).toHaveLength(0);
  });

  it("releases a cancelled reply and permits a replacement before expiration", async () => {
    const invitation = await original(now + 86400);
    const first = await bobService.createReply(bob, invitation.message_id, bobDigest);
    expect(await aliceReceiver.receive(first.representation)).toBe("accepted");
    const store = new DeliveryRepository(db.sql);
    const claim = await store.claimDue();
    expect(claim?.messageId).toBe(first.payload.message_id);
    await store.cancel(claim!, "recipient-cancelled");
    const released = await db.sql<{ state: string; claimed_message_id: string | null }[]>`
      SELECT state, claimed_message_id FROM reply_capabilities
      WHERE original_sender_did = ${alice} AND original_message_id = ${invitation.message_id}
    `;
    expect(released[0]?.state).toBe("available");
    expect(released[0]?.claimed_message_id).toBeNull();
    const next = await bobService.createReply(bob, invitation.message_id, bobDigest);
    expect(await aliceReceiver.receive(next.representation)).toBe("accepted");
  });

  it("allows one explicitly solicited continuation and ends the chain when replies are disabled", async () => {
    const invitation = await original(now + 86400);
    const bobReply = await bobService.createReply(bob, invitation.message_id, bobDigest, now + 86400);
    expect(bobReply.payload.reply).toEqual({ allowed: true, until: now + 86400 });
    expect(await aliceReceiver.receive(bobReply.representation)).toBe("accepted");
    const aliceBody = await new BodyRepository(db.sql).publish(alice, bodyFromText("Invitation to reply"));
    const continuation = await aliceService.createReply(alice, bobReply.payload.message_id, encodeBase64Url(aliceBody.digest));
    expect(continuation.payload.reply).toEqual({ allowed: false });
    expect(await bobReceiver.receive(continuation.representation)).toBe("accepted");
    const rows = await db.sql<{ state: string; claimed_message_id: string }[]>`
      SELECT state, claimed_message_id FROM reply_capabilities
      WHERE original_sender_did = ${bob} AND original_message_id = ${bobReply.payload.message_id}
    `;
    expect(rows[0]?.state).toBe("claimed");
    expect(rows[0]?.claimed_message_id).toBe(continuation.payload.message_id);
    await expect(bobService.createReply(bob, continuation.payload.message_id, bobDigest)).rejects.toThrow("invitation");
  });

  it("allows a solicited reply after the original envelope's Grant is revoked", async () => {
    const invitation = await original(now + 86400);
    await db.sql`UPDATE grant_lineages SET current_status = 'revoked' WHERE grant_id = ${grantId}`;
    const reply = await bobService.createReply(bob, invitation.message_id, bobDigest);
    expect(await aliceReceiver.receive(reply.representation)).toBe("accepted");
    const rows = await db.sql<{ authorization_type: string; grant_id: string | null }[]>`
      SELECT authorization_type, grant_id FROM received_envelopes
      WHERE sender_did = ${bob} AND message_id = ${reply.payload.message_id}`;
    expect(rows[0]?.authorization_type).toBe("reply");
    expect(rows[0]?.grant_id).toBeNull();
  });
});
