import { describe, expect, it } from "vitest";

import {
  decodeDeterministic,
  encodeDeterministic,
  HailCodecError,
} from "../src/index.js";

function hex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
}

describe("deterministic Hail CBOR", () => {
  it("uses RFC 8949 bytewise map ordering", () => {
    expect(Buffer.from(encodeDeterministic({ b: 1, a: 2 })).toString("hex")).toBe(
      "a2616102616201",
    );
  });

  it("round trips text-keyed maps and byte strings", () => {
    const encoded = encodeDeterministic({ bytes: new Uint8Array([1, 2, 3]), value: 4 });
    expect(decodeDeterministic(encoded)).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      value: 4,
    });
  });

  it.each([
    ["non-shortest integer", "1801"],
    ["indefinite array", "9f01ff"],
    ["undefined", "f7"],
    ["float", "f93c00"],
    ["non-text map key", "a1016161"],
    ["trailing data", "0102"],
    ["duplicate map key", "a2616101616102"],
    ["non-deterministic map order", "a2616201616102"],
  ])("rejects %s", (_name, bytes) => {
    expect(() => decodeDeterministic(hex(bytes))).toThrow(HailCodecError);
  });

  it.each([
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -0,
    9_007_199_254_740_992,
    undefined,
    new Date(),
    { value: 1n },
  ])("rejects unsupported input %#", (value) => {
    expect(() => encodeDeterministic(value)).toThrow(HailCodecError);
  });

  it("rejects sparse arrays and symbol properties", () => {
    expect(() => encodeDeterministic(new Array(1))).toThrow(/sparse arrays/);
    expect(() => encodeDeterministic({ value: 1, [Symbol("hidden")]: 2 })).toThrow(
      /symbol map keys/,
    );
  });

  it("rejects native maps and malformed Unicode input", () => {
    expect(() => encodeDeterministic(new Map([["value", 1]]))).toThrow(/native Map/);
    expect(() => encodeDeterministic("\ud800")).toThrow(/unpaired surrogate/);
  });

  it("enforces configured limits on map keys", () => {
    expect(() =>
      encodeDeterministic(
        { tooLong: true },
        {
          maximumBytes: 100,
          maximumDepth: 4,
          maximumItems: 10,
          maximumArrayLength: 10,
          maximumMapEntries: 10,
          maximumTextBytes: 3,
          maximumByteStringLength: 10,
        },
      ),
    ).toThrow(/map key/);
  });

  it("rejects excessive nesting before decoding", () => {
    const deeplyNested = new Uint8Array([...new Uint8Array(33).fill(0x81), 0x00]);
    expect(() => decodeDeterministic(deeplyNested)).toThrow(/nesting depth/);
  });
});
