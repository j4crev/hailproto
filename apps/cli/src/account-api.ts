import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { decodeBase64Url, encodeBase64Url, inspectSignedPayload, fromDiagnosticJson, type DiagnosticJson, type HailGrant, type HailSenderProfile } from "@hailproto/codec";
import { privateFile } from "./grant-revocation.js";
import { ClientError } from "./client-error.js";
import { MANAGED_CUSTODY_PROFILE_VERSION } from "./managed-profile.js";

const GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const MAX_RESPONSE = 524_288;
export const ACCOUNT_API_SCOPES = ["account:read", "grants:read", "grants:write", "credentials:write", "messages:read", "messages:write", "account:write"] as const;
export type AccountApiScope = typeof ACCOUNT_API_SCOPES[number];
export function credentialScopes(value: unknown): AccountApiScope[] {
  if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length ||
    value.some(scope => !ACCOUNT_API_SCOPES.includes(scope))) throw new Error("Invalid credential scopes");
  return ACCOUNT_API_SCOPES.filter(scope => value.includes(scope));
}
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ClientError("RESPONSE_ERROR", "Provider API returned an invalid object");
  return value as JsonObject;
}

export class AccountApiError extends Error {
  constructor(readonly status: number, readonly retryAfterSeconds?: number) {
    const advice = status === 401 ? "Select a valid credential or explicitly log in; expired/revoked access is terminal" :
      status === 403 ? "The selected credential lacks authority; do not escalate scopes" :
      status === 404 ? "The resource is unavailable to this account" :
      status === 409 ? "Retain the original artifacts; check account fences and conflicting state" :
      status === 429 || status === 503 ? "Retain artifacts and retry the same request after the indicated delay" : "Check the documented request contract";
    super(`Provider API returned HTTP ${status}. ${advice}`);
  }
}

export class AccountApiClient {
  private constructor(private readonly provider: string, private readonly token: string,
    private readonly accountId: string) {}

  static signup(provider: string, token: string) {
    const url=new URL(provider);
    if(url.protocol!=="https:"||url.origin!==provider||url.username||url.password||url.search||url.hash||isIP(url.hostname)!==0||!/^[a-z0-9.-]+$/.test(url.hostname)||!/^hailp_[A-Za-z0-9_-]{43}$/.test(token))throw new Error("Invalid signup origin or token");
    return new AccountApiClient(provider,token,"");
  }

  static async fromCredentialFile(path: string, selection: { provider?: string | undefined; accountId?: string | undefined } = {}): Promise<AccountApiClient> {
    const record = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await privateFile(path, 16_384))));
    if (record.type !== "hailp.api-credential" || record.version !== 1 ||
      typeof record.provider !== "string" || typeof record.token !== "string" ||
      !/^hailp_[A-Za-z0-9_-]{43}$/.test(record.token) || typeof record.accountId !== "string" || !UUID.test(record.accountId)) {
      throw new Error("Invalid hailp credential file");
    }
    const url = new URL(record.provider);
    if (url.protocol !== "https:" || url.origin !== record.provider || url.username || url.password ||
      url.search || url.hash || isIP(url.hostname) !== 0 || !/^[a-z0-9.-]+$/.test(url.hostname)) {
      throw new Error("Credential provider must be a canonical HTTPS DNS origin");
    }
    if (selection.provider !== undefined && selection.provider !== record.provider ||
      selection.accountId !== undefined && selection.accountId !== record.accountId) {
      throw new ClientError("SELECTION_MISMATCH", "Selected provider/account does not match the private credential; select a matching credential file");
    }
    return new AccountApiClient(record.provider, record.token, record.accountId);
  }

  async request(path: string, bytes?: Uint8Array | JsonObject, namespace = "/api/v1/account",maxResponse=MAX_RESPONSE, signal?: AbortSignal): Promise<JsonObject> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`,
      Accept: "application/json", "Accept-Encoding": "identity", "Cache-Control": "no-store" };
    if (bytes) headers["Content-Type"] = bytes instanceof Uint8Array ? 'application/cose; cose-type="cose-sign1"' : "application/json";
    let response: Response;
    try {
      response = await fetch(`${this.provider}${namespace}${path}`, {
        method: bytes ? bytes instanceof Uint8Array ? "PUT" : "POST" : "GET", headers, redirect: "error", credentials: "omit",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000), ...(bytes ? { body: bytes instanceof Uint8Array ? Uint8Array.from(bytes) : JSON.stringify(bytes) } : {}),
      });
    } catch { throw new ClientError("TRANSPORT_ERROR", "Provider API transport failed; check connectivity/HTTPS trust and retain exact retry artifacts"); }
    if (!response.ok) {
      const retry = response.headers.get("Retry-After");
      let seconds: number | undefined;
      if (retry !== null) {
        const delay = /^\d+$/.test(retry) ? Number(retry) : Math.ceil((Date.parse(retry) - Date.now()) / 1000);
        if (Number.isFinite(delay) && delay >= 0) seconds = Math.min(delay, 300);
      }
      void response.body?.cancel(); throw new AccountApiError(response.status, seconds);
    }
    const length = response.headers.get("Content-Length");
    if (response.headers.get("Content-Type") !== "application/json" || response.headers.has("Content-Encoding") ||
      response.headers.has("Location") || length !== null && (!/^\d+$/.test(length) || Number(length) > maxResponse)) {
      void response.body?.cancel();
      throw new ClientError("RESPONSE_ERROR", "Provider API returned an invalid response representation");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ClientError("RESPONSE_ERROR", "Provider API returned an empty response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > maxResponse) throw new ClientError("RESPONSE_ERROR", "Provider API response exceeded its limit");
        chunks.push(next.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof ClientError) throw error;
      throw new ClientError("TRANSPORT_ERROR", "Provider response was interrupted; retain exact retry artifacts");
    }
    const all = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
    try { return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all))); }
    catch { throw new ClientError("RESPONSE_ERROR", "Provider API returned invalid JSON"); }
  }

  async account() {
    const result = await this.request("");
    const publicKey = (value: unknown) => value === null || typeof value === "string" &&
      value.length <= 256 && /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(value);
    if (result.type !== "hailp.account" || result.version !== 1 || result.provider !== this.provider ||
      result.accountId !== this.accountId || typeof result.did !== "string" || !/^did:plc:[a-z2-7]{24}$/.test(result.did) ||
      typeof result.address !== "string" || result.address.length > 254 ||
      ![null, "fenced", "exported", "retired"].includes(result.migrationState as null | string) ||
      !["owner-controlled", "managed", "custodial-poc", "unknown"].includes(result.custodyProfile as string) ||
      (result.custodyProfile === "managed" && result.monitorVerificationMode === "strict-public-v1" &&
        result.managedProfileVersion !== MANAGED_CUSTODY_PROFILE_VERSION) ||
      (result.custodyProfile !== "managed" && result.managedProfileVersion !== null && result.managedProfileVersion !== undefined) ||
      (result.managedProfileVersion !== undefined && result.managedProfileVersion !== null &&
        result.managedProfileVersion !== MANAGED_CUSTODY_PROFILE_VERSION) ||
      !publicKey(result.identityPublicKey) || !publicKey(result.ownerRecoveryPublicKey) ||
      ![null, "independent", "poc-local", "strict-public-v1"].includes(result.monitorVerificationMode as null | string) ||
       !Array.isArray(result.scopes) || !result.scopes.every(scope => ACCOUNT_API_SCOPES.includes(scope))) {
      throw new ClientError("RESPONSE_ERROR", "Provider account does not match the credential or API contract");
    }
    let credential: { credentialId: string; expiresAt: string } | null = null;
    if (result.credential !== undefined) {
      const metadata = object(result.credential);
      if (typeof metadata.credentialId !== "string" || !UUID.test(metadata.credentialId) ||
        typeof metadata.expiresAt !== "string" || !Number.isFinite(Date.parse(metadata.expiresAt))) {
        throw new ClientError("RESPONSE_ERROR", "Provider returned invalid current credential metadata");
      }
      credential = { credentialId: metadata.credentialId, expiresAt: metadata.expiresAt };
    }
    return { provider: this.provider, accountId: this.accountId, did: result.did, address: result.address,
      migrationState: result.migrationState, custodyProfile: result.custodyProfile, scopes: result.scopes,
      monitorVerificationMode: result.monitorVerificationMode, identityPublicKey: result.identityPublicKey,
      ownerRecoveryPublicKey: result.ownerRecoveryPublicKey, managedProfileVersion: result.managedProfileVersion ?? null, credential };
  }

  async grant(id: string): Promise<{ representation: Uint8Array; payload: HailGrant; localRole: "grantor" | "grantee"; digest: string }> {
    if (!GRANT_ID.test(id)) throw new Error("Grant ID must be a canonical UUIDv7");
    const result = await this.request(`/grants/${id}`);
    if (result.type !== "hailp.grant" || result.version !== 1 ||
      typeof result.cose !== "string" || result.cose.length > 349_528 || typeof result.digest !== "string" ||
      !["grantor", "grantee"].includes(result.localRole as string)) throw new ClientError("RESPONSE_ERROR", "Invalid provider Grant response");
    const representation = decodeBase64Url(result.cose);
    const payload = inspectSignedPayload("hail.grant", representation).payload;
    const digest = encodeBase64Url(new Uint8Array(createHash("sha256").update(representation).digest()));
    if (payload.grant_id !== id || digest !== result.digest) throw new ClientError("RESPONSE_ERROR", "Provider Grant bytes or ID do not match");
    return { representation, payload, localRole: result.localRole as "grantor" | "grantee", digest };
  }

  async submit(representation: Uint8Array) {
    if (representation.length > 262_144) throw new Error("Signed Grant exceeds its limit");
    const payload = inspectSignedPayload("hail.grant", representation).payload;
    const result = await this.request(`/grants/${payload.grant_id}`, representation);
    const digest = encodeBase64Url(new Uint8Array(createHash("sha256").update(representation).digest()));
    if (result.grantId !== payload.grant_id || result.revision !== payload.revision || result.status !== payload.status ||
      result.digest !== digest || result.publication !== "durable") throw new ClientError("RESPONSE_ERROR", "Provider did not acknowledge the exact signed Grant");
    return { grantId: payload.grant_id, revision: payload.revision, status: payload.status, digest, publication: "durable" };
  }

  async profile():Promise<{representation:Uint8Array;payload:HailSenderProfile;digest:string}>{
    return this.profileResponse(await this.request("/profile"));
  }

  async saveProfile(definition:JsonObject,expectedRevision:number){
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw new Error("Expected Sender Profile revision must be non-negative");
    return this.profileResponse(await this.request("/profile",{definition,expectedRevision}));
  }

  private profileResponse(result:JsonObject){
    if(result.type!=="hailp.sender-profile"||result.version!==1||typeof result.cose!=="string"||
      result.cose.length>349_528||typeof result.digest!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(result.digest)||
      !Number.isSafeInteger(result.revision))throw new ClientError("RESPONSE_ERROR","Invalid provider Sender Profile response");
    const representation=decodeBase64Url(result.cose),payload=inspectSignedPayload("hail.sender-profile",representation).payload;
    const digest=encodeBase64Url(new Uint8Array(createHash("sha256").update(representation).digest()));
    if(payload.revision!==result.revision||digest!==result.digest)throw new ClientError("RESPONSE_ERROR","Provider Sender Profile bytes do not match");
    return {representation,payload,digest};
  }

  async propose(sender: string, category: string|string[] | null, expiresAt: number | null): Promise<HailGrant> {
    const result = await this.request("/grants/proposals", Array.isArray(category)?{sender,scope:{type:"categories",values:[...category].sort()},expiresAt}:{sender,category,expiresAt});
    if (result.type !== "hailp.grant-proposal" || result.version !== 1) throw new ClientError("RESPONSE_ERROR", "Invalid Grant proposal");
    return fromDiagnosticJson("hail.grant", result.grant as DiagnosticJson);
  }
}
