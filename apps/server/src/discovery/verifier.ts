import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  createWebCryptoVerifier,
  verifySignedPayload,
  type HailAddressBinding,
} from "@hailproto/codec";
import { canonicalizeHailAddress } from "../identity/address.js";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import type { PlcDirectoryClient } from "../plc/client.js";
import { PlcHailDidResolver } from "../plc/resolver.js";
import type { HailDidResolver, PlcResolutionEvidence } from "../plc/resolver.js";
import { ADDRESS_BINDING_REL, COSE_SIGN1_MEDIA_TYPE } from "./routes.js";
import { parseJsonWithoutDuplicateKeys } from "./strict-json.js";

const MAX_WEBFINGER_BYTES = 65_536;
const MAX_BINDING_BYTES = 16_384;

export type DiscoveryFetch = (request: Request) => Promise<Response>;
export type NetworkTargetValidator = (url: URL) => void | Promise<void>;

export interface VerifiedAddress {
  address: string;
  did: string;
  serviceBase: string;
  messagingDidKey: string;
  identityDidKey: string;
  plcEvidence: PlcResolutionEvidence;
  verifiedAt: Date;
  binding: HailAddressBinding;
  representation: Uint8Array;
  digest: Uint8Array;
}

interface JsonResourceDescriptor {
  subject: string;
  links: Array<{ rel?: unknown; type?: unknown; href?: unknown }>;
}

function validateHttpsUrl(url: URL): void {
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    isIP(url.hostname) !== 0
  ) {
    throw new Error("Discovery URL is not an allowed HTTPS URL");
  }
}

async function responseBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximum)
  ) {
    throw new Error("Discovery response exceeds its size limit");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maximum) {
      await reader.cancel();
      throw new Error("Discovery response exceeds its size limit");
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

function isCoseSign1MediaType(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parts = value.split(";").map((part) => part.trim());
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "application/cose") return false;
  const separator = parts[1]?.indexOf("=") ?? -1;
  if (separator < 1) return false;
  const name = parts[1]!.slice(0, separator).trim().toLowerCase();
  let parameter = parts[1]!.slice(separator + 1).trim();
  if (parameter.startsWith('"') && parameter.endsWith('"')) {
    parameter = parameter.slice(1, -1);
  }
  return name === "cose-type" && parameter.toLowerCase() === "cose-sign1";
}

function parseJrd(bytes: Uint8Array): JsonResourceDescriptor {
  const value = parseJsonWithoutDuplicateKeys(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WebFinger response must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.subject !== "string" || !Array.isArray(record.links)) {
    throw new Error("WebFinger response has an invalid shape");
  }
  return { subject: record.subject, links: record.links as JsonResourceDescriptor["links"] };
}

export class AddressVerifier {
  constructor(
    private readonly plc: PlcDirectoryClient,
    private readonly fetchRequest: DiscoveryFetch,
    private readonly validateTarget: NetworkTargetValidator,
    private readonly now: () => Date = () => new Date(),
    private readonly resolver: HailDidResolver = new PlcHailDidResolver(plc),
  ) {}

  async verify(addressInput: string): Promise<VerifiedAddress> {
    const address = canonicalizeHailAddress(addressInput);
    const resource = `acct:${address}`;
    const webfinger = new URL(`https://${address.slice(address.indexOf("@") + 1)}/.well-known/webfinger`);
    webfinger.searchParams.set("resource", resource);
    webfinger.searchParams.set("rel", ADDRESS_BINDING_REL);

    const signal = AbortSignal.timeout(10_000);
    const webfingerResponse = await this.fetchWebFinger(webfinger, signal);
    if (webfingerResponse.status !== 200) throw new Error("WebFinger lookup did not return 200");
    if (webfingerResponse.headers.get("content-type") !== "application/jrd+json") {
      throw new Error("WebFinger response has the wrong content type");
    }
    if (webfingerResponse.headers.has("content-encoding")) {
      throw new Error("WebFinger response must not use content encoding");
    }
    const jrd = parseJrd(await responseBytes(webfingerResponse, MAX_WEBFINGER_BYTES));
    if (jrd.subject !== resource) throw new Error("WebFinger subject does not match the address");
    const links = jrd.links.filter(
      (link) => link.rel === ADDRESS_BINDING_REL && isCoseSign1MediaType(link.type),
    );
    if (links.length !== 1 || typeof links[0]?.href !== "string") {
      throw new Error("WebFinger must select exactly one Hail Address Binding");
    }

    const bindingUrl = new URL(links[0].href);
    if (bindingUrl.href !== links[0].href) {
      throw new Error("Address Binding URL must already be canonical");
    }
    validateHttpsUrl(bindingUrl);
    if (bindingUrl.search) throw new Error("Address Binding URL must not contain a query");
    await this.validateTarget(bindingUrl);
    const bindingResponse = await this.fetchRequest(
      new Request(bindingUrl, {
        headers: {
          Accept: COSE_SIGN1_MEDIA_TYPE,
          "Accept-Encoding": "identity",
        },
        redirect: "manual",
        signal,
      }),
    );
    if (bindingResponse.status !== 200 || bindingResponse.redirected) {
      throw new Error("Address Binding retrieval did not return a direct 200 response");
    }
    if (!isCoseSign1MediaType(bindingResponse.headers.get("content-type"))) {
      throw new Error("Address Binding response has the wrong content type");
    }
    if (bindingResponse.headers.has("content-encoding")) {
      throw new Error("Address Binding response must not use content encoding");
    }
    const representation = await responseBytes(bindingResponse, MAX_BINDING_BYTES);
    const inspected = await this.resolveAndVerifyBinding(address, representation);
    const verifiedAt = this.now();
    return {
      address,
      did: inspected.binding.did,
      serviceBase: inspected.serviceBase,
      messagingDidKey: inspected.messagingDidKey,
      identityDidKey: inspected.identityDidKey,
      plcEvidence: inspected.plcEvidence,
      verifiedAt,
      binding: inspected.binding,
      representation,
      digest: new Uint8Array(createHash("sha256").update(representation).digest()),
    };
  }

  private async fetchWebFinger(initialUrl: URL, signal: AbortSignal): Promise<Response> {
    let url = initialUrl;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      validateHttpsUrl(url);
      await this.validateTarget(url);
      const response = await this.fetchRequest(
        new Request(url, {
          headers: { Accept: "application/jrd+json", "Accept-Encoding": "identity" },
          redirect: "manual",
          signal,
        }),
      );
      if (response.status < 300 || response.status >= 400) return response;
      if (redirects === 3) throw new Error("WebFinger exceeded its redirect limit");
      const location = response.headers.get("location");
      if (!location) throw new Error("WebFinger redirect has no Location header");
      url = new URL(location, url);
    }
    throw new Error("WebFinger redirect handling failed");
  }

  private async resolveAndVerifyBinding(
    address: string,
    representation: Uint8Array,
  ): Promise<{
    binding: HailAddressBinding;
    serviceBase: string;
    messagingDidKey: string;
    identityDidKey: string;
    plcEvidence: PlcResolutionEvidence;
  }> {
    let resolvedServiceBase: string | undefined;
    let resolvedMessagingDidKey: string | undefined;
    let resolvedIdentityDidKey: string | undefined;
    let plcEvidence: PlcResolutionEvidence | undefined;
    const inspected = await verifySignedPayload(
      "hail.address-binding",
      representation,
      createWebCryptoVerifier(async (keyId) => {
        const did = keyId.slice(0, keyId.indexOf("#"));
        const resolved = await this.resolver.resolve(did);
        if (keyId !== `${did}#hail-identity`) {
          throw new Error("Unexpected Address Binding key ID");
        }
        resolvedServiceBase = resolved.serviceBase;
        resolvedMessagingDidKey = resolved.messagingDidKey;
        resolvedIdentityDidKey = resolved.identityDidKey;
        plcEvidence = resolved.evidence;
        return ed25519PublicKeyFromDidKey(resolved.identityDidKey);
      }),
    );
    const binding = inspected.payload;
    if (binding.address !== address) throw new Error("Address Binding names another address");
    const current = Math.floor(this.now().getTime() / 1_000);
    if (binding.issued_at > current + 300 || current > binding.expires_at + 300) {
      throw new Error("Address Binding is outside its validity period");
    }
    if (!resolvedServiceBase || !resolvedMessagingDidKey || !resolvedIdentityDidKey || !plcEvidence) {
      throw new Error("PLC state did not resolve complete Hail service state");
    }
    return {
      binding,
      serviceBase: resolvedServiceBase,
      messagingDidKey: resolvedMessagingDidKey,
      identityDidKey: resolvedIdentityDidKey,
      plcEvidence,
    };
  }
}
