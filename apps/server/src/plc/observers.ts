import { isIP } from "node:net";
import type { ExportedOp } from "@did-plc/lib";
import { PlcHailDidResolver, type HailDidResolver } from "./resolver.js";
import { createPlcDirectoryClient } from "./client.js";

export interface IndependentPlcObserver {
  origin: string;
  operator?: string;
  resolver: HailDidResolver;
  audit(did: string): Promise<readonly ExportedOp[]>;
  health?(): Promise<unknown>;
}

export interface PublicPlcAuthorityConfig {
  profile: "strict-public-v1";
  readers: readonly [{origin:string;operator:string},...{origin:string;operator:string}[]];
  providerOperators: readonly string[];
}

export function assertPublicPlcReaders(readers: readonly {origin:string;operator?:string}[], providerOperators: readonly string[], providerOrigins: readonly string[]): void {
  const operator = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
  const hosts = providerOrigins.map(origin => new URL(origin).hostname);
  if (readers.length < 1 || readers.length > 3 || providerOperators.length < 1 || providerOperators.length > 2 || !providerOperators.every(operator) ||
    readers.some(reader => !canonicalPlcReadOrigin(reader.origin) || !operator(reader.operator) || providerOperators.includes(reader.operator) ||
      hosts.includes(new URL(reader.origin).hostname)) || new Set(readers.map(reader=>reader.operator)).size !== readers.length ||
    new Set(readers.map(reader=>new URL(reader.origin).hostname)).size !== readers.length) {
    throw new Error("Strict public authority requires one to three distinct HTTPS reader/operator declarations outside the provider");
  }
}

export function canonicalPlcReadOrigin(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "https:" && input === url.origin && !url.username && !url.password &&
      isIP(url.hostname) === 0 && url.hostname.length <= 253 &&
      url.hostname.split(".").every(label => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
  } catch { return false; }
}

export function createIndependentPlcObserver(origin: string, operator: string): IndependentPlcObserver {
  if (!canonicalPlcReadOrigin(origin) || !/^[A-Za-z0-9._-]{1,128}$/.test(operator)) throw new Error("Invalid configured PLC reader origin/operator");
  const client = createPlcDirectoryClient(origin);
  return { origin, operator, resolver: new PlcHailDidResolver(client), audit: did => client.getAuditableLog(did),
    health: () => client.health() };
}

export function assertFreshPlcReaderHealth(value: unknown, now: Date, maxAgeMs = 300_000): void {
  const timestamp = value && typeof value === "object" && !Array.isArray(value) &&
    "lastCommittedOpTime" in value ? value.lastCommittedOpTime : undefined;
  const committed = typeof timestamp === "string" ? new Date(timestamp) : new Date(NaN);
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(committed.getTime()) || committed.toISOString() !== timestamp ||
    now.getTime() - committed.getTime() > maxAgeMs || committed.getTime() - now.getTime() > maxAgeMs) {
    throw new Error("PLC reader health is missing, stale or has an invalid clock");
  }
}
