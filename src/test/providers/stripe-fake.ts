import { createReplayWriter } from "./replay-write";

/** Narrow Stripe test double. Amounts use Stripe's integer minor units. */
type Intent = { id: string; memberId: string; amount: number; amount_received: number; status: "requires_capture" | "succeeded" | "canceled" };
type Refund = { id: string; charge: string; payment_intent: string; amount: number; status: "pending" | "succeeded" | "failed"; origin: "api" | "dashboard" };
type Charge = { id: string; payment_intent: string; amount: number; amount_refunded: number; refunded: boolean; refunds: { data: Refund[]; has_more: false } };
type Event = { id: string; type: "payment_intent.succeeded" | "refund.updated" | "refund.created" | "refund.failed" | "charge.refunded"; data: { object: Intent | Refund | Charge } };

export class StripeFakeError extends Error {
  readonly type = "StripeInvalidRequestError";
  constructor(readonly code: string, message: string) { super(message); }
}

export class StripeFake {
  private intents = new Map<string, Intent>();
  private refunds = new Map<string, Refund>();
  private events: Event[] = [];
  private readonly write = createReplayWriter(() => new StripeFakeError("idempotency_error", "Parameters differ from the original request"));

  private cents(amount: number) {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new StripeFakeError("parameter_invalid_integer", "Amount must be positive integer cents");
  }

  private intent(id: string) {
    const intent = this.intents.get(id);
    if (!intent) throw new StripeFakeError("resource_missing", "No such payment_intent");
    return intent;
  }

  createIntent(key: string, memberId: string, amount: number) {
    return this.write(key, ["intent", memberId, amount], () => {
      this.cents(amount);
      const intent: Intent = { id: `intent-${this.intents.size + 1}`, memberId, amount, amount_received: 0, status: "requires_capture" };
      this.intents.set(intent.id, intent);
      return intent;
    });
  }

  private emit(type: Event["type"], object: Intent | Refund | Charge) {
    this.events.push({ id: `event-${this.events.length + 1}`, type, data: { object: structuredClone(object) } });
  }

  capture(key: string, id: string, amount: number) {
    return this.write(key, ["capture", id, amount], () => {
      this.cents(amount);
      const intent = this.intent(id);
      if (intent.status !== "requires_capture") throw new StripeFakeError("payment_intent_unexpected_state", "PaymentIntent is not capturable");
      if (amount > intent.amount) throw new StripeFakeError("amount_too_large", "Capture exceeds authorised amount");
      intent.amount_received = amount;
      intent.status = "succeeded";
      this.emit("payment_intent.succeeded", intent);
      return intent;
    });
  }

  cancel(id: string) {
    const intent = this.intent(id);
    if (intent.status !== "requires_capture") throw new StripeFakeError("payment_intent_unexpected_state", "PaymentIntent cannot be canceled");
    intent.status = "canceled";
  }

  /** Charge payload subset consumed by the application's refund webhook. */
  private refundedCharge(intent: Intent): Charge {
    const refunds = [...this.refunds.values()].filter(r => r.payment_intent === intent.id);
    const amount = refunds.filter(r => r.status !== "failed").reduce((n, r) => n + r.amount, 0);
    return { id: `charge-${intent.id}`, payment_intent: intent.id, amount: intent.amount_received,
      amount_refunded: amount, refunded: amount === intent.amount_received,
      refunds: { data: refunds, has_more: false } };
  }

  private createRefund(id: string, amount: number, status: Refund["status"], origin: Refund["origin"]) {
    this.cents(amount);
    const intent = this.intent(id);
    if (intent.status !== "succeeded") throw new StripeFakeError("payment_intent_unexpected_state", "PaymentIntent has not been captured");
    const reserved = [...this.refunds.values()].filter(r => r.payment_intent === id && r.status !== "failed").reduce((n, r) => n + r.amount, 0);
    if (amount > intent.amount_received - reserved) throw new StripeFakeError(reserved === intent.amount_received ? "charge_already_refunded" : "amount_too_large", "Refund exceeds unrefunded capture");
    const refund: Refund = { id: `refund-${this.refunds.size + 1}`, charge: `charge-${id}`, payment_intent: id, amount, status, origin };
    this.refunds.set(refund.id, refund);
    this.emit("refund.created", refund);
    this.emit("charge.refunded", this.refundedCharge(intent));
    return refund;
  }

  refund(key: string, id: string, amount: number, status: "pending" | "succeeded" = "succeeded") {
    return this.write(key, ["refund", id, amount, status], () => this.createRefund(id, amount, status, "api"));
  }

  dashboardRefund(id: string, amount: number) {
    return structuredClone(this.createRefund(id, amount, "succeeded", "dashboard"));
  }

  /** Stripe can fail an apparently successful refund asynchronously. */
  failRefund(id: string) {
    const refund = this.refunds.get(id);
    if (!refund) throw new StripeFakeError("resource_missing", "No such refund");
    if (refund.status === "failed") return;
    refund.status = "failed";
    this.emit("refund.updated", refund);
    this.emit("refund.failed", refund);
  }

  succeedRefund(id: string) {
    const refund = this.refunds.get(id);
    if (!refund) throw new StripeFakeError("resource_missing", "No such refund");
    if (refund.status !== "pending") throw new StripeFakeError("refund_unexpected_state", "Refund is not pending");
    refund.status = "succeeded";
    this.emit("refund.updated", refund);
  }

  snapshot() {
    return structuredClone({ intents: [...this.intents.values()], refunds: [...this.refunds.values()], events: this.events });
  }
}
