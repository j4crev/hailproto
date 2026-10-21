import { isIP } from "node:net";
import { encodeDeterministic, type HailValue } from "@hailproto/codec";

export interface AccountAccessChallenge {
  type: "hailp.account-access"; version: 1; purpose: "new-api-credential";
  challengeId: string; provider: string; accountId: string; did: string;
  signer: "identity" | "owner-recovery"; publicKey: string; scopes: string[];
  tokenHash: string; nonce: string; issuedAt: number; expiresAt: number;
}
export function accountAccessInput(challenge: AccountAccessChallenge): Uint8Array {
  const fields = ["type", "version", "purpose", "challengeId", "provider", "accountId", "did", "signer", "publicKey", "scopes", "tokenHash", "nonce", "issuedAt", "expiresAt"];
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
  if (!challenge || typeof challenge !== "object" || Array.isArray(challenge) || Object.keys(challenge).length !== fields.length ||
    Object.keys(challenge).some(key => !fields.includes(key)) || challenge.type !== "hailp.account-access" || challenge.version !== 1 ||
    challenge.purpose !== "new-api-credential" || !uuid.test(challenge.challengeId) || !uuid.test(challenge.accountId) ||
    !/^did:plc:[a-z2-7]{24}$/.test(challenge.did) || !["identity", "owner-recovery"].includes(challenge.signer) ||
    typeof challenge.publicKey !== "string" || challenge.publicKey.length > 256 || !/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(challenge.publicKey) ||
    !/^[A-Za-z0-9_-]{43}$/.test(challenge.tokenHash) || !/^[A-Za-z0-9_-]{43}$/.test(challenge.nonce) ||
    !Array.isArray(challenge.scopes) || !challenge.scopes.length || challenge.scopes.length > 7 || new Set(challenge.scopes).size !== challenge.scopes.length ||
    challenge.scopes.some(scope => !["account:read", "grants:read", "grants:write", "credentials:write", "messages:read", "messages:write", "account:write"].includes(scope)) ||
    !Number.isSafeInteger(challenge.issuedAt) || !Number.isSafeInteger(challenge.expiresAt) ||
    challenge.expiresAt <= challenge.issuedAt || challenge.expiresAt - challenge.issuedAt > 300) throw new Error("Invalid account-access challenge");
  const origin = new URL(challenge.provider);
  if (origin.protocol !== "https:" || origin.origin !== challenge.provider || origin.username || origin.password ||
    origin.search || origin.hash || isIP(origin.hostname) || !/^[a-z0-9.-]+$/.test(origin.hostname)) throw new Error("Invalid challenge provider");
  const tag = new TextEncoder().encode("hailp.account-access.v1\0");
  const bytes = encodeDeterministic(challenge as unknown as HailValue);
  const result = new Uint8Array(tag.length + bytes.length); result.set(tag); result.set(bytes, tag.length); return result;
}
