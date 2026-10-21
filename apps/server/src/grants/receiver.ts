import { createHash } from "node:crypto";
import {
  createWebCryptoVerifier,
  decodeBase64Url,
  encodeBase64Url,
  inspectSignedPayload,
  verifySignedPayload,
  type HailGrant,
} from "@hailproto/codec";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import type { AccountRecord } from "../onboarding/repository.js";
import type { HailDidResolver } from "../plc/resolver.js";
import type { GrantStore, SignedGrantRevision } from "./store.js";
import { restrictsAuthorization } from "./revision.js";
import { isDeepStrictEqual } from "node:util";

const STRONG_ETAG = /^"([A-Za-z0-9_-]{43})"$/;

export interface GrantReceiverAccounts {
  getAccountByDid(did: string): Promise<AccountRecord | null>;
}

export interface GrantConditions {
  ifMatch: string | null;
  ifNoneMatch: string | null;
}

export interface GrantReceiveResult {
  status: 201 | 204 | 412;
  etag: string;
  created: boolean;
}

export class GrantReceiveError extends Error {
  constructor(
    readonly status: 400 | 409 | 412 | 413 | 415 | 421 | 428 | 429 | 503,
    message: string,
    readonly disclose = true,
  ) {
    super(message);
  }
}

function etag(bytes: Uint8Array): string {
  return `"${encodeBase64Url(bytes)}"`;
}

function exactRepresentation(current: SignedGrantRevision | null, representation: Uint8Array): boolean {
  return !!current && Buffer.from(current.representation).equals(Buffer.from(representation));
}

function parseStrongEtag(value: string): Uint8Array | null {
  const match = STRONG_ETAG.exec(value);
  if (!match?.[1]) return null;
  try {
    const bytes = decodeBase64Url(match[1]);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

function conflictFromPersistence(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === "23505" ||
    message.includes("Grant revision") ||
    message.includes("Grant lineage") ||
    message.includes("Grant parties") ||
    message.includes("terminal") ||
    message.includes("active pair")
  );
}

export class GrantReceiver {
  constructor(
    private readonly accounts: GrantReceiverAccounts,
    private readonly grants: GrantStore,
    private readonly resolver: HailDidResolver,
    private readonly expectedServiceBase: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async receive(
    pathGrantId: string,
    representation: Uint8Array,
    conditions: GrantConditions,
  ): Promise<GrantReceiveResult> {
    let authenticated: {
      payload: HailGrant;
      account: AccountRecord;
      identityDidKey: string;
      signingPlcEvidence: Awaited<ReturnType<HailDidResolver["resolve"]>>["evidence"];
      recipientEvidence: Awaited<ReturnType<HailDidResolver["resolve"]>>["evidence"];
    };
    try {
      const inspected = inspectSignedPayload("hail.grant", representation);
      const payload = inspected.payload;
      if (payload.grant_id !== pathGrantId) throw new Error("Grant path does not match payload");
      const grantor = await this.resolver.resolve(payload.grantor);
      await verifySignedPayload(
        "hail.grant",
        representation,
        createWebCryptoVerifier(async (keyId) => {
          if (keyId !== `${payload.grantor}#hail-identity`) {
            throw new Error("Unexpected Grant key ID");
          }
          return ed25519PublicKeyFromDidKey(grantor.identityDidKey);
        }),
      );
      const grantee = await this.resolver.resolve(payload.grantee);
      if (grantee.serviceBase !== this.expectedServiceBase) {
        throw new GrantReceiveError(421, "Misdirected Request", false);
      }
      const account = await this.accounts.getAccountByDid(payload.grantee);
      if (
        !account ||
        account.state !== "active" ||
        account.activationVerificationMode !== "public"
      ) {
        throw new Error("Grantee is not locally authoritative");
      }
      authenticated = {
        payload,
        account,
        identityDidKey: grantor.identityDidKey,
        signingPlcEvidence: grantor.evidence,
        recipientEvidence: grantee.evidence,
      };
    } catch (error) {
      if (error instanceof GrantReceiveError && error.status === 421) throw error;
      throw new GrantReceiveError(400, "Bad Request", false);
    }

    const { payload, account, identityDidKey, signingPlcEvidence,recipientEvidence } = authenticated;
    const wallClock = Math.floor(this.now().getTime() / 1_000);
    if (
      payload.issued_at > wallClock + 300 ||
      payload.updated_at > wallClock + 300 ||
      (payload.expires_at !== null && payload.expires_at < payload.issued_at)
    ) {
      throw new GrantReceiveError(400, "Grant timestamps are invalid");
    }
    const digest = new Uint8Array(createHash("sha256").update(representation).digest());
    if (payload.revision === 1) {
      if (conditions.ifMatch !== null || (conditions.ifNoneMatch !== null && conditions.ifNoneMatch !== "*")) {
        throw new GrantReceiveError(400, "Initial Grant condition is invalid");
      }
      if (conditions.ifNoneMatch === null) {
        throw new GrantReceiveError(428, "If-None-Match is required for an initial Grant");
      }
    } else {
      if (conditions.ifNoneMatch !== null || (conditions.ifMatch !== null && !parseStrongEtag(conditions.ifMatch))) {
        throw new GrantReceiveError(400, "Grant update condition is invalid");
      }
      if (conditions.ifMatch === null) {
        throw new GrantReceiveError(428, "If-Match is required for a Grant update");
      }
      if (!payload.previous || conditions.ifMatch !== etag(payload.previous)) {
        throw new GrantReceiveError(412, "Grant update precondition failed");
      }
    }
    let current: SignedGrantRevision | null;
    try {
      current = await (this.grants.findReceivedForSender?.(pathGrantId, payload.grantee) ??
        this.grants.findCurrentByGrantId(pathGrantId));
    } catch {
      throw new GrantReceiveError(503, "Grant storage is temporarily unavailable");
    }

    if (exactRepresentation(current, representation)) {
      return payload.revision === 1
        ? { status: 412, etag: etag(digest), created: false }
        : { status: 204, etag: etag(digest), created: false };
    }
    if (current) {
      if(restrictsAuthorization(current.payload,payload)&&!isDeepStrictEqual(current.payload.consent_context,payload.consent_context))throw new GrantReceiveError(409,"Restrictions must retain prior consent");
      if (
        current.localRole !== "grantee" ||
        current.payload.grantor !== payload.grantor ||
        current.payload.grantee !== payload.grantee ||
        payload.issued_at !== current.payload.issued_at ||
        payload.revision !== current.payload.revision + 1 ||
        current.payload.status === "revoked" ||
        !payload.previous ||
        !Buffer.from(payload.previous).equals(Buffer.from(current.digest)) ||
        payload.updated_at <= current.payload.updated_at
      ) {
        throw new GrantReceiveError(409, "The submitted revision conflicts with stored state");
      }
    } else if (payload.revision !== 1 || payload.status !== "active") {
      throw new GrantReceiveError(409, "The submitted Grant does not begin a valid lineage");
    }

    if (payload.revision === 1 && current) {
      throw new GrantReceiveError(409, "Grant ID is already in use");
    }

    try {
      await this.grants.acceptReceivedRevision({
        localAccountId: account.id,
        payload,
        representation,
        digest,
        signingPublicKey: identityDidKey,
        signingPlcEvidence,
        recipientEvidence,recipientServiceBase:this.expectedServiceBase,
      });
    } catch (error) {
      if (conflictFromPersistence(error)) {
        const winner = await (this.grants.findReceivedForSender?.(pathGrantId, payload.grantee) ??
          this.grants.findCurrentByGrantId(pathGrantId));
        if (exactRepresentation(winner, representation)) {
          return payload.revision === 1
            ? { status: 412, etag: etag(digest), created: false }
            : { status: 204, etag: etag(digest), created: false };
        }
        throw new GrantReceiveError(409, "The submitted revision conflicts with stored state");
      }
      throw new GrantReceiveError(503, "Grant storage is temporarily unavailable");
    }
    return {
      status: payload.revision === 1 ? 201 : 204,
      etag: etag(digest),
      created: payload.revision === 1,
    };
  }
}
