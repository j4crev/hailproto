import { describe, expect, it } from "vitest";
import { parseJsonWithoutDuplicateKeys } from "../src/discovery/strict-json.js";

describe("parseJsonWithoutDuplicateKeys", () => {
  it("parses nested JSON", () => {
    expect(parseJsonWithoutDuplicateKeys('{"subject":"acct:a@example.com","links":[{"rel":"x"}]}')).toEqual({
      subject: "acct:a@example.com",
      links: [{ rel: "x" }],
    });
  });

  it("rejects duplicate members at any depth", () => {
    expect(() => parseJsonWithoutDuplicateKeys('{"subject":"a","subject":"b"}')).toThrow(
      "Duplicate JSON member: subject",
    );
    expect(() => parseJsonWithoutDuplicateKeys('{"links":[{"rel":"a","rel":"b"}]}')).toThrow(
      "Duplicate JSON member: rel",
    );
  });

  it("rejects trailing content and excessive nesting", () => {
    expect(() => parseJsonWithoutDuplicateKeys("{} true")).toThrow();
    expect(() => parseJsonWithoutDuplicateKeys(`${"[".repeat(34)}0${"]".repeat(34)}`)).toThrow(
      "JSON nesting is too deep",
    );
  });

  it("preserves __proto__ as an own JSON member", () => {
    const result = parseJsonWithoutDuplicateKeys('{"__proto__":{"subject":"inherited"}}');
    expect(Object.hasOwn(result as object, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it("rejects whitespace that JSON does not permit", () => {
    expect(() => parseJsonWithoutDuplicateKeys("{\u00a0}")).toThrow();
  });
});
