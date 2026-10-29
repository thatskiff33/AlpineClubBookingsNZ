import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

const { list, record, updateMany } = vi.hoisted(() => ({ list: vi.fn(), record: vi.fn(), updateMany: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { paymentRecoveryOperation: { updateMany } } }));
vi.mock("@/lib/xero-error-alert", () => ({ notifyXeroSyncError: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/recorded-card-refund-notes", () => ({ queueRecordedCardRefundNotes: vi.fn().mockResolvedValue({ queueOperationId: null }) }));
vi.mock("@/lib/stripe", () => ({ listRefundsForPaymentIntent: list }));
vi.mock("@/lib/payment-transactions", () => ({ recordStripeRefundsAgainstTransaction: record }));
import { refundSliceStripeIdempotencyKey } from "@/lib/payment-recovery-keys";
import { REFUND_SLICE_KEY_METADATA } from "@/lib/refund-slice-evidence";
import { queueRecordedCardRefundNotes } from "@/lib/recorded-card-refund-notes";
import { checkCardRefundResend, UnattributedCardRefundBeforeResendError } from "@/lib/card-refund-resend-preflight";

const arose = new Date("2026-06-30T12:00:00.750Z");
const args = {
  operation: { id: "operation-test", paymentId: "payment-test", bookingId: "booking-test", createdAt: arose, processingStartedAt: new Date("2026-07-01T00:00:00.000Z"), allocationPlan: [{ paymentTransactionId: "transaction-test", amountCents: 4000 }] },
  stripeKeyPrefix: "refund_test",
  plan: [{ paymentTransactionId: "transaction-test", amountCents: 4000 }],
  transactions: [{ id: "transaction-test", stripePaymentIntentId: "pi_test" }],
};
function refund(overrides: Record<string, unknown> = {}): Stripe.Refund {
  return { id: "re_test", amount: 4000, currency: "nzd", status: "succeeded", charge: "ch_test", payment_intent: "pi_test", created: Math.floor(arose.getTime() / 1000), metadata: {}, ...overrides } as Stripe.Refund;
}
beforeEach(() => {
  updateMany.mockReset().mockResolvedValue({ count: 1 });
  list.mockReset().mockResolvedValue([]);
  record.mockReset().mockResolvedValue({ readAsRefused: [], appliedCents: 4000, newlyCountedRefundIds: ["re_test"], payment: { id: "payment-test", source: "STRIPE" } });
  vi.mocked(queueRecordedCardRefundNotes).mockReset().mockResolvedValue({ queueOperationId: null });
});

describe("card refund preflight", () => {
  it.each(["succeeded", "pending", "requires_action", null])("records a dashboard refund (%s) and holds even a partial amount at the boundary", async (status) => {
    const dashboard = refund({ status, amount: 1000 });
    list.mockResolvedValue([dashboard]);
    await expect(checkCardRefundResend(args)).rejects.toBeInstanceOf(UnattributedCardRefundBeforeResendError);
    expect(list).toHaveBeenCalledExactlyOnceWith("pi_test", { timeoutMs: 10_000, singlePage: true });
    expect(record).toHaveBeenCalledExactlyOnceWith({
      paymentId: "payment-test", paymentTransactionId: "transaction-test", refunds: [dashboard],
      fallbackPaymentIntentId: "pi_test",
    });
  });

  it.each([
    ["older dashboard refund", { created: Math.floor(arose.getTime() / 1000) - 1 }],
    ["app refund", { metadata: { bookingId: "booking-test", reason: "date_change_price_decrease" } }],
    ["failed refund", { status: "failed" }],
    ["canceled refund", { status: "canceled" }],
  ])("records but does not hold an %s", async (_name, overrides) => {
    list.mockResolvedValue([refund(overrides)]);
    await expect(checkCardRefundResend(args)).resolves.toEqual(args.plan);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("ignores unrelated Stripe tags as evidence of an app refund", async () => {
    list.mockResolvedValue([refund({ metadata: { comment: "manual refund" } })]);
    await expect(checkCardRefundResend(args)).rejects.toBeInstanceOf(UnattributedCardRefundBeforeResendError);
  });

  it("does not revive a failure from a stale counted provider response", async () => {
    list.mockResolvedValue([refund()]);
    record.mockResolvedValue({ readAsRefused: ["re_test"], payment: { id: "payment-test", source: "STRIPE" }, appliedCents: 0, newlyCountedRefundIds: [] });
    await expect(checkCardRefundResend(args)).resolves.toEqual(args.plan);
  });

  it("ignores a refund naming a different intent", async () => {
    list.mockResolvedValue([refund({ payment_intent: "pi_other" })]);
    await expect(checkCardRefundResend(args)).resolves.toEqual(args.plan);
    expect(record).not.toHaveBeenCalled();
  });

  it("accepts expanded Stripe references", async () => {
    list.mockResolvedValue([refund({ charge: { id: "ch_test" }, payment_intent: { id: "pi_test" } })]);
    await expect(checkCardRefundResend(args)).rejects.toBeInstanceOf(UnattributedCardRefundBeforeResendError);
  });

  it("checks every unsent charge and never checks a marked slice", async () => {
    const multi = {
      ...args,
      plan: [...args.plan, { paymentTransactionId: "transaction-second", amountCents: 2000 }, { paymentTransactionId: "transaction-made", amountCents: 1000, madeRefundId: "re_made" }],
      transactions: [...args.transactions, { id: "transaction-second", stripePaymentIntentId: "pi_second" }],
    };
    list.mockImplementation(async (intent) => intent === "pi_second" ? [refund({ charge: "ch_second", payment_intent: "pi_second" })] : []);
    await expect(checkCardRefundResend(multi)).rejects.toBeInstanceOf(UnattributedCardRefundBeforeResendError);
    expect(list).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ paymentTransactionId: "transaction-second" }));
  });

  it("propagates a provider failure before any write", async () => {
    list.mockRejectedValue(new Error("read timeout"));
    await expect(checkCardRefundResend(args)).rejects.toThrow("read timeout");
    expect(record).not.toHaveBeenCalled();
  });

  it("holds on conclusive evidence before a later charge can replace the hold with a retryable error", async () => {
    const multi = {
      ...args,
      plan: [...args.plan, { paymentTransactionId: "transaction-second", amountCents: 2000 }],
      transactions: [...args.transactions, { id: "transaction-second", stripePaymentIntentId: "pi_second" }],
    };
    list.mockImplementation(async (intent) => {
      if (intent === "pi_second") throw new Error("later charge timed out");
      return [refund()];
    });
    await expect(checkCardRefundResend(multi)).rejects.toMatchObject({
      constructor: UnattributedCardRefundBeforeResendError,
      stripeRefundIds: ["re_test"],
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(queueRecordedCardRefundNotes).toHaveBeenCalledTimes(1);
  });

  it("propagates a recording failure before a refund can be sent", async () => {
    list.mockResolvedValue([refund()]);
    record.mockRejectedValue(new Error("writer unavailable"));
    await expect(checkCardRefundResend(args)).rejects.toThrow("writer unavailable");
  });

  it("queues the existing accounting correction before holding the refund debt", async () => {
    list.mockResolvedValue([refund()]);
    await expect(checkCardRefundResend(args)).rejects.toBeInstanceOf(UnattributedCardRefundBeforeResendError);
    expect(queueRecordedCardRefundNotes).toHaveBeenCalledExactlyOnceWith({
      payment: { id: "payment-test", source: "STRIPE" }, paymentIntentId: "pi_test",
      deltaCents: 4000, newlyCountedRefundIds: ["re_test"], refunds: [refund()],
    });
  });

  it("still holds the debt if its accounting note cannot be queued", async () => {
    list.mockResolvedValue([refund()]);
    vi.mocked(queueRecordedCardRefundNotes).mockRejectedValueOnce(new Error("note queue unavailable"));
    await expect(checkCardRefundResend(args)).rejects.toBeInstanceOf(UnattributedCardRefundBeforeResendError);
  });

  it("fails closed when a charge has no intent", async () => {
    await expect(checkCardRefundResend({ ...args, transactions: [{ ...args.transactions[0]!, stripePaymentIntentId: null }] })).rejects.toThrow("INV-PAY-145");
    expect(list).not.toHaveBeenCalled();
  });

  it("sends nothing if recording cannot reconcile the payment", async () => {
    list.mockResolvedValue([refund()]);
    record.mockResolvedValue({ readAsRefused: [], payment: null });
    await expect(checkCardRefundResend(args)).rejects.toThrow("could not reconcile the payment");
    expect(queueRecordedCardRefundNotes).not.toHaveBeenCalled();
  });

  it("fails closed if a planned charge is missing", async () => {
    await expect(checkCardRefundResend({ ...args, transactions: [] })).rejects.toThrow("INV-PAY-145");
    expect(list).not.toHaveBeenCalled();
  });

  it.each(["succeeded", "pending", "requires_action", null])("marks exact slice evidence (%s), even with no other app metadata", async (status) => {
    list.mockResolvedValue([refund({ status, metadata: { [REFUND_SLICE_KEY_METADATA]: refundSliceStripeIdempotencyKey(args.stripeKeyPrefix, args.plan[0]!) } })]);
    const marked = [{ ...args.plan[0], madeRefundId: "re_test" }];
    await expect(checkCardRefundResend(args)).resolves.toEqual(marked);
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({ where: {
      id: "operation-test", status: "PROCESSING", processingStartedAt: args.operation.processingStartedAt,
      allocationPlan: { equals: args.operation.allocationPlan },
    }, data: { allocationPlan: marked } });
  });

  it("guards its first mark on the stored plan as read, not on the plan parsed from it (#4510 review F3)", async () => {
    // A stored slice can hold a key the parser does not keep; the row still holds it.
    const stored = [{ ...args.plan[0]!, laterField: "kept by the row" }];
    list.mockResolvedValue([refund({ metadata: { [REFUND_SLICE_KEY_METADATA]: refundSliceStripeIdempotencyKey(args.stripeKeyPrefix, args.plan[0]!) } })]);
    await expect(checkCardRefundResend({ ...args, operation: { ...args.operation, allocationPlan: stored } })).resolves.toEqual([{ ...args.plan[0], madeRefundId: "re_test" }]);
    expect(updateMany).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ where: expect.objectContaining({ allocationPlan: { equals: stored } }) }));
  });

  it("marks slices on two charges, the second compare-and-set on the plan the first wrote (#4510 review F5a)", async () => {
    const second = { paymentTransactionId: "transaction-second", amountCents: 2000 };
    const plan = [args.plan[0]!, second];
    const two = { ...args, plan, operation: { ...args.operation, allocationPlan: plan }, transactions: [...args.transactions, { id: "transaction-second", stripePaymentIntentId: "pi_second" }] };
    list.mockImplementation(async (intent) => intent === "pi_second"
      ? [refund({ id: "re_second", amount: 2000, charge: "ch_second", payment_intent: "pi_second", metadata: { [REFUND_SLICE_KEY_METADATA]: refundSliceStripeIdempotencyKey(args.stripeKeyPrefix, second) } })]
      : [refund({ metadata: { [REFUND_SLICE_KEY_METADATA]: refundSliceStripeIdempotencyKey(args.stripeKeyPrefix, args.plan[0]!) } })]);
    const first = [{ ...args.plan[0], madeRefundId: "re_test" }, second];
    const both = [first[0], { ...second, madeRefundId: "re_second" }];
    await expect(checkCardRefundResend(two)).resolves.toEqual(both);
    const where = { id: "operation-test", status: "PROCESSING", processingStartedAt: args.operation.processingStartedAt };
    expect(updateMany.mock.calls).toEqual([
      [{ where: { ...where, allocationPlan: { equals: plan } }, data: { allocationPlan: first } }],
      [{ where: { ...where, allocationPlan: { equals: first } }, data: { allocationPlan: both } }],
    ]);
  });

  it("never marks a refused1 slice with a counted refund under its un-suffixed key (#4510 review F5b)", async () => {
    const regenerated = { ...args.plan[0]!, stripeKeySuffix: "refused1" };
    const plan = [regenerated];
    const original = refundSliceStripeIdempotencyKey(args.stripeKeyPrefix, args.plan[0]!);
    expect(refundSliceStripeIdempotencyKey(args.stripeKeyPrefix, regenerated)).toBe(`${original}_refused1`);
    list.mockResolvedValue([refund({ metadata: { bookingId: "booking-test", reason: "date_change_price_decrease", [REFUND_SLICE_KEY_METADATA]: original } })]);
    await expect(checkCardRefundResend({ ...args, plan, operation: { ...args.operation, allocationPlan: plan } })).resolves.toEqual(plan);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each(["failed", "canceled"])("does not mark a matching %s refund", async (status) => {
    list.mockResolvedValue([refund({ status, metadata: { [REFUND_SLICE_KEY_METADATA]: refundSliceStripeIdempotencyKey(args.stripeKeyPrefix, args.plan[0]!) } })]);
    await expect(checkCardRefundResend(args)).resolves.toEqual(args.plan);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("does not mark a stale succeeded listing the ledger reads refused", async () => {
    list.mockResolvedValue([refund({ metadata: { [REFUND_SLICE_KEY_METADATA]: refundSliceStripeIdempotencyKey(args.stripeKeyPrefix, args.plan[0]!) } })]);
    record.mockResolvedValue({ readAsRefused: ["re_test"], payment: { id: "payment-test" }, appliedCents: 0, newlyCountedRefundIds: [] });
    await expect(checkCardRefundResend(args)).resolves.toEqual(args.plan);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each([
    { bookingId: "booking-test", reason: "date_change_price_decrease" },
    { bookingId: "booking-test", reason: "date_change_price_decrease", refundSliceKey: "another_rows_key" },
  ])("leaves legacy and unmatched app refunds unmarked", async (metadata) => {
    list.mockResolvedValue([refund({ metadata })]);
    await expect(checkCardRefundResend(args)).resolves.toEqual(args.plan);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("keeps the outside-app hold for unmatched key evidence", async () => {
    list.mockResolvedValue([refund({ metadata: { [REFUND_SLICE_KEY_METADATA]: "another_rows_key" } })]);
    await expect(checkCardRefundResend(args)).rejects.toBeInstanceOf(UnattributedCardRefundBeforeResendError);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("never replaces an existing mark with matching evidence", async () => {
    const made = { ...args.plan[0]!, madeRefundId: "re_original" };
    const plan = [made, { paymentTransactionId: "transaction-test", amountCents: 1000 }];
    list.mockResolvedValue([refund({ metadata: { bookingId: "booking-test", reason: "date_change_price_decrease", [REFUND_SLICE_KEY_METADATA]: refundSliceStripeIdempotencyKey(args.stripeKeyPrefix, made) } })]);
    await expect(checkCardRefundResend({ ...args, plan, operation: { ...args.operation, allocationPlan: plan } })).resolves.toEqual(plan);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("refuses a concurrent plan or claim change: its compare-and-set loses", async () => {
    list.mockResolvedValue([refund({ metadata: { [REFUND_SLICE_KEY_METADATA]: refundSliceStripeIdempotencyKey(args.stripeKeyPrefix, args.plan[0]!) } })]);
    updateMany.mockResolvedValue({ count: 0 });
    await expect(checkCardRefundResend(args)).rejects.toThrow("plan or claim changed");
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(queueRecordedCardRefundNotes).toHaveBeenCalledTimes(1);
  });

});
