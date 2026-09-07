#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { inspectSignedPayload } from "./cose.js";
import {
  toDiagnosticJson,
} from "./diagnostic.js";
import { HailCodecError } from "./errors.js";
import { isSignedPayloadType } from "./profiles.js";

function usage(): never {
  console.error(`Usage:
  hail-codec inspect <signed-type> <file> [--show-secrets]`);
  process.exit(2);
}

async function main(): Promise<void> {
  const [command, type, input, outputOrFlag] = process.argv.slice(2);
  if (command === "inspect") {
    if (!isSignedPayloadType(type) || input === undefined) usage();
    const bytes = new Uint8Array(await readFile(input));
    const inspected = inspectSignedPayload(type, bytes);
    const diagnostic = {
      type: inspected.type,
      keyId: inspected.keyId,
      payload: toDiagnosticJson(
        type,
        inspected.payload,
        outputOrFlag !== "--show-secrets",
      ),
    };
    process.stdout.write(`${JSON.stringify(diagnostic, null, 2)}\n`);
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
