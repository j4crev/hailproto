import { describe, expect, it } from "vitest";

import {
  encodeBase64Url,
  fromDiagnosticJson,
  toDiagnosticJson,
} from "../src/index.js";
import { envelope } from "./fixtures.js";

describe("diagnostic JSON", () => {
  it("round trips schema-known byte fields", () => {
    const diagnostic = toDiagnosticJson("hail.envelope", envelope, false);
    expect(fromDiagnosticJson("hail.envelope", diagnostic)).toEqual(envelope);
  });

  it("redacts bearer tokens by default", () => {
    const diagnostic = toDiagnosticJson("hail.envelope", envelope) as Record<
      string,
      unknown
    >;
    const body = diagnostic.body as Record<string, unknown>;
    const access = body.access as Record<string, unknown>;
    expect(access.token).toBe("[REDACTED]");
  });

  it("uses unpadded base64url", () => {
    expect(encodeBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
  });

  it("rejects values outside the Hail data model before conversion", () => {
    const invalid = { ...envelope, reply_to: undefined } as unknown;
    expect(() =>
      fromDiagnosticJson("hail.envelope", invalid as never),
    ).toThrow(/\$\.reply_to: unsupported Hail value/);

    let deeplyNested: unknown = null;
    for (let depth = 0; depth < 33; depth += 1) deeplyNested = [deeplyNested];
    expect(() =>
      fromDiagnosticJson("hail.envelope", deeplyNested as never),
    ).toThrow(/nesting depth/);
  });
});
