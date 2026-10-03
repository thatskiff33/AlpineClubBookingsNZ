/**
 * #3827, owner decision D-3813-6 (#3492, `INV-PAY-115`): an internet-banking
 * (or cash) price reduction, from any edit or a guest's acceptance, raises ONE
 * officer refund task in the money-to-settle queue, and the member's email says
 * the club will refund them by bank transfer.
 */
import { describe, expect, it, vi } from "vitest";

import {
  editRefundGoesBackByHand,
  raiseEditRefundHandBackIfOwed,
} from "@/lib/edit-refund-hand-back";
import {
  EDIT_REFUND_HAND_BACK_KEY_PREFIX,
  editRefundHandBackOccurrenceKey,
  isEditRefundHandBackTask,
  NOT_NON_CANCELLATION_HAND_BACK_WHERE,
} from "@/lib/manual-refund-task-settlement-rules";
import { bookingModifiedRefundSentence } from "@/lib/booking-modified-email-copy";

function tx() {
  return { manualRefundTask: { createMany: vi.fn(async () => ({ count: 1 })) } };
}

describe("which edit refunds go back by hand (D-3813-6)", () => {
  it("a refund not captured through Stripe does; a card refund, credit, or nothing does not", () => {
    expect(editRefundGoesBackByHand({ refundAmountCents: 6000, hasSucceededPayment: false })).toBe(true);
    expect(editRefundGoesBackByHand({ refundAmountCents: 6000, hasSucceededPayment: true })).toBe(false);
    expect(editRefundGoesBackByHand({ refundAmountCents: 0, hasSucceededPayment: false })).toBe(false);
  });
});

describe("raising the edit's refund hand-back", () => {
  it("raises one CANCELLED_BOOKING_HAND_BACK keyed on the modification, fixed at the refund, idempotent on replay", async () => {
    const store = tx();
    const raised = await raiseEditRefundHandBackIfOwed(store as never, {
      bookingId: "booking-1",
      paymentId: "pay-1",
      bookingModificationId: "mod-1",
      adjusted: { refundAmountCents: 6000, hasSucceededPayment: false },
      editLabel: "date change",
    });
    expect(raised).toBe(true);
    expect(store.manualRefundTask.createMany).toHaveBeenCalledTimes(1);
    const [{ data, skipDuplicates }] = store.manualRefundTask.createMany.mock.calls[0] as unknown as [
      { data: Array<Record<string, unknown>>; skipDuplicates: boolean },
    ];
    // ON CONFLICT DO NOTHING: a replay inside the same edit transaction must
    // not raise a unique violation, which would abort the edit.
    expect(skipDuplicates).toBe(true);
    expect(data).toEqual([
      expect.objectContaining({
        bookingId: "booking-1",
        paymentId: "pay-1",
        amountCents: 6000,
        raisedAmountCents: 6000,
        kind: "CANCELLED_BOOKING_HAND_BACK",
        occurrenceKey: "edit-refund-hand-back:mod-1",
      }),
    ]);
    expect(String(data[0]!.reason).length).toBeLessThanOrEqual(500);
  });

  it("raises nothing for a card refund, a zero refund or a booking with no payment row", async () => {
    for (const [adjusted, paymentId] of [
      [{ refundAmountCents: 6000, hasSucceededPayment: true }, "pay-1"],
      [{ refundAmountCents: 0, hasSucceededPayment: false }, "pay-1"],
      [{ refundAmountCents: 6000, hasSucceededPayment: false }, null],
    ] as const) {
      const store = tx();
      const raised = await raiseEditRefundHandBackIfOwed(store as never, {
        bookingId: "booking-1",
        paymentId,
        bookingModificationId: "mod-1",
        adjusted,
        editLabel: "date change",
      });
      expect(raised).toBe(false);
      expect(store.manualRefundTask.createMany).not.toHaveBeenCalled();
    }
  });
});

describe("telling an edit refund hand-back from a cancellation's (INV-PAY-115)", () => {
  it("is the hand-back kind carrying the edit key, and nothing else", () => {
    const key = editRefundHandBackOccurrenceKey("mod-1");
    expect(key.startsWith(EDIT_REFUND_HAND_BACK_KEY_PREFIX)).toBe(true);
    expect(isEditRefundHandBackTask({ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: key })).toBe(true);
    expect(isEditRefundHandBackTask({ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: null })).toBe(false);
    expect(isEditRefundHandBackTask({ kind: "EDIT_FINANCIAL_REVIEW", occurrenceKey: key })).toBe(false);
    expect(isEditRefundHandBackTask({ kind: "EDIT_FINANCIAL_REVIEW", occurrenceKey: "edit-review:x" })).toBe(false);
  });

  it("the query fragment keeps a cancellation's (no key) and drops an edit's and an appeal's", () => {
    expect(NOT_NON_CANCELLATION_HAND_BACK_WHERE).toEqual({
      OR: [
        { occurrenceKey: null },
        {
          AND: [
            { NOT: { occurrenceKey: { startsWith: EDIT_REFUND_HAND_BACK_KEY_PREFIX } } },
            { NOT: { occurrenceKey: { startsWith: "refund-request-hand-back:" } } },
          ],
        },
      ],
    });
  });
});

describe("the member is told the club WILL refund by bank transfer (D-3813-6)", () => {
  it("promises a bank transfer, and keeps the card wording for a card refund", () => {
    expect(bookingModifiedRefundSentence("$60.00", true)).toBe(
      "The club will refund $60.00 to you by bank transfer.",
    );
    expect(bookingModifiedRefundSentence("$60.00", false)).toBe(
      "A refund of $60.00 has been processed to your original payment method.",
    );
  });
});

describe("the queue payload marks an edit refund hand-back for the card", () => {
  it("true for the edit key, false for a cancellation's hand-back", async () => {
    const { toOpenManualRefundTaskPayload } = await import("@/lib/manual-refund-task-queue-payload");
    const row = {
      id: "task-1",
      bookingId: "booking-1",
      amountCents: 6000,
      raisedAmountCents: 6000,
      kind: "CANCELLED_BOOKING_HAND_BACK",
      lateCaptureApprovalIntentId: null,
      partPaymentReviewPaymentId: null,
      partPaymentReviewXeroPaidAt: null,
      partPaymentReviewXeroPaidCents: null,
      occurrenceKey: "edit-refund-hand-back:mod-1",
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
      },
    };
    expect(toOpenManualRefundTaskPayload(row, null, []).editRefundHandBack).toBe(true);
    expect(toOpenManualRefundTaskPayload({ ...row, occurrenceKey: null }, null, []).editRefundHandBack).toBe(false);
  });
});
