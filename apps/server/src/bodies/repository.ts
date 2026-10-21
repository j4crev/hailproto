import type { SQL } from "bun";
import { createHash, timingSafeEqual } from "node:crypto";
import { bodyDigest, checkAuthorization, validateBodyBytes, type BodyAuthorizationInput, type BodyStore, type StoredBody } from "./service.js";

interface BodyRow { digest: Uint8Array; body_bytes: Uint8Array | null; sender_account_id: string; }
interface AuthorizationRow { body_digest: Uint8Array; sender_account_id: string; expires_at: string | number | bigint; status: string; }

export class BodyRepository implements BodyStore {
  constructor(private readonly sql: SQL) {}

  async publish(senderDid: string, bytes: Uint8Array): Promise<StoredBody> {
    validateBodyBytes(bytes);
    const digest = bodyDigest(bytes);
    const account = await this.sql<{ id: string }[]>`
      SELECT id FROM provider_accounts WHERE did = ${senderDid} AND onboarding_state = 'active'
        AND activation_verification_mode = 'public'
    `;
    if (!account[0]) throw new Error("Sender account is not active on this provider");
    await this.sql`
      INSERT INTO detached_bodies (digest, sender_account_id, body_bytes)
      VALUES (${digest}, ${account[0].id}, ${bytes})
      ON CONFLICT (digest, sender_account_id) DO NOTHING
    `;
    const rows = await this.sql<BodyRow[]>`
      SELECT digest, body_bytes, sender_account_id FROM detached_bodies
      WHERE digest = ${digest} AND sender_account_id = ${account[0].id}
    `;
    const stored = rows[0];
    if (!stored || stored.sender_account_id !== account[0].id || !stored.body_bytes ||
      stored.body_bytes.length !== bytes.length || !timingSafeEqual(Buffer.from(stored.body_bytes), Buffer.from(bytes))) {
      throw new Error("Body digest collision or inconsistent stored representation");
    }
    return { bytes: new Uint8Array(stored.body_bytes!), digest };
  }

  async authorize(input: BodyAuthorizationInput): Promise<void> {
    checkAuthorization(input);
    const tokenHash = createHash("sha256").update(input.token).digest();
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ sender_account_id: string; available_until: string | number | bigint | null }[]>`
        SELECT body.sender_account_id, body.available_until
        FROM detached_bodies body JOIN provider_accounts account ON account.id = body.sender_account_id
        WHERE body.digest = ${input.digest} AND account.did = ${input.senderDid} AND account.onboarding_state = 'active'
          AND account.activation_verification_mode = 'public'
        FOR UPDATE OF body
      `;
      const body = rows[0];
      if (!body) throw new Error("Body is not published by the active sender");
      await tx`
        INSERT INTO body_authorizations
          (token_hash, body_digest, sender_account_id, recipient_did, message_id, expires_at, available_until)
        VALUES (${tokenHash}, ${input.digest}, ${body.sender_account_id}, ${input.recipientDid},
          ${input.messageId}, ${input.expiresAt}, ${input.availableUntil})
      `;
      if (body.available_until === null || Number(body.available_until) < input.availableUntil) {
        await tx`UPDATE detached_bodies SET available_until = ${input.availableUntil} WHERE digest = ${input.digest} AND sender_account_id = ${body.sender_account_id}`;
      }
    });
  }

  async retrieve(digest: Uint8Array, tokenHash: Uint8Array, now: number): Promise<StoredBody | "missing-body" | null> {
    const auth = await this.sql<AuthorizationRow[]>`
      SELECT body_digest, sender_account_id, expires_at, status
      FROM body_authorizations WHERE token_hash = ${tokenHash}
    `;
    const row = auth[0];
    if (!row || row.status !== "active" || Number(row.expires_at) < now ||
      !timingSafeEqual(Buffer.from(row.body_digest), Buffer.from(digest))) return null;
    const fences = await this.sql<{ state: string }[]>`
      SELECT state FROM provider_migration_fences WHERE account_id = ${row.sender_account_id}
    `;
    if (fences[0]) return fences[0].state === "retired" ? null : "missing-body";
    const bodies = await this.sql<BodyRow[]>`
      SELECT digest, body_bytes, sender_account_id FROM detached_bodies WHERE digest = ${digest} AND sender_account_id = ${row.sender_account_id}
    `;
    const body = bodies[0];
    if (!body?.body_bytes) return "missing-body";
    if (!Buffer.from(bodyDigest(body.body_bytes)).equals(Buffer.from(digest))) throw new Error("Persisted body integrity failure");
    return { bytes: new Uint8Array(body.body_bytes), digest: new Uint8Array(digest) };
  }
}
