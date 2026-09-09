import {
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";
import { readFileSync } from "node:fs";

import { Bench } from "tinybench";

import {
  decodeDeterministic,
  decodePayload,
  encodeDeterministic,
  encodePayload,
  inspectSignedPayload,
  signPayload,
  verifySignedPayload,
  type HailSigner,
  type HailVerifier,
} from "../src/index.js";

interface PayloadVector {
  readonly id: string;
  readonly payload_hex: string;
}

interface VectorManifest {
  readonly positive: readonly PayloadVector[];
}

const manifest = JSON.parse(
  readFileSync(new URL("../vectors/v0.json", import.meta.url), "utf8"),
) as VectorManifest;

function vectorBytes(id: string): Uint8Array {
  const vector = manifest.positive.find((entry) => entry.id === id);
  if (vector === undefined) throw new Error(`missing benchmark vector ${id}`);
  return new Uint8Array(Buffer.from(vector.payload_hex, "hex"));
}

const payloadBytes = vectorBytes("envelope-basic");
const bodyBytes = vectorBytes("body-spt-1-basic");
const envelope = decodePayload("hail.envelope", payloadBytes);
const body = decodePayload("hail.body.spt-1", bodyBytes);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keyId = `${envelope.from}#hail-messaging`;
const signer: HailSigner = {
  keyId,
  async sign(data) {
    return nodeSign(null, data, privateKey);
  },
};
const verifier: HailVerifier = {
  async verify(data, signature, candidateKeyId) {
    return candidateKeyId === keyId && nodeVerify(null, data, publicKey, signature);
  },
};
const signedEnvelope = await signPayload("hail.envelope", envelope, signer);
const genericEnvelope = decodeDeterministic(payloadBytes);
const benchmark = new Bench({ time: 500, warmup: true });
let resultSink: unknown;

benchmark
  .add("payload / encode envelope", () => {
    resultSink = encodePayload("hail.envelope", envelope);
  })
  .add("payload / decode envelope", () => {
    resultSink = decodePayload("hail.envelope", payloadBytes);
  })
  .add("payload / encode spt-1 body", () => {
    resultSink = encodePayload("hail.body.spt-1", body);
  })
  .add("payload / decode spt-1 body", () => {
    resultSink = decodePayload("hail.body.spt-1", bodyBytes);
  })
  .add("CBOR / encode generic envelope", () => {
    resultSink = encodeDeterministic(genericEnvelope);
  })
  .add("CBOR / decode generic envelope", () => {
    resultSink = decodeDeterministic(payloadBytes);
  })
  .add("COSE / inspect envelope", () => {
    resultSink = inspectSignedPayload("hail.envelope", signedEnvelope);
  })
  .add("COSE / sign envelope", async () => {
    resultSink = await signPayload("hail.envelope", envelope, signer);
  })
  .add("COSE / verify envelope", async () => {
    resultSink = await verifySignedPayload("hail.envelope", signedEnvelope, verifier);
  });

await benchmark.run();
if (resultSink === undefined) throw new Error("benchmark produced no result");
console.table(benchmark.table());
