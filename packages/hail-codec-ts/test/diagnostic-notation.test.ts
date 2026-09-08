import { describe, expect, it } from "vitest";

import { toDiagnosticNotation } from "../src/index.js";
import { envelope } from "./fixtures.js";

describe("CBOR diagnostic notation", () => {
  it("uses deterministic map order and hexadecimal byte strings", () => {
    expect(
      toDiagnosticNotation({ longer: true, b: new Uint8Array([0x00, 0xab]), a: 1 }),
    ).toBe(`{
  "a": 1,
  "b": h'00ab',
  "longer": true
}`);
  });

  it("formats nested Hail values", () => {
    expect(toDiagnosticNotation({ values: [1, null, "hail"] })).toBe(`{
  "values": [
    1,
    null,
    "hail"
  ]
}`);
  });

  it("escapes terminal control and bidirectional formatting characters", () => {
    const notation = toDiagnosticNotation({
      text: "safe\u001b[31m\u202eevil\u202c",
    });
    expect(notation).toContain("safe\\u001b[31m\\u202eevil\\u202c");
    expect(notation).not.toContain("\u001b");
    expect(notation).not.toContain("\u202e");
  });

  it("redacts bearer tokens unless explicitly requested", () => {
    expect(toDiagnosticNotation(envelope)).toContain('"token": "[REDACTED]"');
    expect(toDiagnosticNotation(envelope, false)).toContain(
      `"token": h'${"02".repeat(32)}'`,
    );
  });
});
