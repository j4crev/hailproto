import type { DeliveryRepository, DeliveryClaim } from "./repository.js";
import { deliveryDeadline } from "./repository.js";
import type { BodyRetriever, RetrievalResult } from "./retriever.js";

export class DeliveryWorker {
  constructor(
    private readonly store: Pick<DeliveryRepository, "claimDue" | "deliver" | "fail" | "hold">,
    private readonly retriever: Pick<BodyRetriever, "retrieve">,
    private readonly now: () => Date = () => new Date(),
    private readonly random: () => number = Math.random,
  ) {}

  async processOne(): Promise<"idle" | "delivered" | "failed" | "on-hold"> {
    const claim = await this.store.claimDue(60);
    if (!claim) return "idle";
    const deadline = deliveryDeadline(claim.envelope);
    if (this.now().getTime() / 1000 > deadline) {
      await this.store.fail(claim, "delivery-expired");
      return "failed";
    }
    let result: RetrievalResult;
    try { result = await this.retriever.retrieve(claim.envelope); }
    catch { result = { kind: "retry", reason: "receiver-resource-constrained", retryAfter: null }; }
    if (result.kind === "success") {
      try {
        const outcome = await this.store.deliver(claim, result.bytes);
        return outcome === "delivered" ? "delivered" : "failed";
      } catch {
        result = { kind: "retry", reason: "receiver-resource-constrained", retryAfter: null };
      }
    }
    if (result.kind === "fail") {
      await this.store.fail(claim, result.reason);
      return "failed";
    }
    const next = this.nextAttempt(claim, result.retryAfter);
    await this.store.hold(claim, result.reason, next);
    return "on-hold";
  }

  private nextAttempt(claim: DeliveryClaim, retryAfter: Date | null): Date {
    const now = this.now().getTime();
    const base = Math.min(3_600_000, 10_000 * 2 ** Math.min(claim.attemptCount - 1, 9));
    const local = now + Math.round(base * (0.75 + this.random() * 0.5));
    const deadline = deliveryDeadline(claim.envelope) * 1000;
    return new Date(Math.min(deadline + 1_000, Math.max(local, retryAfter?.getTime() ?? 0)));
  }
}
