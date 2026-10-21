import { isDeepStrictEqual } from "node:util";
import {
  def,
  validateOperationLog,
  type DidDocument,
  type DocumentData,
  type ExportedOp,
  type Operation,
} from "@did-plc/lib";
import * as dagCbor from "@ipld/dag-cbor";
import type { PlcDirectoryClient } from "./client.js";

export interface PlcReadbackEvidence {
  document: DidDocument;
  data: DocumentData;
  log: Operation[];
  audit: ExportedOp[];
}

export async function verifyRegisteredGenesis(input: {
  client: PlcDirectoryClient;
  did: string;
  cid: string;
  operation: Operation;
  dagCbor: Uint8Array;
  expectedState: DocumentData;
}): Promise<PlcReadbackEvidence> {
  const [rawDocument, rawData, rawLog, rawAudit] = await Promise.all([
    input.client.getDocument(input.did),
    input.client.getDocumentData(input.did),
    input.client.getOperationLog(input.did),
    input.client.getAuditableLog(input.did),
  ]);
  const document = def.didDocument.parse(rawDocument);
  const data = def.documentData.parse(rawData);
  const log = rawLog.map((operation) => def.operation.parse(operation));
  const audit = rawAudit.map((entry) => def.exportedOp.parse(entry));
  const validated = await validateOperationLog(input.did, log);
  if (validated === null || !isDeepStrictEqual(validated, input.expectedState)) {
    throw new Error("PLC operation log does not produce the expected state");
  }
  if (!isDeepStrictEqual(data, input.expectedState)) {
    throw new Error("PLC data response does not match the expected state");
  }
  if (log.length !== 1 || !isDeepStrictEqual(log[0], input.operation)) {
    throw new Error("PLC genesis operation does not match persisted evidence");
  }
  const returnedBytes = new Uint8Array(dagCbor.encode(log[0]));
  if (!Buffer.from(returnedBytes).equals(Buffer.from(input.dagCbor))) {
    throw new Error("PLC genesis DAG-CBOR does not match persisted evidence");
  }
  if (
    audit.length !== 1 ||
    audit[0]?.cid !== input.cid ||
    audit[0].did !== input.did ||
    audit[0].nullified !== false ||
    !isDeepStrictEqual(audit[0].operation, input.operation)
  ) {
    throw new Error("PLC audit response does not confirm the expected genesis");
  }
  if (document.id !== input.did) throw new Error("PLC DID document ID does not match");
  if (!isDeepStrictEqual(document.alsoKnownAs, input.expectedState.alsoKnownAs)) {
    throw new Error("PLC DID document aliases do not match expected state");
  }
  if (document.service.length !== 1) {
    throw new Error("PLC DID document must contain exactly one service");
  }
  const service = document.service[0];
  if (
    service?.id !== "#hail" ||
    service?.type !== "HailMessaging" ||
    service.serviceEndpoint !== input.expectedState.services.hail?.endpoint
  ) {
    throw new Error("PLC DID document does not contain the expected Hail service");
  }
  if (document.verificationMethod.length !== 2) {
    throw new Error("PLC DID document must contain exactly two verification methods");
  }
  const methodIds = new Set(document.verificationMethod.map((entry) => entry.id));
  if (methodIds.size !== document.verificationMethod.length) {
    throw new Error("PLC DID document contains duplicate verification method IDs");
  }
  for (const name of ["hail-identity", "hail-messaging"] as const) {
    const method = document.verificationMethod.find(
      (entry) => entry.id === `${input.did}#${name}`,
    );
    const expectedDidKey = input.expectedState.verificationMethods[name];
    if (
      !method ||
      method.controller !== input.did ||
      method.type !== "Multikey" ||
      method.publicKeyMultibase !== expectedDidKey?.replace(/^did:key:/, "")
    ) {
      throw new Error(`PLC DID document does not contain #${name}`);
    }
  }
  return { document, data, log, audit };
}
