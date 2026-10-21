export interface ProtectedScheduleSettings {
  minimumResponseMs: number;
  processingDeadlineMs: number;
  maxInFlight: number;
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

  constructor(private readonly settings: ProtectedScheduleSettings = POC_PROTECTED_SCHEDULE) {
    if (!Number.isSafeInteger(settings.minimumResponseMs) || settings.minimumResponseMs < 1 ||
      !Number.isSafeInteger(settings.processingDeadlineMs) ||
      settings.processingDeadlineMs <= settings.minimumResponseMs ||
      !Number.isSafeInteger(settings.maxInFlight) || settings.maxInFlight < 1) {
      throw new Error("Invalid protected response schedule settings");
    }
  }

  get inFlight(): number { return this.#inFlight; }

  async run<T>(process: (signal: AbortSignal) => Promise<T | null>): Promise<ProtectedResult<T>> {
    // This provider-wide gate is independent of claimed and authenticated relationship state.
    if (this.#inFlight >= this.settings.maxInFlight) return { kind: "busy" };
    this.#inFlight += 1;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error("Protected processing deadline exceeded")),
      this.settings.processingDeadlineMs);
    const floor = new Promise<{ kind: "generic" }>((resolve) => {
      setTimeout(() => resolve({ kind: "generic" }), this.settings.minimumResponseMs);
    });
    const processing = Promise.resolve()
      .then(() => process(controller.signal))
      .then((value): ProtectedResult<T> => value === null ? { kind: "generic" } : { kind: "detailed", value })
      .catch((): ProtectedResult<T> => ({ kind: "generic" }))
      .finally(() => {
        clearTimeout(deadline);
        this.#inFlight -= 1;
      });
    const first = await Promise.race([processing, floor]);
    await floor;
    return first;
  }
}
