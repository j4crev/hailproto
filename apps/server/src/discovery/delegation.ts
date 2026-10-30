import { Resolver } from "node:dns/promises";
import { canonicalizeHailAddress } from "../identity/address.js";

export type ProviderDiscovery = (domain: string, signal: AbortSignal) => Promise<string | null>;
export interface TxtResolver {
  resolveTxt(name: string): Promise<string[][]>;
  cancel(): void;
}

// Each lookup owns its resolver so cancellation never affects another request.
// No application cache: resolveTxt does not expose the remaining DNS TTL.
export async function lookupTxt(
  name: string, signal: AbortSignal,
  createResolver: () => TxtResolver = () => new Resolver({ timeout: 2_000, tries: 2 }),
): Promise<string[][]> {
  signal.throwIfAborted();
  const resolver = createResolver();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => { reject(signal.reason); resolver.cancel(); };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const records = await Promise.race([resolver.resolveTxt(name), cancelled]);
    signal.throwIfAborted();
    if (records.length > 32 || records.reduce((sum, rr) => sum + rr.reduce((n, part) => n + Buffer.byteLength(part), 0), 0) > 8192) {
      throw new Error("DNS TXT response exceeds its size limit");
    }
    return records;
  } catch (error) {
    signal.throwIfAborted();
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENODATA" || code === "ENOTFOUND") return [];
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function createProviderDiscovery(
  createResolver?: () => TxtResolver,
): ProviderDiscovery {
  return async (domain, signal) => {
    const records = await lookupTxt(`_hail-provider.${domain}`, signal, createResolver);
    if (records.length === 0) return null;
    if (records.length !== 1) throw new Error("Ambiguous Hail provider delegation");
    const chunks = records[0]!;
    if (chunks.reduce((size, chunk) => size + Buffer.byteLength(chunk), 0) > 512) {
      throw new Error("Hail provider delegation exceeds its size limit");
    }
    const record = chunks.join("");
    const match = /^v=hail1; provider=([a-z0-9.-]+)$/.exec(record);
    if (!match || match[0] !== record) throw new Error("Invalid or unsupported Hail provider delegation");
    const hostname = match[1]!;
    // Reuse Hail's public-domain, IDNA and address-literal validation.
    if (canonicalizeHailAddress(`discovery@${hostname}`) !== `discovery@${hostname}`) {
      throw new Error("Hail provider hostname must be canonical");
    }
    return hostname;
  };
}

export const discoverProvider = createProviderDiscovery();

// Only local provider configuration establishes this exception. Hosted custom
// domains and remote providers still need DNS; registration uses discoverProvider
// directly so ownership/delegation checks never inherit this shortcut.
export function providerDiscoveryForOrigin(origin: string, discover: ProviderDiscovery = discoverProvider): ProviderDiscovery {
  const nativeDomain = new URL(origin).hostname;
  return async (domain, signal) => {
    signal.throwIfAborted();
    return domain === nativeDomain ? null : discover(domain, signal);
  };
}
