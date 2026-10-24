/**
 * #3827, owner decision D-3813-7 (#3492, `INV-PAY-118`): an approved refund
 * request's part that no card refund carries raises ONE officer refund task,
 * marked like an edit's, netted with it, and promised to the member as a bank
 * transfer.
 */
import { describe, expect, it, vi } from "vitest";

import {
  openNonCancellationHandBackCents,
  raiseRefundRequestHandBack,
  refundableCashForRefundAppeal,
  refundAppealHandedBackCents,
  refundAppealHandedBackParts,
  totalRefundAppealHandedBackCents,
} from "@/lib/edit-refund-hand-back";
import {
  isInternetBankingLateCashCredit,
  sumInternetBankingLateCashCreditCents,
} from "@/lib/internet-banking-late-cash-credit";
import {
  isEditRefundHandBackTask,
  isNonCancellationHandBackCompletedEvent,
  isNonCancellationHandBackTask,
  isRefundRequestHandBackTask,
  NON_CANCELLATION_HAND_BACK_WHERE,
  nonCancellationHandBackCompletedSnapshot,
  refundAppealCeilingParts,
  refundRequestHandBackOccurrenceKey,
} from "@/lib/manual-refund-task-settlement-rules";
import { isRefundOutsideBookingSettlement } from "@/lib/refund-event-outside-settlement";
import { refundRequestApprovedRefundSentence } from "@/lib/booking-modified-email-copy";

function tx(count = 1) {
  return { manualRefundTask: { createMany: vi.fn(async () => ({ count })) } };
}

const APPEAL_KEY = "refund-request-hand-back:req-1";

describe("raising an approved appeal's hand-back (D-3813-7)", () => {
  it("raises one CANCELLED_BOOKING_HAND_BACK keyed on the request, fixed at the amount, ON CONFLICT DO NOTHING", async () => {
    const store = tx();
    const raised = await raiseRefundRequestHandBack(store as never, {
      bookingId: "booking-1",
      paymentId: "pay-1",
      refundRequestId: "req-1",
      amountCents: 10000,
      booking: { organiserSettled: false, parentBookingId: null, payment: null },
    });
    expect(raised).toBe(1);
    expect(store.manualRefundTask.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          bookingId: "booking-1",
          paymentId: "pay-1",
          amountCents: 10000,
          raisedAmountCents: 10000,
          kind: "CANCELLED_BOOKING_HAND_BACK",
          occurrenceKey: APPEAL_KEY,
        }),
      ],
      skipDuplicates: true,
    });
  });

  it("reports a replay that found the key taken as nothing raised", async () => {
    const store = tx(0);
    expect(
      await raiseRefundRequestHandBack(store as never, {
        bookingId: "booking-1",
        paymentId: "pay-1",
        refundRequestId: "req-1",
        amountCents: 10000,
        booking: { organiserSettled: false, parentBookingId: null, payment: null },
      }),
    ).toBe(0);
  });

  it("raises nothing when the card carries all of it", async () => {
    for (const amountCents of [0, -1]) {
      const store = tx();
      expect(
        await raiseRefundRequestHandBack(store as never, {
          bookingId: "booking-1",
          paymentId: "pay-1",
          refundRequestId: "req-1",
          amountCents,
          booking: { organiserSettled: false, parentBookingId: null, payment: null },
        }),
      ).toBe(0);
      expect(store.manualRefundTask.createMany).not.toHaveBeenCalled();
    }
  });
});

describe("telling an appeal's hand-back apart (INV-PAY-118)", () => {
  const appeal = { kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: refundRequestHandBackOccurrenceKey("req-1") };
  const edit = { kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "edit-refund-hand-back:mod-1" };
  const cancellation = { kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: null };

  it("is the hand-back kind carrying the request key", () => {
    expect(appeal.occurrenceKey).toBe(APPEAL_KEY);
    expect(isRefundRequestHandBackTask(appeal)).toBe(true);
    expect(isRefundRequestHandBackTask(edit)).toBe(false);
    expect(isRefundRequestHandBackTask(cancellation)).toBe(false);
    expect(isRefundRequestHandBackTask({ kind: "EDIT_FINANCIAL_REVIEW", occurrenceKey: APPEAL_KEY })).toBe(false);
  });

  it("counts as a non-cancellation hand-back, but not as an edit's", () => {
    expect(isNonCancellationHandBackTask(appeal)).toBe(true);
    expect(isNonCancellationHandBackTask(edit)).toBe(true);
    expect(isNonCancellationHandBackTask(cancellation)).toBe(false);
    // The after-cancel dismiss/reopen refusals are the edit's alone.
    expect(isEditRefundHandBackTask(appeal)).toBe(false);
  });

  it("is in the positive fragment the netting reads", () => {
    expect(NON_CANCELLATION_HAND_BACK_WHERE).toEqual({
      kind: "CANCELLED_BOOKING_HAND_BACK",
      OR: [
        { occurrenceKey: { startsWith: "edit-refund-hand-back:" } },
        { occurrenceKey: { startsWith: "refund-request-hand-back:" } },
        { occurrenceKey: { startsWith: "card-refund-paid-another-way:" } },
        { occurrenceKey: { startsWith: "bank-refund-void:" } },
      ],
    });
  });
});

describe("its completion event stays out of the cancellation's settlement", () => {
  it("marks the REFUNDED event with its own kind, which the narrative excludes", () => {
    const snapshot = nonCancellationHandBackCompletedSnapshot({
      id: "task-9",
      kind: "CANCELLED_BOOKING_HAND_BACK",
      occurrenceKey: APPEAL_KEY,
    });
    expect(snapshot).toEqual({ kind: "refund_request_hand_back_completed", manualRefundTaskId: "task-9" });
    const event = { type: "REFUNDED", snapshot, reason: "manual_refund_completed" };
    expect(isNonCancellationHandBackCompletedEvent(event)).toBe(true);
    expect(isRefundOutsideBookingSettlement(event as never)).toBe(true);
  });

  it("keeps an edit's marker, and leaves an unmarked REFUNDED event as the settlement", () => {
    expect(
      nonCancellationHandBackCompletedSnapshot({
        id: "task-1",
        kind: "CANCELLED_BOOKING_HAND_BACK",
        occurrenceKey: "edit-refund-hand-back:mod-1",
      }).kind,
    ).toBe("edit_refund_hand_back_completed");
    expect(isNonCancellationHandBackCompletedEvent({ type: "REFUNDED", snapshot: null })).toBe(false);
    expect(
      isNonCancellationHandBackCompletedEvent({
        type: "CREDITED",
        snapshot: { kind: "refund_request_hand_back_completed" },
      }),
    ).toBe(false);
  });
});

describe("the member is told the club WILL refund by bank transfer (D-3813-7)", () => {
  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  it("keeps the card wording when the card carries it all", () => {
    expect(refundRequestApprovedRefundSentence(2500, 0, fmt)).toBe(
      "A refund of $25.00 will be processed to your original payment method.",
    );
  });
  it("promises a bank transfer when no card refund carries any of it", () => {
    expect(refundRequestApprovedRefundSentence(2500, 2500, fmt)).toBe(
      "The club will refund $25.00 to you by bank transfer.",
    );
  });
  it("names both parts for a payment partly by card", () => {
    expect(refundRequestApprovedRefundSentence(2500, 1500, fmt)).toBe(
      "A refund of $10.00 will be processed to your original payment method, and the club will refund the remaining $15.00 to you by bank transfer.",
    );
  });
});

describe("the queue payload marks an appeal's hand-back for the card", () => {
  it("true for the request key, false for an edit's or a cancellation's", async () => {
    const { toOpenManualRefundTaskPayload } = await import("@/lib/manual-refund-task-queue-payload");
    const row = {
      id: "task-1",
      bookingId: "booking-1",
      amountCents: 6000,
      raisedAmountCents: 6000,
      kind: "CANCELLED_BOOKING_HAND_BACK",
      // #3536: the payment the cash-or-bank question reads (edit reviews only).
      paymentId: null,
      payment: null,
      lateCaptureApprovalIntentId: null,
      partPaymentReviewPaymentId: null,
      partPaymentReviewXeroPaidAt: null,
      partPaymentReviewXeroPaidCents: null,
      occurrenceKey: APPEAL_KEY,
      reviewContext: null,
      reason: "r",
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      booking: {
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-03T00:00:00.000Z"),
        member: { firstName: "Ann", lastName: "Owner" },
        organisation: null,
        memberId: "ann",
        deletedAt: null,
        organiserSettled: false,
        parentBookingId: null,
        status: "CANCELLED",
        payment: null,
      },
    };
    const appealPayload = toOpenManualRefundTaskPayload(row, null, []);
    expect(appealPayload.refundRequestHandBack).toBe(true);
    expect(appealPayload.editRefundHandBack).toBe(false);
    const editPayload = toOpenManualRefundTaskPayload({ ...row, occurrenceKey: "edit-refund-hand-back:m" }, null, []);
    expect(editPayload.refundRequestHandBack).toBe(false);
    expect(toOpenManualRefundTaskPayload({ ...row, occurrenceKey: null }, null, []).refundRequestHandBack).toBe(false);
  });
});

/**
 * #3827 (`INV-PAY-118`): the appeal's ceiling nets the money already returned
 * through the two channels that never move `refundedAmountCents` - every open
 * hand-back on the payment (a cancellation's own included) and the member
 * credit minted from late cash - on the server and on the screens alike.
 */
describe("the refund appeal ceiling (INV-PAY-118)", () => {
  const payment = { id: "pay-1", bookingId: "booking-1", status: "SUCCEEDED", amountCents: 10000, refundedAmountCents: 0 };
  const lateCash = { amountCents: 3000, description: "Internet Banking payment credit for cancelled booking booking-" };
  const cancellationCredit = { amountCents: 2000, description: "Cancellation refund credit for booking booking-" };

  function capStore(openCents: number | null, creditCents: number | null, fresh: object | null = payment) {
    return {
      manualRefundTask: { aggregate: vi.fn(async () => ({ _sum: { amountCents: openCents } })) },
      memberCredit: { aggregate: vi.fn(async () => ({ _sum: { amountCents: creditCents } })) },
      // #4124: the card-debt read and the payment read; no open card-refund debt.
      payment: { findUnique: vi.fn(async () => fresh && { recoveryOperations: [], refunds: [], ...fresh }) },
    };
  }

  it("server: subtracts every open hand-back and the late-cash credit, read BEFORE the payment", async () => {
    const store = capStore(4000, 3000);
    await expect(refundableCashForRefundAppeal(store as never, payment)).resolves.toBe(3000);
    // A cancellation hand-back completing between the reads (no lock(1)) is
    // then counted twice - the cap errs low - never not at all.
    const paymentRead = store.payment.findUnique.mock.invocationCallOrder[0];
    expect(store.manualRefundTask.aggregate.mock.invocationCallOrder[0]).toBeLessThan(paymentRead);
    expect(store.memberCredit.aggregate.mock.invocationCallOrder[0]).toBeLessThan(paymentRead);
    expect(store.manualRefundTask.aggregate).toHaveBeenCalledWith({
      where: { paymentId: "pay-1", status: "OPEN", kind: "CANCELLED_BOOKING_HAND_BACK" },
      _sum: { amountCents: true },
    });
    expect(store.memberCredit.aggregate).toHaveBeenCalledWith({
      where: {
        sourceBookingId: { in: ["booking-1"] },
        type: "CANCELLATION_REFUND",
        description: { startsWith: "Internet Banking payment credit for " },
      },
      _sum: { amountCents: true },
    });
  });

  it("server: never below zero; zero for an uncaptured or missing payment", async () => {
    await expect(refundableCashForRefundAppeal(capStore(9000, 9000) as never, payment)).resolves.toBe(0);
    await expect(
      refundableCashForRefundAppeal(capStore(0, 0, { ...payment, status: "PENDING" }) as never, payment),
    ).resolves.toBe(0);
    const store = capStore(0, 0);
    await expect(refundableCashForRefundAppeal(store as never, null)).resolves.toBe(0);
    expect(store.manualRefundTask.aggregate).not.toHaveBeenCalled();
  });

  /** The screen's ceiling alone (`refundAppealCeilingParts`). */
  const refundAppealCeiling = (...args: Parameters<typeof refundAppealCeilingParts>) => refundAppealCeilingParts(...args).ceilingCents;

  it("screen: the same figure from the loaded rows, counting only the late-cash credit", () => {
    expect(
      refundAppealCeiling(
        { ...payment, recoveryOperations: [], refunds: [], manualRefundTasks: [{ amountCents: 4000 }, { amountCents: null }] },
        [lateCash, cancellationCredit],
      ),
    ).toBe(3000);
    expect(refundAppealCeiling({ ...payment, recoveryOperations: [], refunds: [], manualRefundTasks: [] }, null)).toBe(10000);
    expect(refundAppealCeiling(null, [lateCash])).toBe(0);
  });

  // #4124: a card refund Stripe refused (or that failed later) is out of
  // `refundedAmountCents` while a recovery row is set to send it; an appeal
  // approved against it would return it twice. Server and screen both net it.
  const owingOperation = {
    id: "op-refused",
    type: "REFUND_BOOKING_MODIFICATION" as const,
    status: "FAILED" as const,
    idempotencyKey: "refund_request_refund_rr0",
    amountCents: 2500,
    allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 2500, stripeKeySuffix: "refused1" }],
    paymentTransactionId: null,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    succeededAt: null,
  };

  it("#4124 server: an open card-refund debt comes off the appeal ceiling, read before the payment", async () => {
    const store = {
      manualRefundTask: { aggregate: vi.fn(async () => ({ _sum: { amountCents: null } })) },
      memberCredit: { aggregate: vi.fn(async () => ({ _sum: { amountCents: null } })) },
      payment: { findUnique: vi.fn(async () => ({ ...payment, recoveryOperations: [owingOperation], refunds: [] })) },
    };
    await expect(refundableCashForRefundAppeal(store as never, payment)).resolves.toBe(7500);
    // Two payment reads: the card-refund debt (its recovery rows), then the
    // payment the ceiling is taken from - the debt first, with the other sums.
    const [debtRead, paymentRead] = store.payment.findUnique.mock.calls as unknown as Array<[{ select: Record<string, unknown> }]>;
    expect(debtRead?.[0].select).toHaveProperty("recoveryOperations");
    expect(paymentRead?.[0].select).not.toHaveProperty("recoveryOperations");
    const [debtAt, paymentAt] = store.payment.findUnique.mock.invocationCallOrder;
    expect(store.manualRefundTask.aggregate.mock.invocationCallOrder[0]).toBeLessThan(paymentAt!);
    expect(store.memberCredit.aggregate.mock.invocationCallOrder[0]).toBeLessThan(paymentAt!);
    expect(debtAt).toBeLessThan(paymentAt!);
  });

  it("#4124 review F1: the parts keep the card debt apart, and the total sums all three", async () => {
    const store = {
      manualRefundTask: { aggregate: vi.fn(async () => ({ _sum: { amountCents: 1000 } })) },
      memberCredit: { aggregate: vi.fn(async () => ({ _sum: { amountCents: 500 } })) },
      payment: { findUnique: vi.fn(async () => ({ ...payment, recoveryOperations: [owingOperation], refunds: [] })) },
    };
    const parts = await refundAppealHandedBackParts(store as never, payment);
    expect(parts).toEqual({ handBackCents: 1000, lateCashCreditCents: 500, cardRefundOwedCents: 2500 });
    expect(totalRefundAppealHandedBackCents(parts)).toBe(4000);
    await expect(refundAppealHandedBackCents(store as never, payment)).resolves.toBe(4000);
  });

  it("#4124 screen: the same figure from the loaded rows", () => {
    expect(refundAppealCeilingParts({ ...payment, recoveryOperations: [owingOperation], refunds: [], manualRefundTasks: [] }, null)).toEqual({
      ceilingCents: 7500,
      cardRefundOwedCents: 2500,
    });
    // Made since: the debt is gone and the cap is whole again.
    expect(
      refundAppealCeiling({ ...payment, recoveryOperations: [{ ...owingOperation, status: "SUCCEEDED" as const }], refunds: [], manualRefundTasks: [] }, null),
    ).toBe(10000);
  });

  it("the late-cash predicate keys on the pipeline's prefix and type, never on amount", () => {
    expect(isInternetBankingLateCashCredit(lateCash)).toBe(true);
    expect(isInternetBankingLateCashCredit({ description: "Internet Banking payment credit for booking abc" })).toBe(true);
    expect(isInternetBankingLateCashCredit(cancellationCredit)).toBe(false);
    expect(isInternetBankingLateCashCredit({ ...lateCash, type: "BOOKING_MODIFICATION_REFUND" })).toBe(false);
    expect(isInternetBankingLateCashCredit({ description: null })).toBe(false);
    expect(sumInternetBankingLateCashCreditCents([lateCash, lateCash, cancellationCredit])).toBe(6000);
  });

  it("an edit or a cancel keeps EXCLUDING the cancellation's own task (by design)", async () => {
    const store = capStore(4000, 3000);
    await openNonCancellationHandBackCents(store as never, "pay-1");
    expect(store.manualRefundTask.aggregate).toHaveBeenCalledWith({
      where: expect.objectContaining({
        OR: [
          { occurrenceKey: { startsWith: "edit-refund-hand-back:" } },
          { occurrenceKey: { startsWith: "refund-request-hand-back:" } },
          { occurrenceKey: { startsWith: "card-refund-paid-another-way:" } },
          { occurrenceKey: { startsWith: "bank-refund-void:" } },
        ],
      }),
      _sum: { amountCents: true },
    });
    expect(store.memberCredit.aggregate).not.toHaveBeenCalled();
  });
});
