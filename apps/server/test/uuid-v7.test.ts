import { describe, expect, it } from "vitest";
import { uuidV7 } from "../src/identity/uuid-v7.js";

describe("uuidV7", () => {
  it("creates a canonical UUIDv7 carrying the supplied millisecond timestamp", () => {
    const timestamp = 1_790_467_200_123;
    const value = uuidV7(timestamp);

    expect(value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(Number.parseInt(value.replaceAll("-", "").slice(0, 12), 16)).toBe(timestamp);
  });

  it("rejects timestamps outside the UUIDv7 48-bit range", () => {
    expect(() => uuidV7(-1)).toThrow();
    expect(() => uuidV7(0x1_0000_0000_0000)).toThrow();
  });
});
