import { createHash, randomBytes, randomUUID } from "node:crypto";
import { verifySignature } from "@atproto/crypto";
import { decodeBase64Url, encodeBase64Url, encodeDeterministic, type HailValue } from "@hailproto/codec";
import type { SQL } from "bun";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import type { HailDidResolver } from "../plc/resolver.js";
import { ALL_ACCOUNT_SCOPES, tokenHash, type AccountApiScope } from "./repository.js";

interface Challenge {
  type: "hailp.account-access"; version: 1; purpose: "new-api-credential";
  challengeId: string; provider: string; accountId: string; did: string;
  signer: "identity" | "owner-recovery"; publicKey: string; scopes: AccountApiScope[];
  tokenHash: string; nonce: string; issuedAt: number; expiresAt: number;
}
interface ChallengeRow { payload: Challenge | string; completion_hash: Uint8Array | null; credential_id: string | null; }
const digest = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const equal = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const payload = (row: ChallengeRow) => typeof row.payload === "string" ? JSON.parse(row.payload) as Challenge : row.payload;
function signatureInput(challenge: Challenge) {
  const tag = new TextEncoder().encode("hailp.account-access.v1\0");
  const bytes = encodeDeterministic(challenge as unknown as HailValue);
  const input = new Uint8Array(tag.length + bytes.length); input.set(tag); input.set(bytes, tag.length); return input;
}

export class AccountAccess {
  constructor(private readonly sql: SQL, private readonly resolver: HailDidResolver, private readonly provider: string) {}

  async prepare(input: Record<string, unknown>) {
    if (Object.keys(input).length !== 5 || Object.keys(input).some(k => !["did", "signer", "publicKey", "scopes", "tokenHash"].includes(k)) ||
      typeof input.did !== "string" || !/^did:plc:[a-z2-7]{24}$/.test(input.did) ||
      !["identity", "owner-recovery"].includes(input.signer as string) ||
      typeof input.publicKey !== "string" || input.publicKey.length > 256 || !/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(input.publicKey) ||
      typeof input.tokenHash !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.tokenHash) ||
      !Array.isArray(input.scopes) || !input.scopes.length || new Set(input.scopes).size !== input.scopes.length ||
      input.scopes.some(scope => !ALL_ACCOUNT_SCOPES.includes(scope))) throw new Error("Invalid account-access request");
    const token = decodeBase64Url(input.tokenHash);
    if (token.length !== 32 || encodeBase64Url(token) !== input.tokenHash) throw new Error("Invalid token hash");
    const did = input.did, publicKey = input.publicKey, signer = input.signer as Challenge["signer"];
    const scopes = ALL_ACCOUNT_SCOPES.filter(scope => (input.scopes as unknown[]).includes(scope));
    return this.sql.begin(async tx => {
      // ponytail: one preparation lock caps the 4096-row POC store; partition quotas if throughput needs it.
      await tx`SELECT pg_advisory_xact_lock(684245134)`;
      await tx`DELETE FROM account_access_challenges WHERE expires_at < clock_timestamp() - interval '1 day'`;
      const prior = await tx<ChallengeRow[]>`SELECT payload, completion_hash, credential_id FROM account_access_challenges
        WHERE token_hash=${token} AND expires_at > clock_timestamp()`;
      if (prior[0]) {
        const challenge = payload(prior[0]);
        if (challenge.provider !== this.provider || challenge.did !== did || challenge.publicKey !== publicKey || challenge.signer !== signer || !same(challenge.scopes, scopes)) throw new Error("Changed login request");
        return challenge;
      }
      const seen = await tx`SELECT id FROM account_access_challenges WHERE token_hash=${token}`;
      const used = await tx`SELECT id FROM account_api_credentials WHERE token_hash=${token}`;
      const count = await tx<{count:number}[]>`SELECT count(*)::integer AS count FROM account_access_challenges`;
      if (seen.length || used.length || count[0]!.count >= 4096) throw new Error("Login request unavailable");
      const accounts = await tx<{id:string}[]>`SELECT id FROM provider_accounts WHERE did=${did}`;
      const issuedAt = Math.floor(Date.now() / 1000);
      // Unknown accounts receive the same opaque shape, not an existence/custody result.
      const challenge: Challenge = { type: "hailp.account-access", version: 1, purpose: "new-api-credential",
        challengeId: randomUUID(), provider: this.provider, accountId: accounts[0]?.id ?? randomUUID(),
        did, signer, publicKey, scopes, tokenHash: input.tokenHash as string,
        nonce: encodeBase64Url(randomBytes(32)), issuedAt, expiresAt: issuedAt + 300 };
      await tx`INSERT INTO account_access_challenges (id,token_hash,payload,expires_at)
        VALUES (${challenge.challengeId},${token},(${JSON.stringify(challenge)}::text)::jsonb,to_timestamp(${challenge.expiresAt}))`;
      return challenge;
    });
  }

  async complete(id: string, token: string, encodedSignature: string, signal?: AbortSignal) {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id) || !/^hailp_[A-Za-z0-9_-]{43}$/.test(token) ||
      !/^[A-Za-z0-9_-]{86}$/.test(encodedSignature)) throw new Error("Invalid login proof");
    const signature = decodeBase64Url(encodedSignature);
    if (signature.length !== 64 || encodeBase64Url(signature) !== encodedSignature) throw new Error("Invalid login signature");
    const rows = await this.sql<ChallengeRow[]>`SELECT payload, completion_hash, credential_id FROM account_access_challenges
      WHERE id=${id} AND token_hash=${tokenHash(token)} AND expires_at > clock_timestamp()`;
    if (!rows[0]) throw new Error("Login challenge unavailable");
    const challenge = payload(rows[0]), input = signatureInput(challenge);
    if (challenge.provider !== this.provider) throw new Error("Challenge belongs to another provider");
    const valid = challenge.signer === "identity" ? await crypto.subtle.verify("Ed25519",
      await ed25519PublicKeyFromDidKey(challenge.publicKey), Uint8Array.from(signature), Uint8Array.from(input)) :
      await verifySignature(challenge.publicKey, input, signature, { jwtAlg: "ES256" });
    if (!valid) throw new Error("Invalid owner proof");
    const completionHash = digest(signature);
    return this.sql.begin(async tx => {
      const accounts = await tx<{id:string;onboarding_state:string}[]>`SELECT id,onboarding_state FROM provider_accounts
        WHERE id=${challenge.accountId} AND did=${challenge.did} FOR UPDATE`;
      if (!accounts[0] || accounts[0].onboarding_state !== "active") throw new Error("Account unavailable");
      if ((await tx`SELECT did FROM provider_migration_fences WHERE account_id=${challenge.accountId}`).length) throw new Error("Account fenced");
       const stored = await tx<ChallengeRow[]>`SELECT payload,completion_hash,credential_id FROM account_access_challenges c
         JOIN account_challenge_generations binding ON binding.challenge_id=c.id
         JOIN account_serving_generations generation ON generation.account_id=${challenge.accountId} AND generation.generation=binding.generation
         WHERE c.id=${id} AND expires_at > clock_timestamp() FOR UPDATE OF c`;
      if (!stored[0]) throw new Error("Challenge expired");
      const owner = await tx<{recovery:string;identity:string}[]>`SELECT user_recovery_public_key AS recovery,user_identity_public_key AS identity
        FROM portable_custody_evidence WHERE account_id=${challenge.accountId}`;
      const managed = await tx<{recovery:string;identity:string}[]>`SELECT owner_recovery_public_key AS recovery,provider_identity_public_key AS identity
        FROM managed_custody_evidence WHERE account_id=${challenge.accountId}`;
      const keys = await tx<{role:string;public_key:string}[]>`SELECT role,public_key FROM account_keys WHERE account_id=${challenge.accountId}`;
      const evidence = owner[0] ?? managed[0];
      if (!evidence || Boolean(owner[0]) === Boolean(managed[0]) ||
        keys.some(key => key.public_key === evidence.recovery) ||
        (owner[0] ? keys.some(key => key.role === "hail-identity") : !keys.some(key => key.role === "hail-identity" && key.public_key === evidence.identity)) ||
        challenge.signer === "identity" && !owner[0]) throw new Error("Independent owner authority required");
      const current = await this.resolver.resolve(challenge.did);
      const rotations = (current.evidence.data as {rotationKeys?:string[]}).rotationKeys;
      if (signal?.aborted || current.did !== challenge.did || current.serviceBase !== `${this.provider}/hail` ||
        current.identityDidKey !== evidence.identity || rotations?.[0] !== evidence.recovery ||
        !keys.some(key => key.role === "plc-rotation" && rotations.slice(1).includes(key.public_key)) ||
        !keys.some(key => key.role === "hail-messaging" && key.public_key === current.messagingDidKey) ||
        challenge.publicKey !== (challenge.signer === "identity" ? current.identityDidKey : evidence.recovery)) throw new Error("Owner authority no longer matches");
      if (stored[0].completion_hash && !equal(stored[0].completion_hash, completionHash)) throw new Error("Changed completion proof");
      let credentialId = stored[0].credential_id;
      if (!credentialId) {
        if ((await tx`SELECT id FROM account_api_credentials WHERE token_hash=${tokenHash(token)}`).length) throw new Error("Token already used");
        credentialId = randomUUID();
        await tx`INSERT INTO account_api_credentials (id,account_id,token_hash,scopes,expires_at)
          VALUES (${credentialId},${challenge.accountId},${tokenHash(token)},(${JSON.stringify(challenge.scopes)}::text)::jsonb,now()+interval '30 days')`;
        // Recheck the DB deadline after external verification; failure rolls back issuance.
        const consumed = await tx`UPDATE account_access_challenges SET completion_hash=${completionHash},credential_id=${credentialId}
          WHERE id=${id} AND expires_at > clock_timestamp() RETURNING id`;
        if (!consumed.length || signal?.aborted) throw new Error("Challenge expired");
      }
      const credential = await tx<{expires_at:Date}[]>`SELECT expires_at FROM account_api_credentials
        WHERE id=${credentialId} AND account_id=${challenge.accountId} AND token_hash=${tokenHash(token)}
          AND revoked_at IS NULL AND expires_at > clock_timestamp()
          AND EXISTS (SELECT 1 FROM account_access_challenges WHERE id=${id} AND expires_at > clock_timestamp()) FOR UPDATE`;
      if (!credential[0] || signal?.aborted) throw new Error("Credential or challenge is terminal");
      return { type: "hailp.api-credential", version: 1, provider: this.provider, accountId: challenge.accountId,
        credentialId, token, scopes: challenge.scopes, expiresAt: credential[0].expires_at.toISOString() };
    });
  }
}
