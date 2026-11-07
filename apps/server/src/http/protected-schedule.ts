export interface ProtectedScheduleSettings {
  minimumResponseMs: number;
  processingDeadlineMs: number;
  maxInFlight: number;
  maxPerSource?: number;
}

// Provisional POC values pending complete-path measurement on supported hosts.
export const POC_PROTECTED_SCHEDULE: ProtectedScheduleSettings = {
  minimumResponseMs: 750,
  processingDeadlineMs: 10_000,
  maxInFlight: 32,
};

export type ProtectedResult<T> =
  | { kind: "detailed"; value: T }
  | { kind: "generic" }
  | { kind: "busy" };

export class ProtectedResponseSchedule {
  #inFlight = 0;
  #processing = 0;
  readonly #sources = new Map<string, number>();

  constructor(private readonly settings: ProtectedScheduleSettings = POC_PROTECTED_SCHEDULE) {
    if (!Number.isSafeInteger(settings.minimumResponseMs) || settings.minimumResponseMs < 1 ||
      !Number.isSafeInteger(settings.processingDeadlineMs) ||
      settings.processingDeadlineMs <= settings.minimumResponseMs ||
      settings.maxPerSource !== undefined && (!Number.isSafeInteger(settings.maxPerSource) || settings.maxPerSource < 1) ||
      !Number.isSafeInteger(settings.maxInFlight) || settings.maxInFlight < 1) {
      throw new Error("Invalid protected response schedule settings");
    }
  }

  get inFlight(): number { return this.#inFlight; }
  get processingInFlight(): number { return this.#processing; }

  async run<T>(process: (signal: AbortSignal) => Promise<T | null>, waitForCompletion = false, source = "unidentified"): Promise<ProtectedResult<T>> {
    // Admission occupancy depends ONLY on arrival time, never on lookup results.
    // Keep a separate private work gate for operations that ignore cancellation.
    const sourceCount = this.#sources.get(source) ?? 0;
    if (this.#inFlight >= this.settings.maxInFlight ||
      sourceCount >= (this.settings.maxPerSource ?? Math.min(8, this.settings.maxInFlight))) return { kind: "busy" };
    this.#sources.set(source, sourceCount + 1);
    this.#inFlight += 1;
    const controller = new AbortController();
    let expire!: (result: {kind:"generic"}) => void;
    const expired = new Promise<{kind:"generic"}>(resolve => { expire = resolve; });
    const deadline = setTimeout(() => {
      this.#inFlight -= 1;
      const remaining = this.#sources.get(source)! - 1;
      if (remaining) this.#sources.set(source, remaining); else this.#sources.delete(source);
      expire({kind:"generic"});
      controller.abort(new Error("Protected processing deadline exceeded"));
    }, this.settings.processingDeadlineMs);
    deadline.unref?.();
    const floor = new Promise<{ kind: "generic" }>((resolve) => {
      setTimeout(() => resolve({ kind: "generic" }), this.settings.minimumResponseMs);
    });
    if (this.#processing >= this.settings.maxInFlight) return floor;
    this.#processing += 1;
    const processing = Promise.resolve()
      .then(() => process(controller.signal))
      .then((value): ProtectedResult<T> => value === null ? { kind: "generic" } : { kind: "detailed", value })
      .catch((): ProtectedResult<T> => ({ kind: "generic" }))
      .finally(() => { this.#processing -= 1; });
    const first = await Promise.race([processing, waitForCompletion ? expired : floor]);
    await floor;
    return first;
  }
}
