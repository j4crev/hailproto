import { encodeBase64Url } from "@hailproto/codec";
import type { DiscoveryFetch, NetworkTargetValidator } from "../discovery/verifier.js";
import { COSE_SIGN1_MEDIA_TYPE } from "../discovery/routes.js";
import type { HailDidResolver } from "../plc/resolver.js";
import type { GrantPublicationClaim, GrantStore } from "./store.js";

const EMPTY_RESPONSE_LIMIT = 65_536;

export type GrantPublishOutcome = "idle" | "acknowledged" | "retry" | "blocked";

function expectedEtag(claim: GrantPublicationClaim): string {
  return `"${encodeBase64Url(claim.grant.digest)}"`;
}

function conditionHeaders(claim: GrantPublicationClaim): Record<string, string> {
  if (claim.grant.payload.revision === 1) return { "If-None-Match": "*" };
  const previous = claim.grant.payload.previous;
  if (!previous) throw new Error("Grant update is missing its predecessor digest");
  return { "If-Match": `"${encodeBase64Url(previous)}"` };
}

function retryAfter(response: Response, now: Date): Date | null {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    return new Date(now.getTime() + Math.min(Number(value), 3_600) * 1_000);
  }
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime()) || instant <= now) return null;
  return new Date(Math.min(instant.getTime(), now.getTime() + 3_600_000));
}

async function boundedResponseBytes(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > EMPTY_RESPONSE_LIMIT)) {
    throw new Error("Grant publication response exceeds its size limit");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > EMPTY_RESPONSE_LIMIT) {
      await reader.cancel();
      throw new Error("Grant publication response exceeds its size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export class GrantPublisher {
  constructor(
    private readonly grants: GrantStore,
    private readonly resolver: HailDidResolver,
    private readonly fetchRequest: DiscoveryFetch,
    private readonly validateTarget: NetworkTargetValidator,
    private readonly now: () => Date = () => new Date(),
    private readonly random: () => number = Math.random,
  ) {}

  async publishOne(): Promise<GrantPublishOutcome> {
    const claim = await this.grants.claimDuePublication(30_000, this.now());
    if (!claim) return "idle";
    const result = {
      grantId: claim.grant.payload.grant_id,
      revision: claim.grant.payload.revision,
      leaseToken: claim.leaseToken,
    };
    try {
      const grantee = await this.resolver.resolve(claim.grant.payload.grantee);
      const url = new URL(`${grantee.serviceBase}/grants/${claim.grant.payload.grant_id}`);
      await this.validateTarget(url);
      const response = await this.fetchRequest(
        new Request(url, {
          method: "PUT",
          headers: {
            "Content-Type": COSE_SIGN1_MEDIA_TYPE,
            "Accept-Encoding": "identity",
            "Cache-Control": "no-store",
            ...conditionHeaders(claim),
          },
          body: Uint8Array.from(claim.grant.representation).buffer,
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        }),
      );
      const responseBody = await boundedResponseBytes(response);
      const etag = response.headers.get("etag");
      const expected = expectedEtag(claim);
      const normalSuccess =
        (claim.grant.payload.revision === 1 && response.status === 201) ||
        (claim.grant.payload.revision > 1 && response.status === 204);
      const convergedCreation = claim.grant.payload.revision === 1 && response.status === 412;
      if ((normalSuccess || convergedCreation) && etag === expected) {
        if (normalSuccess && responseBody.length !== 0) {
          throw new Error("Successful Grant publication response must have no content");
        }
        if (response.status === 201) {
          const expectedLocation = url.href;
          if (response.headers.get("location") !== expectedLocation) {
            throw new Error("Created Grant response has an invalid Location");
          }
        }
        await this.grants.acknowledgePublication({ ...result, httpStatus: response.status, etag });
        return "acknowledged";
      }

      if ([400, 405, 409, 412, 413, 415, 428].includes(response.status)) {
        await this.grants.blockPublication({
          ...result,
          httpStatus: response.status,
          error: `Grant publication was permanently rejected with HTTP ${response.status}`,
        });
        return "blocked";
      }
      const instant = this.now();
      await this.grants.retryPublication({
        ...result,
        httpStatus: response.status,
        error: `Grant publication returned transient HTTP ${response.status}`,
        nextAttemptAt: retryAfter(response, instant) ?? this.nextAttempt(claim, instant),
      });
      return "retry";
    } catch (error) {
      const instant = this.now();
      await this.grants.retryPublication({
        ...result,
        error: error instanceof Error ? error.message.slice(0, 1_024) : "Grant publication failed",
        nextAttemptAt: this.nextAttempt(claim, instant),
      });
      return "retry";
    }
  }

  private nextAttempt(claim: GrantPublicationClaim, now: Date): Date {
    const baseSeconds = Math.min(3_600, 30 * 2 ** Math.min(claim.attemptCount - 1, 7));
    const jitteredSeconds = baseSeconds * (0.75 + this.random() * 0.5);
    return new Date(now.getTime() + Math.round(jitteredSeconds * 1_000));
  }
}
