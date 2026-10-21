import { cidForCbor } from "@atproto/common";
import {
  didForCreateOp,
  signOperation,
  type DocumentData,
  type Operation,
  type UnsignedOperation,
} from "@did-plc/lib";
import * as dagCbor from "@ipld/dag-cbor";
import type { P256Keypair } from "@atproto/crypto";

export interface PreparedGenesis {
  did: string;
  cid: string;
  operation: Operation;
  operationBytes: Uint8Array;
  dagCbor: Uint8Array;
  expectedState: DocumentData;
}

export async function prepareGenesis(input: {
  rotationKey: P256Keypair;
  identityDidKey: string;
  messagingDidKey: string;
  hailServiceBase: string;
}): Promise<PreparedGenesis> {
  const unsigned: UnsignedOperation = {
    type: "plc_operation",
    rotationKeys: [input.rotationKey.did()],
    verificationMethods: {
      "hail-identity": input.identityDidKey,
      "hail-messaging": input.messagingDidKey,
    },
    alsoKnownAs: [],
    services: {
      hail: {
        type: "HailMessaging",
        endpoint: input.hailServiceBase,
      },
    },
    prev: null,
  };
  const operation = await signOperation(unsigned, input.rotationKey);
  const did = await didForCreateOp(operation);
  const encoded = new Uint8Array(dagCbor.encode(operation));
  if (encoded.length > 4_000) throw new Error("PLC genesis exceeds the directory limit");
  const cid = (await cidForCbor(operation)).toString();

  return {
    did,
    cid,
    operation,
    operationBytes: new TextEncoder().encode(JSON.stringify(operation)),
    dagCbor: encoded,
    expectedState: {
      did,
      rotationKeys: unsigned.rotationKeys,
      verificationMethods: unsigned.verificationMethods,
      alsoKnownAs: unsigned.alsoKnownAs,
      services: unsigned.services,
    },
  };
}
