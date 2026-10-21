import { publicPlcAuthorityConfig } from "./plc/public-resolver.js";
import type { PublicPlcAuthorityConfig } from "./plc/observers.js";
import { canonicalPlcReadOrigin } from "./plc/observers.js";
import { base58btc } from "multiformats/bases/base58";

export type NodeEnvironment = "development" | "test" | "production";

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  port: number;
  providerId: string;
  publicOrigin: string;
  hailServiceBase: string;
  plcDirectoryUrl: string;
  databaseUrl: string;
  keyEncryptionKey: string;
  publicPlcAuthority?: PublicPlcAuthorityConfig;
  plcReaderDiagnosticDid?: string;
  pocManagedTransfer: boolean;
  publicManagedTransfer?: { monitorOrigin: string; monitorPublicKey: string };
}

type Environment = Record<string, string | undefined>;

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const BASE64URL_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseUrl(
  value: string,
  name: string,
  protocols: readonly string[],
  allowCredentials = false,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }

  if (!protocols.includes(url.protocol)) {
    throw new Error(`${name} must use ${protocols.join(" or ")}`);
  }
  if ((!allowCredentials && (url.username || url.password)) || url.search || url.hash) {
    throw new Error(`${name} must not contain credentials, a query, or a fragment`);
  }
  return url;
}

function withoutTrailingSlash(url: URL): string {
  return url.href.endsWith("/") ? url.href.slice(0, -1) : url.href;
}

export function loadConfig(environment: Environment = Bun.env): AppConfig {
  const nodeEnv = required(environment, "NODE_ENV");
  if (nodeEnv !== "development" && nodeEnv !== "test" && nodeEnv !== "production") {
    throw new Error("NODE_ENV must be development, test, or production");
  }

  const portText = required(environment, "PORT");
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || String(port) !== portText) {
    throw new Error("PORT must be a canonical integer from 1 through 65535");
  }

  const providerId = required(environment, "PROVIDER_ID");
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw new Error("PROVIDER_ID must be a lowercase LDH-style identifier");
  }

  const publicOriginUrl = parseUrl(
    required(environment, "PUBLIC_ORIGIN"),
    "PUBLIC_ORIGIN",
    ["https:"],
  );
  if (publicOriginUrl.pathname !== "/") {
    throw new Error("PUBLIC_ORIGIN must not contain a path");
  }
  const publicOrigin = withoutTrailingSlash(publicOriginUrl);

  const hailServiceUrl = parseUrl(
    required(environment, "HAIL_SERVICE_BASE"),
    "HAIL_SERVICE_BASE",
    ["https:"],
  );
  const hailServiceBase = withoutTrailingSlash(hailServiceUrl);
  if (hailServiceBase !== `${publicOrigin}/hail`) {
    throw new Error("HAIL_SERVICE_BASE must equal PUBLIC_ORIGIN followed by /hail");
  }

  const plcDirectoryUrl = withoutTrailingSlash(
    parseUrl(
      required(environment, "PLC_DIRECTORY_URL"),
      "PLC_DIRECTORY_URL",
      ["http:", "https:"],
    ),
  );

  const databaseUrl = withoutTrailingSlash(
    parseUrl(
      required(environment, "DATABASE_URL"),
      "DATABASE_URL",
      ["postgres:", "postgresql:"],
      true,
    ),
  );

  const keyEncryptionKey = required(environment, "KEY_ENCRYPTION_KEY");
  if (!BASE64URL_KEY_PATTERN.test(keyEncryptionKey)) {
    throw new Error("KEY_ENCRYPTION_KEY must be a 32-byte unpadded base64url value");
  }
  try {
    if (decodeBase64Url(keyEncryptionKey).length !== 32) throw new Error();
  } catch {
    throw new Error("KEY_ENCRYPTION_KEY must be a canonical 32-byte unpadded base64url value");
  }

  const publicPlcAuthority = publicPlcAuthorityConfig(environment, plcDirectoryUrl, publicOrigin);
  const plcReaderDiagnosticDid=environment.PLC_READER_DIAGNOSTIC_DID?.trim();
  if(plcReaderDiagnosticDid&&!/^did:plc:[a-z2-7]{24}$/.test(plcReaderDiagnosticDid))
    throw new Error("PLC_READER_DIAGNOSTIC_DID must be a canonical did:plc");
  if(plcReaderDiagnosticDid&&!publicPlcAuthority)throw new Error("PLC reader diagnostics require strict public authority");
  const managedGate=environment.POC_MANAGED_TRANSFER?.trim();
  if(managedGate!==undefined&&managedGate!=="true"&&managedGate!=="false")throw new Error("POC_MANAGED_TRANSFER must be true or false");
  const pocManagedTransfer=managedGate==="true";
  const publicGate=environment.PUBLIC_MANAGED_TRANSFER?.trim();
  if(publicGate!==undefined&&publicGate!=="true"&&publicGate!=="false")throw new Error("PUBLIC_MANAGED_TRANSFER must be true or false");
  let publicManagedTransfer:AppConfig["publicManagedTransfer"];
  if(publicGate==="true") {
    if(nodeEnv!=="production"||plcDirectoryUrl!=="https://plc.directory"||!publicPlcAuthority||
      publicPlcAuthority.providerOperators.length!==2||pocManagedTransfer||
      ["POC_ACCOUNT_ACCESS","POC_SELF_SERVICE_TRANSFER","POC_SELF_SERVICE_RETURN","POC_SELF_SERVICE_ONBOARDING","POC_SCHEMA_REHEARSAL"]
        .some(name=>environment[name]==="true"))throw new Error("Public managed transfer requires production strict public authority, both provider operators, and no private-POC gates");
    const monitorOrigin=required(environment,"PLC_MANAGED_MONITOR_ORIGIN"),monitorPublicKey=required(environment,"PLC_MANAGED_MONITOR_PUBLIC_KEY");
    if(!canonicalPlcReadOrigin(monitorOrigin)||new URL(monitorOrigin).hostname===publicOriginUrl.hostname||
      !/^did:key:z[1-9A-HJ-NP-Za-km-z]{1,128}$/.test(monitorPublicKey))throw new Error("Public managed transfer requires a pinned independent HTTPS monitor and Ed25519 key");
    const key=base58btc.decode(monitorPublicKey.slice(8));
    if(key.length!==34||key[0]!==0xed||key[1]!==1)throw new Error("Managed monitor key must be Ed25519");
    publicManagedTransfer={monitorOrigin,monitorPublicKey};
  } else if(environment.PLC_MANAGED_MONITOR_ORIGIN||environment.PLC_MANAGED_MONITOR_PUBLIC_KEY) {
    throw new Error("Managed monitor declarations require PUBLIC_MANAGED_TRANSFER=true");
  }
  if(pocManagedTransfer&&(plcDirectoryUrl==="https://plc.directory"||publicPlcAuthority||
    environment.POC_ACCOUNT_ACCESS!=="true"||environment.POC_SELF_SERVICE_TRANSFER!=="true"||
    environment.POC_SELF_SERVICE_RETURN!=="true")) {
    throw new Error("Private-PLC managed transfer requires account access, transfer/return gates, and a non-public PLC profile");
  }
  return {
    nodeEnv,
    port,
    providerId,
    publicOrigin,
    hailServiceBase,
    plcDirectoryUrl,
    databaseUrl,
    keyEncryptionKey,
    pocManagedTransfer,
    ...(publicManagedTransfer?{publicManagedTransfer}:{}),
    ...(publicPlcAuthority ? { publicPlcAuthority } : {}),
    ...(plcReaderDiagnosticDid?{plcReaderDiagnosticDid}:{}),
  };
}
import { decodeBase64Url } from "@hailproto/codec";
