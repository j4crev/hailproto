import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeDeterministic, encodeDeterministic, DEFAULT_HAIL_RESOURCE_LIMITS, type HailResourceLimits } from "../src/cbor.js";
import { assertCborResourceLimits } from "../src/scan.js";

const fixture = JSON.parse(readFileSync(new URL("../../../spec/vectors/cbor-resource-limits.json", import.meta.url), "utf8")) as {
  vectors: { id: string; segments: { hex: string; repeat: number }[]; length: number; sha256: string;
    accepted: boolean; limits?: Partial<HailResourceLimits> }[];
};

describe("published CBOR resource budgets", () => {
  for (const vector of fixture.vectors) it(vector.id, () => {
    const bytes = Buffer.concat(vector.segments.map(part => Buffer.from(part.hex.repeat(part.repeat), "hex")));
    expect(bytes.length).toBe(vector.length);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(vector.sha256);
    const limits = { ...DEFAULT_HAIL_RESOURCE_LIMITS, ...vector.limits };
    if (vector.accepted) {
      expect(() => assertCborResourceLimits(bytes, limits)).not.toThrow();
      expect(Buffer.from(encodeDeterministic(decodeDeterministic(bytes, limits), limits)).equals(bytes)).toBe(true);
    } else {
      expect(() => assertCborResourceLimits(bytes, limits)).toThrow();
      expect(() => decodeDeterministic(bytes, limits)).toThrow(/resource|too (many|large)|maximum|exceed/i);
    }
  });
});
