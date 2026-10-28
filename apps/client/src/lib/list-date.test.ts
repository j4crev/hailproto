import {describe, expect, it} from "vitest";
import {listDate} from "./list-date.js";

describe("list dates", () => {
  const now = new Date(2026, 9, 28, 12);
  it("uses calendar days and readable older dates", () => {
    expect(listDate(new Date(2026, 9, 28, 0), now)).toBe("Today");
    expect(listDate(new Date(2026, 9, 27, 23), now)).toBe("Yesterday");
    expect(listDate(new Date(2026, 9, 25), now)).toBe("Sunday");
    expect(listDate(new Date(2026, 9, 22), now)).toBe("Thursday");
    expect(listDate(new Date(2026, 9, 21), now)).toBe("Oct 21");
    expect(listDate(new Date(2026, 9, 2), now)).toBe("Oct 2");
    expect(listDate(new Date(2025, 11, 5), now)).toBe("Dec 5, 2025");
    expect(listDate(new Date(2026, 10, 1), now)).toBe("Nov 1");
  });
  it("handles year boundaries and daylight-saving calendar days", () => {
    expect(listDate(new Date(2025, 11, 31, 23), new Date(2026, 0, 1))).toBe("Yesterday");
    expect(listDate(new Date(2026, 2, 8, 0), new Date(2026, 2, 9, 23))).toBe("Yesterday");
    expect(listDate("invalid", now)).toBe("Unknown date");
  });
});
