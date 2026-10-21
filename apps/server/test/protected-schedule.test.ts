import { describe, expect, it } from "vitest";
import { ProtectedResponseSchedule } from "../src/http/protected-schedule.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("protected response schedule", () => {
  it("returns generic and authenticated detail on one monotonic minimum schedule", async () => {
    const schedule = new ProtectedResponseSchedule({ minimumResponseMs: 18,
      processingDeadlineMs: 120, maxInFlight: 4 });
    const generic: number[] = [];
    const detailed: number[] = [];
    for (let sample = 0; sample < 12; sample += 1) {
      for (const [path, readings, expected] of [
        [async () => null, generic, "generic"],
        [async () => "signed-status", detailed, "detailed"],
      ] as const) {
        const started = performance.now();
        const result = await schedule.run(path);
        readings.push(performance.now() - started);
        expect(result.kind).toBe(expected);
      }
    }
    // Scheduling jitter can delay any sample, but neither path may return early.
    expect([...generic, ...detailed].every((ms) => ms >= 16)).toBe(true);
    expect(generic).toHaveLength(12);
    expect(detailed).toHaveLength(12);
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[5]!;
    expect(Math.abs(median(generic) - median(detailed))).toBeLessThan(18);
    expect(schedule.inFlight).toBe(0);
  });

  it("returns the same generic result when PLC-dependent processing misses its response window", async () => {
    const schedule = new ProtectedResponseSchedule({ minimumResponseMs: 12,
      processingDeadlineMs: 35, maxInFlight: 1 });
    let mutations = 0;
    const started = performance.now();
    const response = await schedule.run(async (signal) => {
      await wait(50); // simulated uncancellable PLC client request
      signal.throwIfAborted();
      mutations += 1;
      return "should-not-leak";
    });
    expect(response).toEqual({ kind: "generic" });
    expect(performance.now() - started).toBeGreaterThanOrEqual(10);
    expect(schedule.inFlight).toBe(1);
    expect(await schedule.run(async () => "unexpected")).toEqual({ kind: "busy" });
    await wait(60);
    expect(mutations).toBe(0);
    expect(schedule.inFlight).toBe(0);
    expect(await schedule.run(async () => "recovered")).toEqual({ kind: "detailed", value: "recovered" });
  });

  it("rejects settings that cannot impose a response bound and processing deadline", () => {
    expect(() => new ProtectedResponseSchedule({ minimumResponseMs: 0,
      processingDeadlineMs: 10, maxInFlight: 1 })).toThrow();
    expect(() => new ProtectedResponseSchedule({ minimumResponseMs: 20,
      processingDeadlineMs: 10, maxInFlight: 1 })).toThrow();
    expect(() => new ProtectedResponseSchedule({ minimumResponseMs: 20,
      processingDeadlineMs: 30, maxInFlight: 0 })).toThrow();
  });
});
