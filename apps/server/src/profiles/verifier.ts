import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  createWebCryptoVerifier,
  decodeBase64Url,
  encodeBase64Url,
  verifySignedPayload,
} from "@hailproto/codec";
import { COSE_SIGN1_MEDIA_TYPE } from "../discovery/routes.js";
import type { DiscoveryFetch, NetworkTargetValidator } from "../discovery/verifier.js";
import { isCoseSign1MediaType } from "../http/media-type.js";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import type { HailDidResolver, ResolvedHailDid } from "../plc/resolver.js";
import type {
  VerifiedSenderProfile,
  VerifiedSenderProfileStore,
} from "./store.js";

const DID_PATTERN = /^did:plc:[a-z2-7]{24}$/;
const MAX_PROFILE_BYTES = 65_536;
const STRONG_ETAG = /^"([A-Za-z0-9_-]{43})"$/;

async function responseBytes(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_PROFILE_BYTES)) {
    throw new Error("Sender Profile exceeds its size limit");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_PROFILE_BYTES) {
      await reader.cancel();
      throw new Error("Sender Profile exceeds its size limit");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function parseEtag(value: string | null): string {
  const match = value ? STRONG_ETAG.exec(value) : null;
  if (!match?.[1]) throw new Error("Sender Profile response has an invalid ETag");
  try {
    if (decodeBase64Url(match[1]).length !== 32) throw new Error();
  } catch {
    throw new Error("Sender Profile response has an invalid ETag");
  }
  return match[1];
}

export class SenderProfileVerifier {
  constructor(
    private readonly resolver: HailDidResolver,
    private readonly fetchRequest: DiscoveryFetch,
    private readonly validateTarget: NetworkTargetValidator,
    private readonly now: () => Date = () => new Date(),
    private readonly store?: VerifiedSenderProfileStore,
  ) {}

  async verify(
    did: string,
    suppliedRetained?: VerifiedSenderProfile,
  ): Promise<VerifiedSenderProfile> {
    if (!DID_PATTERN.test(did)) throw new Error("Sender Profile DID is not canonical");
    if (suppliedRetained && suppliedRetained.did !== did) {
      throw new Error("Retained Sender Profile belongs to another DID");
    }
    const retained =
      suppliedRetained ?? (await this.store?.getLatestVerifiedSenderProfile(did)) ?? undefined;
    let resolved = await this.resolver.resolve(did);
    let response: Response;
    try {
      response = await this.fetch(resolved, did, retained);
    } catch (error) {
      const refreshed = await this.resolver.resolve(did);
      if (refreshed.serviceBase === resolved.serviceBase) throw error;
      resolved = refreshed;
      response = await this.fetch(resolved, did, retained);
    }
    if (
      (response.status >= 300 && response.status < 400 && response.status !== 304) ||
      response.status === 404 ||
      response.status === 410 ||
      response.status === 421
    ) {
      const refreshed = await this.resolver.resolve(did);
      if (refreshed.serviceBase === resolved.serviceBase) {
        throw new Error(`Sender Profile retrieval returned ${response.status}`);
      }
      resolved = refreshed;
      response = await this.fetch(resolved, did, retained);
    }

    if (response.status === 304) {
      if (!retained || retained.did !== did) {
        throw new Error("Sender Profile returned 304 without retained evidence");
      }
      const responseEtag = parseEtag(response.headers.get("etag"));
      if (responseEtag !== retained.etag) {
        throw new Error("Sender Profile 304 ETag does not match retained evidence");
      }
      const result = await this.verifyRepresentation(resolved, did, retained.representation, retained);
      if (result.etag !== responseEtag) {
        throw new Error("Sender Profile 304 ETag does not match retained representation");
      }
      await this.store?.retainVerifiedSenderProfile(result);
      return result;
    }
    if (response.status !== 200) {
      throw new Error(`Sender Profile retrieval returned ${response.status}`);
    }
    if (response.redirected) throw new Error("Sender Profile retrieval must not redirect");
    if (!isCoseSign1MediaType(response.headers.get("content-type"))) {
      throw new Error("Sender Profile response has the wrong content type");
    }
    if (response.headers.has("content-encoding")) {
      throw new Error("Sender Profile response must not use content encoding");
    }
    const representation = await responseBytes(response);
    const result = await this.verifyRepresentation(resolved, did, representation, retained);
    if (parseEtag(response.headers.get("etag")) !== result.etag) {
      throw new Error("Sender Profile ETag does not match its representation");
    }
    await this.store?.retainVerifiedSenderProfile(result);
    return result;
  }

  private async fetch(
    resolved: ResolvedHailDid,
    did: string,
    retained?: VerifiedSenderProfile,
  ): Promise<Response> {
    const url = new URL(`${resolved.serviceBase}/profiles/${did}`);
    await this.validateTarget(url);
    return this.fetchRequest(
      new Request(url, {
        headers: {
          Accept: COSE_SIGN1_MEDIA_TYPE,
          "Accept-Encoding": "identity",
          ...(retained ? { "If-None-Match": `"${retained.etag}"` } : {}),
        },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      }),
    );
  }

  private async verifyRepresentation(
    resolved: ResolvedHailDid,
    did: string,
    representation: Uint8Array,
    retained?: VerifiedSenderProfile,
  ): Promise<VerifiedSenderProfile> {
    const keyId = `${did}#hail-messaging`;
    const publicKey = await ed25519PublicKeyFromDidKey(resolved.messagingDidKey);
    const verified = await verifySignedPayload(
      "hail.sender-profile",
      representation,
      createWebCryptoVerifier(async (requestedKeyId) => {
        if (requestedKeyId !== keyId) throw new Error("Unexpected Sender Profile key ID");
        return publicKey;
      }),
    );
    const profile = verified.payload;
    if (profile.did !== did) throw new Error("Sender Profile names another DID");
    const current = Math.floor(this.now().getTime() / 1_000);
    if (profile.updated_at > current + 300) {
      throw new Error("Sender Profile timestamp is too far in the future");
    }
    if (retained) {
      if (profile.revision < retained.profile.revision) {
        throw new Error("Sender Profile revision rollback detected");
      }
      if (
        profile.revision === retained.profile.revision &&
        !isDeepStrictEqual(representation, retained.representation)
      ) {
        throw new Error("Sender Profile revision conflicts with retained evidence");
      }
      if (
        profile.revision > retained.profile.revision &&
        profile.updated_at <= retained.profile.updated_at
      ) {
        throw new Error("Sender Profile updated_at did not advance");
      }
    }
    const digest = new Uint8Array(createHash("sha256").update(representation).digest());
    return {
      did,
      serviceBase: resolved.serviceBase,
      messagingDidKey: resolved.messagingDidKey,
      profile,
      representation: Uint8Array.from(representation),
      digest,
      etag: encodeBase64Url(digest),
      plcEvidence: resolved.evidence,
      verifiedAt: this.now(),
    };
  }
}
