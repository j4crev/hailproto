import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { def, formatDidDoc, validateOperationLog } from "@did-plc/lib";
import type { PlcDirectoryClient } from "./client.js";

const DID_PATTERN = /^did:plc:[a-z2-7]{24}$/;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._~-]+$/;

export interface ResolvedHailDid {
  did: string;
  identityDidKey: string;
  messagingDidKey: string;
  serviceBase: string;
  evidence: PlcResolutionEvidence;
}

export interface PlcResolutionEvidence {
  document: object;
  data: object;
  log: readonly object[];
  verification?: { profile: "strict-public-v1" | "poc-local"; digest: string; operationCid: string; verifiedAt: string };
}

export interface HailDidResolver {
  resolve(did: string): Promise<ResolvedHailDid>;
}

export function canonicalizeHailServiceBase(input: string): string {
  if (
    !/^[\x21-\x7e]+$/.test(input) ||
    input.includes("%") ||
    input.includes("\\") ||
    input.endsWith("//")
  ) {
    throw new Error("Hail service base contains a forbidden URL form");
  }
  const url = new URL(input);
  const asciiHostname = domainToASCII(url.hostname);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !asciiHostname ||
    asciiHostname !== url.hostname ||
    url.hostname.endsWith(".") ||
    isIP(url.hostname) !== 0
  ) {
    throw new Error("Hail service base is not a canonical HTTPS DNS URL");
  }
  const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  for (const segment of pathname.split("/").slice(1)) {
    if (!PATH_SEGMENT_PATTERN.test(segment) || segment === "." || segment === "..") {
      throw new Error("Hail service base contains an invalid path segment");
    }
  }
  return `${url.origin}${pathname}`;
}

export class PlcHailDidResolver implements HailDidResolver {
  constructor(private readonly plc: PlcDirectoryClient) {}

  async resolve(did: string): Promise<ResolvedHailDid> {
    if (!DID_PATTERN.test(did)) throw new Error("DID is not canonical did:plc");
    const [rawDocument, rawData, rawLog] = await Promise.all([
      this.plc.getDocument(did),
      this.plc.getDocumentData(did),
      this.plc.getOperationLog(did),
    ]);
    const data = def.documentData.parse(rawData);
    const log = rawLog.map((operation) => def.compatibleOpOrTombstone.parse(operation));
    const validated = await validateOperationLog(did, log);
    const expectedDocument = formatDidDoc(data);
    const replicaDocument = rawDocument && typeof rawDocument === "object" && !Array.isArray(rawDocument) &&
      !("@context" in rawDocument) ? { ...rawDocument, "@context": expectedDocument["@context"] } : rawDocument;
    const document = def.didDocument.parse(replicaDocument);
    if (validated === null || !isDeepStrictEqual(validated, data) || document.id !== did) {
      throw new Error("PLC state failed validation");
    }
    const normalizeDocumentIds = (value: typeof document) => ({
      ...value,
      verificationMethod: value.verificationMethod.map((entry) => ({
        ...entry,
        id: entry.id.startsWith("#") ? `${did}${entry.id}` : entry.id,
      })),
      service: value.service.map((entry) => ({
        ...entry,
        id: entry.id.startsWith("#") ? `${did}${entry.id}` : entry.id,
      })),
    });
    if (!isDeepStrictEqual(normalizeDocumentIds(document), normalizeDocumentIds(expectedDocument))) {
      throw new Error("PLC rendered document does not match current validated state");
    }

    const identityDidKey = data.verificationMethods["hail-identity"];
    const messagingDidKey = data.verificationMethods["hail-messaging"];
    if (!identityDidKey || !messagingDidKey || identityDidKey === messagingDidKey) {
      throw new Error("PLC state does not contain distinct Hail keys");
    }
    const expand = (id: string) => (id.startsWith("#") ? `${did}${id}` : id);
    const methodIds = document.verificationMethod.map((entry) => expand(entry.id));
    if (new Set(methodIds).size !== methodIds.length) {
      throw new Error("PLC document contains duplicate verification methods");
    }
    for (const [role, didKey] of [
      ["hail-identity", identityDidKey],
      ["hail-messaging", messagingDidKey],
    ] as const) {
      const methods = document.verificationMethod.filter(
        (entry) => expand(entry.id) === `${did}#${role}`,
      );
      const method = methods[0];
      if (
        methods.length !== 1 ||
        !method ||
        method.type !== "Multikey" ||
        method.controller !== did ||
        method.publicKeyMultibase !== didKey.replace(/^did:key:/, "")
      ) {
        throw new Error(`PLC document does not authorize ${role}`);
      }
    }

    const serviceIds = document.service.map((entry) => expand(entry.id));
    if (new Set(serviceIds).size !== serviceIds.length) {
      throw new Error("PLC document contains duplicate services");
    }
    const hailServices = document.service.filter((entry) => entry.type === "HailMessaging");
    const renderedService = hailServices[0];
    const service = data.services.hail;
    if (
      hailServices.length !== 1 ||
      !renderedService ||
      expand(renderedService.id) !== `${did}#hail` ||
      !service ||
      service.type !== "HailMessaging" ||
      renderedService.serviceEndpoint !== service.endpoint
    ) {
      throw new Error("PLC document does not contain the expected Hail service");
    }

    return {
      did,
      identityDidKey,
      messagingDidKey,
      serviceBase: canonicalizeHailServiceBase(service.endpoint),
      evidence: { document: rawDocument as object, data, log },
    };
  }
}
