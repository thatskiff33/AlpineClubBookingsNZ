/**
 * #3827, owner decision D-3813-6 (#3492, `INV-PAY-117`): an internet-banking
 * (or cash) price reduction, from any edit or a guest's acceptance, raises ONE
 * officer refund task in the money-to-settle queue, and the member's email says
 * the club will refund them by bank transfer.
 */
import { describe, expect, it, vi } from "vitest";

import {
  editRefundGoesBackByHand,
  raiseEditRefundHandBackIfOwed,
  raiseRefundRequestHandBack,
} from "@/lib/edit-refund-hand-back";
import { GROUP_CANCEL_IN_PROGRESS_RAISE_MESSAGE } from "@/lib/group-cancel-in-progress";
import {
  EDIT_REFUND_HAND_BACK_KEY_PREFIX,
  editRefundHandBackOccurrenceKey,
  isEditRefundHandBackTask,
  NOT_NON_CANCELLATION_HAND_BACK_WHERE,
} from "@/lib/manual-refund-task-settlement-rules";
import { bookingModifiedRefundSentence } from "@/lib/booking-modified-email-copy";

function tx() {
  return { manualRefundTask: { createMany: vi.fn(async () => ({ count: 1 })), findUniqueOrThrow: vi.fn(async () => ({ id: "handback" })) }, xeroSyncOperation: { findMany: vi.fn(async () => []) } };
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
      booking: { organiserSettled: false, parentBookingId: null, payment: null },
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
        booking: { organiserSettled: false, parentBookingId: null, payment: null },
      });
      expect(raised).toBe(false);
      expect(store.manualRefundTask.createMany).not.toHaveBeenCalled();
    }
  });
});

describe("#3949 review round 4: no refund to the organiser is raised while the group cancel is part-way through", () => {
  const ORGANISER_PAID = { organiserSettled: true, parentBookingId: "organiser-1", payment: { source: "INTERNET_BANKING" } };
  function groupTx(childStatus: string, groupStatus: string) {
    return {
      ...tx(),
      booking: { findUnique: vi.fn(async () => ({ status: childStatus, parentBookingId: "organiser-1" })) },
      groupBooking: { findUnique: vi.fn(async () => ({ status: groupStatus })) },
    };
  }
  const editRaise = (store: ReturnType<typeof groupTx>) =>
    raiseEditRefundHandBackIfOwed(store as never, {
      bookingId: "child-1", paymentId: "pay-1", bookingModificationId: "mod-1",
      adjusted: { refundAmountCents: 10_000, hasSucceededPayment: false }, editLabel: "date change", booking: ORGANISER_PAID,
    });
  const appealRaise = (store: ReturnType<typeof groupTx>) =>
    raiseRefundRequestHandBack(store as never, { bookingId: "child-1", paymentId: "pay-1", refundRequestId: "rr-1", amountCents: 10_000, booking: ORGANISER_PAID });

  it("an edit's and an appeal's are refused (409) while the group is CANCELLED and the child not yet claimed; nothing is raised", async () => {
    for (const raise of [editRaise, appealRaise]) {
      const store = groupTx("PAID", "CANCELLED");
      await expect(raise(store)).rejects.toMatchObject({ status: 409, message: GROUP_CANCEL_IN_PROGRESS_RAISE_MESSAGE });
      expect(store.manualRefundTask.createMany).not.toHaveBeenCalled();
    }
  });

  it("raised as before on a live group, and once the cancel has claimed the child", async () => {
    for (const raise of [editRaise, appealRaise]) {
      for (const [child, group] of [["PAID", "OPEN"], ["CANCELLED", "CANCELLED"]] as const) {
        const store = groupTx(child, group);
        await raise(store);
        expect(store.manualRefundTask.createMany).toHaveBeenCalledTimes(1);
      }
    }
  });
});

describe("telling an edit refund hand-back from a cancellation's (INV-PAY-117)", () => {
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
            { NOT: { occurrenceKey: { startsWith: "card-refund-paid-another-way:" } } },
            { NOT: { occurrenceKey: { startsWith: "bank-refund-void:" } } },
          ],
        },
      ],
    });
  });
});

describe("the member is told the club WILL refund by bank transfer (D-3813-6)", () => {
  it("promises a bank transfer, and keeps the card wording for a card refund", () => {
    expect(bookingModifiedRefundSentence("$60.00", "member", "own")).toBe(
      "The club will refund $60.00 to you by bank transfer.",
    );
    expect(bookingModifiedRefundSentence("$60.00", null, "own")).toBe(
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
      // #3536: the payment the cash-or-bank question reads (edit reviews only).
      paymentId: null,
      payment: null,
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
        organiserSettled: false,
        parentBookingId: null,
        status: "CONFIRMED",
        payment: null,
      },
    };
    expect(toOpenManualRefundTaskPayload(row, null, []).editRefundHandBack).toBe(true);
    expect(toOpenManualRefundTaskPayload({ ...row, occurrenceKey: null }, null, []).editRefundHandBack).toBe(false);
    // #3949: on a joiner the organiser paid for by internet banking, it goes back to the organiser.
    expect(toOpenManualRefundTaskPayload(row, null, []).paidToGroupOrganiser).toBe(false);
    const groupChild = {
      ...row,
      booking: { ...row.booking, organiserSettled: true, parentBookingId: "organiser", payment: { id: "p", status: "SUCCEEDED", amountCents: 6000, refundedAmountCents: 0, source: "INTERNET_BANKING" } },
    };
    expect(toOpenManualRefundTaskPayload(groupChild, null, []).paidToGroupOrganiser).toBe(true);
    expect(toOpenManualRefundTaskPayload({ ...groupChild, occurrenceKey: "refund-request-hand-back:r1" }, null, []).paidToGroupOrganiser).toBe(true);
    // Owner decision, 22 Oct 2026: the joiner's own cancellation's hand-back (keyless) goes to the organiser too.
    expect(toOpenManualRefundTaskPayload({ ...groupChild, occurrenceKey: null }, null, []).paidToGroupOrganiser).toBe(true);
    expect(toOpenManualRefundTaskPayload({ ...groupChild, occurrenceKey: "group-organiser-hand-back:s1" }, null, []).paidToGroupOrganiser).toBe(false);
    // Review round 3: a refund review on the same child, by the chooser's own test - its payment is the mirror.
    const review = { ...groupChild, kind: "EDIT_FINANCIAL_REVIEW", occurrenceKey: null, paymentId: "p", payment: { source: "INTERNET_BANKING" }, booking: { ...groupChild.booking, status: "PAID" } };
    expect(toOpenManualRefundTaskPayload(review, null, []).paidToGroupOrganiser).toBe(true);
    expect(toOpenManualRefundTaskPayload({ ...review, booking: { ...review.booking, organiserSettled: false } }, null, []).paidToGroupOrganiser).toBe(false);
  });
});
