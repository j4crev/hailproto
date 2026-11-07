import { describe, expect, it, vi } from "vitest";
import { ProtectedResponseSchedule } from "../src/http/protected-schedule.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("protected response schedule", () => {
  it("returns generic and authenticated detail on one monotonic minimum schedule", async () => {
    const schedule = new ProtectedResponseSchedule({ minimumResponseMs: 18,
      processingDeadlineMs: 120, maxInFlight: 64 });
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
    await wait(125);
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

  it("makes burst admission identical for fast rejection and slow resolution", async () => {
    vi.useFakeTimers();
    try {
      const fast = new ProtectedResponseSchedule({minimumResponseMs:10,processingDeadlineMs:100,maxInFlight:2});
      const slow = new ProtectedResponseSchedule({minimumResponseMs:10,processingDeadlineMs:100,maxInFlight:2});
      const replies = [fast.run(async()=>null),fast.run(async()=>null),
        slow.run(async()=>{await wait(80);return null;}),slow.run(async()=>{await wait(80);return null;})];
      await vi.advanceTimersByTimeAsync(10);
      expect(await Promise.all(replies)).toEqual(Array(4).fill({kind:'generic'}));
      expect(await fast.run(async()=>null)).toEqual({kind:'busy'});
      expect(await slow.run(async()=>null)).toEqual({kind:'busy'});
      await vi.advanceTimersByTimeAsync(90);
      expect(fast.inFlight).toBe(0);expect(slow.inFlight).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not expose stuck work through busy responses or exceed the private work cap", async () => {
    vi.useFakeTimers();
    try {
      const schedule=new ProtectedResponseSchedule({minimumResponseMs:10,processingDeadlineMs:100,maxInFlight:1});
      let release!:()=>void;
      const held=new Promise<void>(resolve=>{release=resolve;});
      const first=schedule.run(async()=>{await held;return null;});
      await vi.advanceTimersByTimeAsync(100);expect(await first).toEqual({kind:'generic'});
      const process=vi.fn(async()=>null), second=schedule.run(process);
      await vi.advanceTimersByTimeAsync(10);
      expect(await second).toEqual({kind:'generic'});expect(process).not.toHaveBeenCalled();
      release();await vi.advanceTimersByTimeAsync(100);
    } finally { vi.useRealTimers(); }
  });

  it("reserves capacity for other network sources", async()=>{
    vi.useFakeTimers();
    try {
      const schedule=new ProtectedResponseSchedule({minimumResponseMs:10,processingDeadlineMs:100,maxInFlight:32});
      const first=Array.from({length:8},()=>schedule.run(async()=>null,false,'source-a'));
      expect(await schedule.run(async()=>null,false,'source-a')).toEqual({kind:'busy'});
      const other=schedule.run(async()=>null,false,'source-b');
      await vi.advanceTimersByTimeAsync(10);
      expect(await other).toEqual({kind:'generic'});
      expect(await Promise.all(first)).toEqual(Array(8).fill({kind:'generic'}));
      await vi.advanceTimersByTimeAsync(100);
    } finally { vi.useRealTimers(); }
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
