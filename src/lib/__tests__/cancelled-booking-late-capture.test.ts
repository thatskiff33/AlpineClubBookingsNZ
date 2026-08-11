import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2773 / #2774 — the shared late-capture epilogue, and the fence that stops the
 * club paying a member twice.
 *
 * WHY THIS FILE EXISTS SEPARATELY from the webhook test beside it. That test drives
 * the real HTTP route and proves the two handlers behave correctly end to end. This
 * one drives the shared module directly, so the properties that are ABOUT the
 * module — the fence's query shape, which statuses block and which must not, what
 * a fence read failure does, and which of the three notification outcomes each
 * record result maps to — are pinned where they live rather than only through a
 * handler that happens to exercise them.
 *
 * THE MONEY PROPERTY, IN ONE SENTENCE. `resolveManualRefundTask` writes a local
 * refund allocation on the `COMPLETED` resolution and only on that one, so a
 * `COMPLETED` `ManualRefundTask` for a capture means the club has already paid the
 * member back out of its own funds — and Stripe's refund on top of it is a second
 * payment for one capture.
 *
 * MUTATION PROOF. Change the fence's status filter to include `DISMISSED` and "a
 * DISMISSED hand resolution does NOT block" fails — that direction is the
 * symmetrical money bug, leaving the club holding a member's captured funds. Drop
 * a `reason` sentence from `automaticCancelledBookingRefundTaskReasons` and "the
 * fence is keyed on this capture" fails. Wrap the fence read in a catch and "a fence
 * read that cannot answer gives NEITHER answer" fails. Escalate any hand resolution
 * rather than `COMPLETED` only and "a DISMISSED row afterwards is the documented
 * carve-out" fails.
 */

const mocks = vi.hoisted(() => ({
  manualRefundTaskFindFirst: vi.fn(),
  bookingFindUnique: vi.fn(),
  logAudit: vi.fn(),
  recordAutomaticCancelledBookingRefundTask: vi.fn(),
  sendAdminLateCaptureAutoRefundAlert: vi.fn(),
  sendAdminLateCaptureHandBackConflictAlert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    manualRefundTask: {
      findFirst: (...args: unknown[]) => mocks.manualRefundTaskFindFirst(...args),
    },
    booking: {
      findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args),
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => mocks.logAudit(...args),
}));

vi.mock("@/lib/email", () => ({
  sendAdminLateCaptureAutoRefundAlert: (...args: unknown[]) =>
    mocks.sendAdminLateCaptureAutoRefundAlert(...args),
  sendAdminLateCaptureHandBackConflictAlert: (...args: unknown[]) =>
    mocks.sendAdminLateCaptureHandBackConflictAlert(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
  A PARTIAL mock, deliberately. Only the record writer is replaced: it opens a real
  interactive transaction under `pg_advisory_xact_lock(1)` and has its own test file
  pinning that behaviour, and what this file is about is what the epilogue DOES with
  each of its outcomes. Everything else in the module stays real — the four `reason`
  sentences (which are the idempotency key and the card's operator-facing text) and
  the fence read itself, which runs against the prisma double above. Mocking those
  would leave the fence's query shape and the key's contents unasserted, which is
  most of the money-critical surface here.
*/
vi.mock("@/lib/deleted-booking-modification-payment", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/deleted-booking-modification-payment")
    >();
  return {
    ...actual,
    recordAutomaticCancelledBookingRefundTask: (...args: unknown[]) =>
      mocks.recordAutomaticCancelledBookingRefundTask(...args),
  };
});

import {
  announceAutomaticLateCaptureRefund,
  recordAutomaticLateCaptureRefund,
  reportWithheldLateCaptureRefund,
  type CancelledBookingLateCapture,
} from "@/lib/cancelled-booking-late-capture";
import {
  automaticCancelledBookingRefundTaskReasons,
  cancelledBookingModificationRefundReason,
  cancelledBookingPrimaryPaymentRefundReason,
  deletedBookingModificationRefundReason,
  deletedBookingPrimaryPaymentRefundReason,
  findCompletedHandBackForLateCapture,
} from "@/lib/deleted-booking-modification-payment";

const INTENT_ID = "pi_late";

function capture(
  overrides: Partial<CancelledBookingLateCapture> = {},
): CancelledBookingLateCapture {
  return {
    bookingId: "booking-1",
    paymentId: "payment-1",
    paymentIntentId: INTENT_ID,
    amountCents: 2500,
    memberName: "Alice Example",
    checkIn: new Date("2026-08-01"),
    checkOut: new Date("2026-08-03"),
    openingDeletedAt: null,
    captureKind: "modification",
    ...overrides,
  };
}

const HAND_BACK = {
  id: "task-hand-completed",
  amountCents: 2500,
  completedAt: new Date("2026-07-28"),
  completedByMemberId: "member-operator",
};

function auditRow(action: string) {
  return mocks.logAudit.mock.calls
    .map((call) => call[0] as { action: string; details?: string })
    .find((row) => row.action === action);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.manualRefundTaskFindFirst.mockResolvedValue(null);
  mocks.bookingFindUnique.mockResolvedValue({ deletedAt: null });
  mocks.recordAutomaticCancelledBookingRefundTask.mockResolvedValue({
    closed: 0,
    created: true,
    alreadyRecorded: false,
    existingStatus: null,
  });
  mocks.sendAdminLateCaptureAutoRefundAlert.mockResolvedValue(undefined);
  mocks.sendAdminLateCaptureHandBackConflictAlert.mockResolvedValue(undefined);
});

describe("the four reason sentences (#2773)", () => {
  it("says which payment it was, so the finance card does not print a false sentence", () => {
    // The modification sentences open "Booking modification payment …", which is
    // simply untrue about a booking's own payment — and `reason` is stored on the
    // row AND printed on the read-only card an operator reads.
    expect(deletedBookingModificationRefundReason(INTENT_ID)).toContain(
      "Booking modification payment",
    );
    expect(deletedBookingPrimaryPaymentRefundReason(INTENT_ID)).toContain(
      "The booking's own payment",
    );
    expect(deletedBookingPrimaryPaymentRefundReason(INTENT_ID)).not.toContain(
      "modification",
    );
  });

  it("distinguishes both populations within each capture kind", () => {
    expect(deletedBookingPrimaryPaymentRefundReason(INTENT_ID)).toContain(
      "already deleted",
    );
    expect(cancelledBookingPrimaryPaymentRefundReason(INTENT_ID)).toContain(
      "already cancelled",
    );
  });

  it("carries the payment intent id in every sentence, because that is the key", () => {
    // `bookingId + paymentId + reason` IS the idempotency key. A sentence without
    // the intent id would collapse two captures on one booking into one row.
    for (const reason of automaticCancelledBookingRefundTaskReasons(INTENT_ID)) {
      expect(reason).toContain(INTENT_ID);
    }
  });

  it("lists all four sentences, and they are all distinct", () => {
    const reasons = automaticCancelledBookingRefundTaskReasons(INTENT_ID);
    expect(reasons).toHaveLength(4);
    expect(new Set(reasons).size).toBe(4);
    expect(reasons).toEqual(
      expect.arrayContaining([
        deletedBookingModificationRefundReason(INTENT_ID),
        cancelledBookingModificationRefundReason(INTENT_ID),
        deletedBookingPrimaryPaymentRefundReason(INTENT_ID),
        cancelledBookingPrimaryPaymentRefundReason(INTENT_ID),
      ]),
    );
  });

  it("fits the column, so nothing is silently truncated mid-key", () => {
    for (const reason of automaticCancelledBookingRefundTaskReasons(INTENT_ID)) {
      expect(reason.length).toBeLessThanOrEqual(500);
    }
  });
});

describe("findCompletedHandBackForLateCapture (#2774 — the fence)", () => {
  it("looks for a COMPLETED row only", async () => {
    /*
      COMPLETED is the one resolution that writes `applyLocalRefundAllocation` —
      the ledger saying the club paid the member back. Nothing else means the money
      has already gone.
    */
    await findCompletedHandBackForLateCapture({
      bookingId: "booking-1",
      paymentId: "payment-1",
      paymentIntentId: INTENT_ID,
    });

    const [args] = mocks.manualRefundTaskFindFirst.mock.calls[0] as [
      { where: { status: string } },
    ];
    expect(args.where.status).toBe("COMPLETED");
  });

  it("returns nothing for a DISMISSED or OPEN row, and that direction is the symmetrical money bug", async () => {
    /*
      Evaluated against a tiny stand-in table rather than by re-reading the query's
      shape, so it fails on a fence whose shape is fine and whose semantics have
      drifted.

      DISMISSED means "settled another way" and writes NO allocation, so blocking on
      it would leave the club holding a member's captured funds while the audit log
      claimed the matter was closed. OPEN is the confirm route's unanswered question
      and the refund is the answer. Only COMPLETED means the club has already paid.
    */
    const table = [
      { status: "OPEN", id: "task-open" },
      { status: "DISMISSED", id: "task-dismissed" },
    ];
    mocks.manualRefundTaskFindFirst.mockImplementation(
      async (args: { where: { status: string } }) =>
        table.find((row) => row.status === args.where.status) ?? null,
    );

    await expect(
      findCompletedHandBackForLateCapture({
        bookingId: "booking-1",
        paymentId: "payment-1",
        paymentIntentId: INTENT_ID,
      }),
    ).resolves.toBeNull();

    // ...and the same table WITH a completed row does block.
    table.push({ status: "COMPLETED", id: "task-completed" });
    await expect(
      findCompletedHandBackForLateCapture({
        bookingId: "booking-1",
        paymentId: "payment-1",
        paymentIntentId: INTENT_ID,
      }),
    ).resolves.toMatchObject({ id: "task-completed" });
  });

  it("is keyed on this capture, not on the booking and payment alone", async () => {
    /*
      `booking-cancel.ts` raises its own ManualRefundTask on the same booking and
      payment when a CASH-settled booking is cancelled — for the cancellation
      policy's share of the ORIGINAL payment, a different sum about different
      money. An operator completing THAT one has not handed this capture back, and
      a fence matching it would refuse to return a member's late capture.
    */
    await findCompletedHandBackForLateCapture({
      bookingId: "booking-1",
      paymentId: "payment-1",
      paymentIntentId: INTENT_ID,
    });

    const [args] = mocks.manualRefundTaskFindFirst.mock.calls[0] as [
      {
        where: {
          bookingId: string;
          paymentId: string;
          reason: { in: string[] };
        };
      },
    ];
    expect(args.where.bookingId).toBe("booking-1");
    expect(args.where.paymentId).toBe("payment-1");
    expect(args.where.reason.in).toEqual(
      automaticCancelledBookingRefundTaskReasons(INTENT_ID),
    );
  });

  it("a fence read that cannot answer gives NEITHER answer", async () => {
    /*
      Refunding twice and never refunding at all are both bad. The rejection
      propagates so the webhook answers 500, the processed-event marker is cleared
      and Stripe redelivers against the same idempotent refund keys — so a
      redelivery that reaches a working database refunds exactly once. Catching this
      and refunding reopens the double payment; catching it and returning 200 leaves
      the capture unrefunded for good, because Stripe never redelivers a 200.
    */
    mocks.manualRefundTaskFindFirst.mockRejectedValueOnce(
      new Error("database is down"),
    );

    await expect(
      findCompletedHandBackForLateCapture({
        bookingId: "booking-1",
        paymentId: "payment-1",
        paymentIntentId: INTENT_ID,
      }),
    ).rejects.toThrow("database is down");
  });
});

describe("reportWithheldLateCaptureRefund (#2774 — the fenced path)", () => {
  it("audits the withholding as its own action, never as a refund", async () => {
    // `booking.payment.refunded_after_cancellation` is named by the finance card
    // and the payments guide as the permanent record of an automatic refund. No
    // refund happened here, so writing it would put a money movement that did not
    // occur into the club's permanent record.
    await reportWithheldLateCaptureRefund({
      capture: capture(),
      handBack: HAND_BACK,
    });

    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.payment.late_capture_refund_withheld",
        category: "payment",
        severity: "critical",
        outcome: "blocked",
        entityType: "Booking",
        entityId: "booking-1",
        targetId: "booking-1",
      }),
    );
    expect(mocks.logAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.payment.refunded_after_cancellation",
      }),
    );
  });

  it("spells out in the row that the money did NOT go, and which row proves it", async () => {
    await reportWithheldLateCaptureRefund({
      capture: capture({ captureKind: "primary", amountCents: 12000 }),
      handBack: { ...HAND_BACK, amountCents: 9000 },
    });

    const row = auditRow("booking.payment.late_capture_refund_withheld");
    expect(JSON.parse(String(row?.details))).toEqual({
      paymentIntentId: INTENT_ID,
      capturedAmountCents: 12000,
      captureKind: "primary",
      manualRefundTaskId: "task-hand-completed",
      // The hand-back amount is carried so a person can see whether it covered
      // the whole capture. Nothing refunds the difference: a partial refund is a
      // new money decision.
      handBackAmountCents: 9000,
      handBackCompletedAt: "2026-07-28T00:00:00.000Z",
      handBackCompletedByMemberId: "member-operator",
      refundSent: false,
    });
  });

  it("sends the conflict alert and never the 'refunded automatically' one", async () => {
    // Exactly one notification for the event (`INV-ADDPAY-037`), and sending the
    // cheerful mail here would be the #2761 defect at the opposite polarity: a
    // subject asserting a refund that was withheld.
    await reportWithheldLateCaptureRefund({
      capture: capture({ openingDeletedAt: new Date("2026-07-01") }),
      handBack: HAND_BACK,
    });

    expect(
      mocks.sendAdminLateCaptureHandBackConflictAlert,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        refundSent: false,
        handBackAmountCents: 2500,
        bookingDeleted: true,
        captureKind: "modification",
      }),
    );
    expect(mocks.sendAdminLateCaptureAutoRefundAlert).not.toHaveBeenCalled();
  });

  it("does not re-read deletedAt, because no Stripe round trip happened", async () => {
    // There is no window for the population to have changed under us on this path.
    await reportWithheldLateCaptureRefund({
      capture: capture(),
      handBack: HAND_BACK,
    });
    expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
  });
});

describe("recordAutomaticLateCaptureRefund (#2773 — the record)", () => {
  it("re-reads deletedAt after the Stripe round trip and stores what it finds", async () => {
    // An admin deleting the booking while the refund was in flight would otherwise
    // store "cancelled, still on file" and mail "normally nothing to do" for the one
    // population that needs a person.
    mocks.bookingFindUnique.mockResolvedValueOnce({
      deletedAt: new Date("2026-07-30"),
    });

    const outcome = await recordAutomaticLateCaptureRefund(capture());

    expect(outcome.bookingDeleted).toBe(true);
    expect(
      mocks.recordAutomaticCancelledBookingRefundTask,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ bookingDeleted: true, captureKind: "modification" }),
    );
  });

  it("skips the re-read when the opening read already saw a deletion", async () => {
    // Deletion is one-way (`INV-ADDPAY-030`), so the two reads can disagree in only
    // one direction and a known deletion cannot be undone by a fresh read.
    const outcome = await recordAutomaticLateCaptureRefund(
      capture({ openingDeletedAt: new Date("2026-07-01") }),
    );

    expect(outcome.bookingDeleted).toBe(true);
    expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
  });

  it("falls back to the opening read when the re-read throws, rather than losing the row", async () => {
    // The money is already back with the member; a 500 would replay the whole
    // refund path for one adjective. The stale value can only ever be the LESS
    // alarming of the two.
    mocks.bookingFindUnique.mockRejectedValueOnce(new Error("read timeout"));

    const outcome = await recordAutomaticLateCaptureRefund(capture());

    expect(outcome.bookingDeleted).toBe(false);
    expect(mocks.recordAutomaticCancelledBookingRefundTask).toHaveBeenCalled();
  });

  it("passes the capture kind through, so each path stores its own sentence", async () => {
    await recordAutomaticLateCaptureRefund(capture({ captureKind: "primary" }));
    expect(
      mocks.recordAutomaticCancelledBookingRefundTask,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ captureKind: "primary", amountCents: 2500 }),
    );
  });

  it("writes a CRITICAL audit row when the record write is lost, and does not throw", async () => {
    /*
      The caller must answer 200 — the money is back with the member and a 500
      replays the refund path — so Stripe never redelivers and NOTHING else in the
      tree ever writes that row. `INV-ADDPAY-037`'s second named exception: the audit
      entry is the only surface a lost record appears on.
    */
    mocks.recordAutomaticCancelledBookingRefundTask.mockRejectedValueOnce(
      new Error("P2028 transaction timed out"),
    );

    const outcome = await recordAutomaticLateCaptureRefund(capture());

    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.payment.auto_refund_record_failed",
        category: "payment",
        severity: "critical",
        outcome: "failure",
        entityId: "booking-1",
      }),
    );
    // And it reports NO conflict: the writer is the only thing that reads the row's
    // status, so when it throws nothing is known about a hand-back either way.
    expect(outcome.handCompletedAfterRefund).toBe(false);
  });

  it("reports a hand-COMPLETED row found after the refund", async () => {
    mocks.recordAutomaticCancelledBookingRefundTask.mockResolvedValueOnce({
      closed: 0,
      created: false,
      alreadyRecorded: "hand-resolved",
      existingStatus: "COMPLETED",
    });

    const outcome = await recordAutomaticLateCaptureRefund(capture());
    expect(outcome.handCompletedAfterRefund).toBe(true);
  });

  it("does NOT report a hand-DISMISSED row, which is the documented carve-out", async () => {
    // #2774 D1 keeps it - the orchestrator's call, not the owner's. No allocation
    // exists, nothing was paid twice, and the only consequence is that the refund
    // reaches no finance card.
    mocks.recordAutomaticCancelledBookingRefundTask.mockResolvedValueOnce({
      closed: 0,
      created: false,
      alreadyRecorded: "hand-resolved",
      existingStatus: "DISMISSED",
    });

    const outcome = await recordAutomaticLateCaptureRefund(capture());
    expect(outcome.handCompletedAfterRefund).toBe(false);
  });
});

describe("announceAutomaticLateCaptureRefund (#2773 / #2774 — one notification)", () => {
  it("sends the auto-refund alert on the ordinary outcome", async () => {
    await announceAutomaticLateCaptureRefund(capture({ captureKind: "primary" }), {
      bookingDeleted: false,
      handCompletedAfterRefund: false,
    });

    expect(mocks.sendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        bookingDeleted: false,
        captureKind: "primary",
        amountCents: 2500,
      }),
    );
    expect(
      mocks.sendAdminLateCaptureHandBackConflictAlert,
    ).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it("sends the population the record stored, not the opening read", async () => {
    // So the row's sentence, the subject and the card's grouping cannot disagree.
    await announceAutomaticLateCaptureRefund(capture(), {
      bookingDeleted: true,
      handCompletedAfterRefund: false,
    });
    expect(mocks.sendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledWith(
      expect.objectContaining({ bookingDeleted: true }),
    );
  });

  it("swaps to the conflict alert, with a CRITICAL audit row, on a suspected double payment", async () => {
    await announceAutomaticLateCaptureRefund(capture(), {
      bookingDeleted: false,
      handCompletedAfterRefund: true,
    });

    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.payment.late_capture_double_refund_suspected",
        category: "payment",
        severity: "critical",
        outcome: "failure",
        entityId: "booking-1",
      }),
    );
    const row = auditRow("booking.payment.late_capture_double_refund_suspected");
    expect(JSON.parse(String(row?.details))).toMatchObject({ refundSent: true });
    expect(
      mocks.sendAdminLateCaptureHandBackConflictAlert,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ refundSent: true, handBackAmountCents: null }),
    );
    // ONE notification for the event: never both, and never the cheerful one on
    // its own, which would be a lie by omission about money leaving twice.
    expect(mocks.sendAdminLateCaptureAutoRefundAlert).not.toHaveBeenCalled();
  });
});
