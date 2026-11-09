import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

const { list, record, updateMany, paymentFindUnique } = vi.hoisted(() => ({ list: vi.fn(), record: vi.fn(), updateMany: vi.fn(), paymentFindUnique: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { paymentRecoveryOperation: { updateMany }, payment: { findUnique: paymentFindUnique } } }));
vi.mock("@/lib/xero-error-alert", () => ({ notifyXeroSyncError: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/recorded-card-refund-notes", () => ({ queueRecordedCardRefundNotes: vi.fn().mockResolvedValue({ queueOperationId: null }) }));
vi.mock("@/lib/stripe", () => ({ listRefundsForPaymentIntent: list }));
vi.mock("@/lib/payment-transactions", () => ({ recordStripeRefundsAgainstTransaction: record }));
import { refundSliceStripeIdempotencyKey } from "@/lib/payment-recovery-keys";
import { REFUND_SLICE_KEY_METADATA } from "@/lib/refund-slice-evidence";
import { queueRecordedCardRefundNotes } from "@/lib/recorded-card-refund-notes";
import {
  AnotherRefundSizesSupersededRowError,
  checkCardRefundResend,
  holdSupersededRowSizedOnAnotherRefund,
  preflightCardRefundResend,
  UnattributedCardRefundBeforeResendError,
} from "@/lib/card-refund-resend-preflight";
import { cardRefundOperationRefundMetadata } from "@/lib/payment-recovery-keys";

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

/*
  #4858 (`INV-PAY-145`): a superseded intent's refund with no stored plan is sized on its charge's
  ledger, so another door's refund on that charge since the row was raised counts as its progress.
  Were that refund to fail later, it would be owed on a row of its own while this row re-sized with
  its headroom back. The runner holds the row instead, by the rule "Try the card again" refuses a
  re-arm by (`foreignRefundsSizingSupersededRow`): the owed figure's attribution, read from the
  ledger, against Stripe's listing of the charge.
*/
describe("a plan-less superseded row sized on another refund holds (#4858)", () => {
  const raised = new Date("2026-06-20T10:00:00.400Z");
  const superseded = {
    id: "superseded-row",
    type: "REFUND_SUPERSEDED_PAYMENT" as const,
    status: "PROCESSING",
    paymentId: "payment-test",
    bookingId: "booking-test",
    idempotencyKey: "payment_recovery_cancel_transaction-test_pi_test",
    stripeKeyPrefix: null,
    allocationPlan: null,
    amountCents: 6000,
    paymentTransactionId: "transaction-test",
    createdAt: raised,
    succeededAt: null,
  };
  const ownMetadata = cardRefundOperationRefundMetadata(superseded);
  const otherDoor = { bookingId: "booking-test", reason: "date_change_price_decrease" }; // An edit's inline refund (review F2).
  const madeAfter = new Date("2026-06-21T00:00:00.000Z");
  const ledgerRefund = (id: string, overrides: Record<string, unknown> = {}) => ({
    stripeRefundId: id, paymentTransactionId: "transaction-test", amountCents: 2000, status: "succeeded", createdAt: madeAfter, stripeCreatedAt: madeAfter, ...overrides,
  });
  const listed = (id: string, metadata: Record<string, string>) => refund({ id, amount: 2000, metadata, created: Math.floor(madeAfter.getTime() / 1000) });
  const paymentWith = (refunds: unknown[], recoveryOperations: unknown[] = [superseded]) =>
    paymentFindUnique.mockResolvedValue({ recoveryOperations, refunds });

  beforeEach(() => {
    paymentFindUnique.mockReset();
  });

  it("MUTATION: another door's counted refund on its charge since it was raised holds it, with that refund named, on the outside-app hold's path", async () => {
    paymentWith([ledgerRefund("re_other")]);
    const held = holdSupersededRowSizedOnAnotherRefund({ operation: superseded, listed: [listed("re_other", otherDoor)] });
    await expect(held).rejects.toBeInstanceOf(AnotherRefundSizesSupersededRowError);
    await expect(held).rejects.toBeInstanceOf(UnattributedCardRefundBeforeResendError);
    await expect(held).rejects.toMatchObject({ stripeRefundIds: ["re_other"], message: expect.stringContaining("#4858") });
    expect(paymentFindUnique).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ where: { id: "payment-test" } }));
  });

  it("MUTATION: a counted refund on its charge that Stripe did not list holds it: the app cannot show it is the row's own", async () => {
    paymentWith([ledgerRefund("re_unlisted")]);
    await expect(holdSupersededRowSizedOnAnotherRefund({ operation: superseded, listed: [] })).rejects.toMatchObject({ stripeRefundIds: ["re_unlisted"] });
  });

  it("MUTATION: not held while every refund attributed to it is its own request's", async () => {
    paymentWith([ledgerRefund("re_own")]);
    await expect(holdSupersededRowSizedOnAnotherRefund({ operation: superseded, listed: [listed("re_own", ownMetadata)] })).resolves.toBeUndefined();
  });

  it("MUTATION: not held, and nothing read, for a row with a stored plan: its slices are sent as written", async () => {
    paymentWith([ledgerRefund("re_other")]);
    const planned = { ...superseded, allocationPlan: [{ paymentTransactionId: "transaction-test", amountCents: 6000 }] };
    await expect(holdSupersededRowSizedOnAnotherRefund({ operation: planned, listed: [listed("re_other", otherDoor)] })).resolves.toBeUndefined();
    expect(paymentFindUnique).not.toHaveBeenCalled();
  });

  it("MUTATION: not held for another door's refund Stripe made before the row was raised", async () => {
    const before = new Date("2026-06-20T09:59:59.000Z");
    paymentWith([ledgerRefund("re_before", { createdAt: before, stripeCreatedAt: before })]);
    await expect(holdSupersededRowSizedOnAnotherRefund({ operation: superseded, listed: [listed("re_before", otherDoor)] })).resolves.toBeUndefined();
  });

  it("not held for another door's refund matched to a slice: a row that marked it owes it, not this one", async () => {
    const marking = {
      ...superseded,
      id: "cancellation-row",
      type: "REFUND_BOOKING_MODIFICATION",
      status: "SUCCEEDED",
      idempotencyKey: "booking_cancel_refund_recovery_booking-test",
      allocationPlan: [{ paymentTransactionId: "transaction-test", amountCents: 2000, madeRefundId: "re_marked" }],
      amountCents: 2000,
      createdAt: madeAfter,
      succeededAt: madeAfter,
    };
    paymentWith([ledgerRefund("re_marked")], [superseded, marking]);
    await expect(holdSupersededRowSizedOnAnotherRefund({ operation: superseded, listed: [listed("re_marked", otherDoor)] })).resolves.toBeUndefined();
  });

  it.each(["failed", "canceled"])("not held for another door's refund the ledger reads %s: it no longer counts", async (status) => {
    paymentWith([ledgerRefund("re_other", { status })]);
    await expect(holdSupersededRowSizedOnAnotherRefund({ operation: superseded, listed: [listed("re_other", otherDoor)] })).resolves.toBeUndefined();
  });

  it("a booking modification's refund with no plan is not the superseded runner's: nothing read", async () => {
    await expect(
      holdSupersededRowSizedOnAnotherRefund({ operation: { ...superseded, type: "REFUND_BOOKING_MODIFICATION" }, listed: [] }),
    ).resolves.toBeUndefined();
    expect(paymentFindUnique).not.toHaveBeenCalled();
  });

  it("fails closed (a retry, not a hold) if the payment cannot be read", async () => {
    paymentFindUnique.mockResolvedValue(null);
    const read = holdSupersededRowSizedOnAnotherRefund({ operation: superseded, listed: [] });
    await expect(read).rejects.toThrow("could not read the payment");
    await expect(read).rejects.not.toBeInstanceOf(UnattributedCardRefundBeforeResendError);
  });

  it("the preflight hands back what Stripe listed on each charge it read, an empty list included", async () => {
    const second = { paymentTransactionId: "transaction-second", amountCents: 2000 };
    const other = refund({ id: "re_app", metadata: otherDoor });
    list.mockImplementation(async (intent) => (intent === "pi_test" ? [other] : []));
    const result = await preflightCardRefundResend({
      ...args,
      plan: [...args.plan, second],
      transactions: [...args.transactions, { id: "transaction-second", stripePaymentIntentId: "pi_second" }],
    });
    expect(result.plan).toEqual([...args.plan, second]);
    expect([...result.listedByTransaction]).toEqual([["transaction-test", [other]], ["transaction-second", []]]);
  });
});
