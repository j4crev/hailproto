#!/usr/bin/env node

import { open } from "node:fs/promises";

import { DEFAULT_HAIL_RESOURCE_LIMITS } from "./cbor.js";
import { inspectSignedPayload } from "./cose.js";
import { toDiagnosticNotation } from "./diagnostic-notation.js";
import { toDiagnosticJson } from "./diagnostic.js";
import { HailCodecError } from "./errors.js";
import { decodePayload } from "./payload.js";
import { isSignedPayloadType, SIGNED_PROFILES } from "./profiles.js";
import type { HailPayloadType } from "./types.js";

const PAYLOAD_TYPES = new Set<HailPayloadType>([
  "hail.address-binding",
  "hail.sender-profile",
  "hail.grant",
  "hail.envelope",
  "hail.delivery-status",
  "hail.body.spt-1",
]);

function isPayloadType(value: unknown): value is HailPayloadType {
  return typeof value === "string" && PAYLOAD_TYPES.has(value as HailPayloadType);
}

function showSecrets(flag: string | undefined): boolean {
  if (flag !== undefined && flag !== "--show-secrets") usage();
  return flag === "--show-secrets";
}

async function readBoundedFile(path: string, maximumBytes: number): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes) {
      throw new HailCodecError("resource-limit", "input file is too large");
    }
    return buffer.slice(0, offset);
  } finally {
    await handle.close();
  }
}

function usage(): never {
  console.error(`Usage:
  hail-codec inspect <signed-type> <file> [--show-secrets]
  hail-codec diagnose <payload-type> <file> [--show-secrets]`);
  process.exit(2);
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length < 3 || arguments_.length > 4) usage();
  const [command, type, input, outputOrFlag] = arguments_;
  if (command === "inspect") {
    if (!isSignedPayloadType(type) || input === undefined) usage();
    const revealSecrets = showSecrets(outputOrFlag);
    const bytes = await readBoundedFile(
      input,
      SIGNED_PROFILES[type].maximumRepresentationBytes ??
        DEFAULT_HAIL_RESOURCE_LIMITS.maximumBytes,
    );
    const inspected = inspectSignedPayload(type, bytes);
    const diagnostic = {
      type: inspected.type,
      keyId: inspected.keyId,
      payload: toDiagnosticJson(
        type,
        inspected.payload,
        !revealSecrets,
      ),
    };
    process.stdout.write(`${JSON.stringify(diagnostic, null, 2)}\n`);
    return;
  }

  if (command === "diagnose") {
    if (!isPayloadType(type) || input === undefined) usage();
    const revealSecrets = showSecrets(outputOrFlag);
    const maximumBytes = isSignedPayloadType(type)
      ? SIGNED_PROFILES[type].maximumRepresentationBytes ??
        DEFAULT_HAIL_RESOURCE_LIMITS.maximumBytes
      : DEFAULT_HAIL_RESOURCE_LIMITS.maximumBytes;
    const bytes = await readBoundedFile(input, maximumBytes);
    const payload = decodePayload(type, bytes);
    process.stdout.write(`${toDiagnosticNotation(payload, !revealSecrets)}\n`);
    return;
  }

  usage();
}

main().catch((error: unknown) => {
  if (error instanceof HailCodecError) {
    console.error(`${error.code}: ${error.message}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
