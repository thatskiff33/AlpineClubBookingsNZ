import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingEventType,
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
  PaymentSource,
} from "@prisma/client";

/**
 * B5 (#2262) guard 4 — the cash hand-back task.
 *
 * A cancelled cash-settled booking has no card charge to reverse and no Xero
 * invoice to credit, so the cancellation raises a durable task rather than a
 * silent $0 refund. Completing the task is the ONLY moment the ledger records
 * that money went back.
 */

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  manualRefundTaskFindUnique: vi.fn(),
  manualRefundTaskUpdateMany: vi.fn(),
  memberCreditFindUnique: vi.fn(),
  applyLocalRefundAllocation: vi.fn(),
  createAuditLog: vi.fn(),
  recordBookingEvent: vi.fn(),
  // #3032: the two canonical settlement paths a confirmed review amount is
  // routed down. Mocked rather than exercised here - each has its own suite -
  // so these tests assert WHICH path was taken and with what, which is the
  // decision this module owns.
  createBookingModificationCredit: vi.fn(),
  // #3032: the card route is no longer one opaque helper. The completion freezes
  // the allocation and persists the refund DEBT inside its own transaction, then
  // executes exactly those slices after the commit - booking-cancel's #1349
  // pattern - so the four steps are mocked separately and their ORDER is what
  // several of the tests below assert.
  planStripeRefundAllocation: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  enqueueEditFinancialReviewRefundRecovery: vi.fn(),
  markEditFinancialReviewRefundRecoverySucceeded: vi.fn(),
  queueXeroBookingEditSettlement: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: (...a: unknown[]) => mocks.transaction(...a) },
}));
vi.mock("@/lib/payment-transactions", () => ({
  applyLocalRefundAllocation: (...a: unknown[]) =>
    mocks.applyLocalRefundAllocation(...a),
  planStripeRefundAllocation: (...a: unknown[]) =>
    mocks.planStripeRefundAllocation(...a),
  refundPaymentTransactions: (...a: unknown[]) =>
    mocks.refundPaymentTransactions(...a),
  // The real class, re-declared: the module under test compares with
  // `instanceof` against this same mocked module, so the identity matches.
  RefundAllocationRacedError: class RefundAllocationRacedError extends Error {},
}));
vi.mock("@/lib/payment-recovery", () => ({
  // Pure and shared with the recovery replay (#1507), so it is reproduced rather
  // than stubbed - a test that let the metadata drift would pass while a real
  // replay hit `idempotency_error`.
  buildBookingModificationRefundMetadata: (bookingId: string, reason: string) => ({
    bookingId,
    reason,
  }),
  enqueueEditFinancialReviewRefundRecovery: (...a: unknown[]) =>
    mocks.enqueueEditFinancialReviewRefundRecovery(...a),
  markEditFinancialReviewRefundRecoverySucceeded: (...a: unknown[]) =>
    mocks.markEditFinancialReviewRefundRecoverySucceeded(...a),
}));
vi.mock("@/lib/xero-booking-edit-settlement", () => ({
  queueXeroBookingEditSettlement: (...a: unknown[]) =>
    mocks.queueXeroBookingEditSettlement(...a),
}));
vi.mock("@/lib/audit", () => ({
  createAuditLog: (...a: unknown[]) => mocks.createAuditLog(...a),
}));
vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: (...a: unknown[]) => mocks.recordBookingEvent(...a),
}));
vi.mock("@/lib/payment-reconciliation", () => ({
  ManualBookingPaymentError: class ManualBookingPaymentError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.name = "ManualBookingPaymentError";
      this.status = status;
    }
  },
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/member-credit", () => ({
  createBookingModificationCredit: (...a: unknown[]) =>
    mocks.createBookingModificationCredit(...a),
}));

import { resolveManualRefundTask } from "@/lib/manual-refund-task-resolution";
// NOT mocked: the Stripe key prefix is the exactly-once boundary this suite is
// about, so it is asserted against the real builder rather than a stub that
// could agree with a wrong caller.
import { buildEditFinancialReviewRefundStripeKeyPrefix } from "@/lib/payment-recovery-keys";

const tx = {
  manualRefundTask: {
    findUnique: (...a: unknown[]) => mocks.manualRefundTaskFindUnique(...a),
    updateMany: (...a: unknown[]) => mocks.manualRefundTaskUpdateMany(...a),
  },
  // #3032: the anchor-taken check (owner decision D-3032-1) reads this inside
  // the same transaction, before the claim.
  memberCredit: {
    findUnique: (...a: unknown[]) => mocks.memberCreditFindUnique(...a),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(
    async (fn: (store: typeof tx) => Promise<unknown>) => fn(tx)
  );
  mocks.manualRefundTaskFindUnique.mockResolvedValue({
    id: "task-1",
    bookingId: "booking-1",
    paymentId: "payment-1",
    amountCents: 9000,
    raisedAmountCents: 9000,
    kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK,
    status: ManualRefundTaskStatus.OPEN,
    // #3032: the completion reads the booking's own status and its primary Xero
    // invoice id so it can queue the credit note. A legacy hand-back carries
    // neither route nor anchor, so nothing is queued for it - which is what the
    // legacy test below pins.
    booking: { memberId: "member-1", status: "CANCELLED", payment: null },
  });
  mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 1 });
  // The anchor is free unless a test says otherwise.
  mocks.memberCreditFindUnique.mockResolvedValue(null);
  // #3032 card-route defaults: plenty of captured headroom, one slice, and a
  // refund that issues. Every case that cares overrides one of these.
  mocks.planStripeRefundAllocation.mockResolvedValue({
    slices: [{ paymentTransactionId: "txn-1", amountCents: 7300 }],
    plannedAmountCents: 7300,
    totalRefundableCents: 50000,
  });
  mocks.refundPaymentTransactions.mockResolvedValue({
    refunds: [{ paymentIntentId: "pi_1", refundId: "re_test", amountCents: 7300 }],
    totalRefundedAmountCents: 7300,
  });
  mocks.enqueueEditFinancialReviewRefundRecovery.mockResolvedValue({ id: "rec-1" });
  mocks.markEditFinancialReviewRefundRecoverySucceeded.mockResolvedValue({ count: 1 });
  // The real dispatcher answers with the classification PLUS what the accounting
  // ask did about it (#3170 fix round, F2). Every fixture here is a REFUND, which
  // queues a credit note rather than a supplementary invoice.
  mocks.queueXeroBookingEditSettlement.mockResolvedValue({
    supplementaryInvoice: "none",
  });
});

describe("resolveManualRefundTask", () => {
  it("completing writes the ledger allocation and the REFUNDED booking event — that is when the money is recorded as returned", async () => {
    await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: "cash handed back",
      actingMemberId: "admin-1",
      confirmedAmountCents: null,
      direction: "REFUND_TO_MEMBER",
    });

    expect(mocks.applyLocalRefundAllocation).toHaveBeenCalledWith({
      paymentId: "payment-1",
      amountCents: 9000,
      store: tx,
    });
    expect(mocks.recordBookingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        type: "REFUNDED",
        amountCents: 9000,
        reason: "manual_refund_completed",
      })
    );
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-payment.manual-refund-task.complete",
        category: "payment",
      }),
      tx
    );
  });

  it("dismissing moves no money and writes no allocation or refund event", async () => {
    await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "dismissed",
      note: "member asked us to keep it",
      actingMemberId: "admin-1",
    });

    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-payment.manual-refund-task.dismiss",
      }),
      tx
    );
  });

  it("requires a note to dismiss, so the record still makes sense later", async () => {
    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "dismissed",
        note: "   ",
        actingMemberId: "admin-1",
      })
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
  });

  it("closes the OPEN -> terminal transition behind a status fence, so a double click cannot double-apply the allocation", async () => {
    mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "completed",
        note: null,
        actingMemberId: "admin-1",
        confirmedAmountCents: null,
        direction: "REFUND_TO_MEMBER",
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
    expect(mocks.manualRefundTaskUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1", status: ManualRefundTaskStatus.OPEN },
      })
    );
  });

  it("409s on an already-closed task", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue({
      id: "task-1",
      bookingId: "booking-1",
      paymentId: "payment-1",
      amountCents: 9000,
      raisedAmountCents: 9000,
      kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK,
      status: ManualRefundTaskStatus.COMPLETED,
      booking: { memberId: "member-1" },
    });

    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "completed",
        note: null,
        actingMemberId: "admin-1",
        confirmedAmountCents: null,
        direction: "REFUND_TO_MEMBER",
      })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("404s on a task that does not exist", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(null);

    await expect(
      resolveManualRefundTask({
        taskId: "nope",
        resolution: "completed",
        note: null,
        actingMemberId: "admin-1",
        confirmedAmountCents: null,
        direction: "REFUND_TO_MEMBER",
      })
    ).rejects.toMatchObject({ status: 404 });
  });
});

/**
 * #3030 (epic #2797, owner decision D2): pricing and amending the amount AT
 * COMPLETION, and proving that a confirmation cannot apply twice.
 *
 * The state under test is the one the epic exists to create: an OPEN task whose
 * amount is genuinely unknown. What these tests must not let through is any path
 * that turns "not yet known" into a number nobody confirmed - whether that
 * number is a magic zero, a stale figure from a previous screen, or the same
 * confirmed figure applied a second time.
 */
function editReviewTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    bookingId: "booking-1",
    paymentId: "payment-1",
    amountCents: null,
    raisedAmountCents: null,
    kind: ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW,
    status: ManualRefundTaskStatus.OPEN,
    // #3032: internet banking by default, so the base fixture keeps taking the
    // ledger-mirror route the pre-#3032 tests below assert. The Stripe cases opt
    // in explicitly.
    payment: { source: PaymentSource.INTERNET_BANKING },
    reviewContext: reviewContext(),
    booking: { memberId: "member-1", status: "PAID", payment: null },
    ...overrides,
  };
}

/**
 * #3032: a `reviewContext` the real parser accepts. It has to be the real shape,
 * not a stub - `resolveManualRefundTask` reads the anchor back through
 * `parseEditFinancialReviewContext`, which is a whole-object strict parse, so a
 * half-built blob would silently read as "no anchor" and every settlement test
 * would pass for the wrong reason.
 */
function reviewContext(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    occurrence: {
      bookingId: "booking-1",
      bookingGuestId: "guest-1",
      cause: "NO_STORED_NIGHT_PRICES",
      surrenderedNightDates: ["2026-08-01"],
      addedNightDates: [],
      storedEvidence: { guestTotalCents: null, nightPrices: [] },
    },
    guestMemberId: "member-1",
    bookingCheckIn: "2026-08-01",
    bookingCheckOut: "2026-08-04",
    bookingModificationId: "mod-1",
    ...overrides,
  };
}

describe("#3030 - pricing an unknown amount at completion", () => {
  it("prices an OPEN task that had no amount, writing the confirmed figure inside the same status-guarded claim as the status", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(editReviewTask());

    const result = await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: "Priced from the June invoice: two nights at $45.",
      actingMemberId: "admin-1",
      confirmedAmountCents: 9000,
      direction: "REFUND_TO_MEMBER",
    });

    // The amount and the terminal status are ONE write. That is what makes a
    // duplicate confirmation impossible: there is no window in which the task is
    // priced but not yet closed.
    expect(mocks.manualRefundTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: ManualRefundTaskStatus.OPEN },
      data: expect.objectContaining({
        status: ManualRefundTaskStatus.COMPLETED,
        amountCents: 9000,
        completedByMemberId: "admin-1",
      }),
    });
    expect(mocks.applyLocalRefundAllocation).toHaveBeenCalledWith({
      paymentId: "payment-1",
      amountCents: 9000,
      store: tx,
    });
    expect(result.amountCents).toBe(9000);
    expect(result.amountAmended).toBe(false);
  });

  it("refuses to complete an unpriced task when the caller claims it already has its final amount - the unknown is NOT zero", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(editReviewTask());

    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "completed",
        note: "closing it",
        actingMemberId: "admin-1",
        confirmedAmountCents: null,
        direction: "REFUND_TO_MEMBER",
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
  });

  it("dismissing an unpriced task writes NO amount at all, rather than a zero another reader would take for a decision", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(editReviewTask());

    await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "dismissed",
      note: "Reviewed against the 2024 ledger: nothing is owed.",
      actingMemberId: "admin-1",
    });

    const data = mocks.manualRefundTaskUpdateMany.mock.calls[0][0].data;
    expect(data.status).toBe(ManualRefundTaskStatus.DISMISSED);
    expect("amountCents" in data).toBe(false);
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
  });

  it("requires a note when completing a financial review, because the admin is pricing real money from evidence", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(editReviewTask());

    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "completed",
        note: "  ",
        actingMemberId: "admin-1",
        confirmedAmountCents: 4200,
        direction: "REFUND_TO_MEMBER",
      })
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses a confirmed amount that is not non-negative whole cents", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(editReviewTask());

    for (const bad of [-1, 12.5, Number.NaN]) {
      await expect(
        resolveManualRefundTask({
          taskId: "task-1",
          resolution: "completed",
          note: "priced",
          actingMemberId: "admin-1",
          confirmedAmountCents: bad,
          direction: "REFUND_TO_MEMBER",
        })
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
  });

  it("MUTATION: settles a credit-only task as account credit, and never as a refund it did not make", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({ paymentId: null })
    );

    const result = await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: "Credited to the member account.",
      actingMemberId: "admin-1",
      confirmedAmountCents: 4500,
      direction: "REFUND_TO_MEMBER",
    });

    // There is nothing to allocate a refund against, and inventing a payment
    // link to satisfy the model is exactly what owner decision D2 removed.
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
    expect(result.amountCents).toBe(4500);

    // #3032: the money now genuinely moves, down the canonical account-credit
    // path, keyed on the ORIGINAL edit's BookingModification (D-3032-1). Before
    // this issue the completion closed the task and moved nothing at all.
    expect(mocks.createBookingModificationCredit).toHaveBeenCalledWith(
      "member-1",
      4500,
      "booking-1",
      "mod-1",
      undefined,
      tx,
      // The booking has no captured payment in this fixture, so there is nothing
      // to write a refund allocation against.
      undefined
    );

    // CREDITED, not REFUNDED. `booking-narrative.ts` turns the first
    // REFUNDED/CREDITED event into the sentence the member reads, so calling
    // this a refund would tell them money went back to a card that was never
    // charged. Written AFTER the commit, where the money moved.
    expect(mocks.recordBookingEvent).toHaveBeenCalledTimes(1);
    expect(mocks.recordBookingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        type: BookingEventType.CREDITED,
        amountCents: 4500,
      })
    );
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-payment.manual-refund-task.complete",
        metadata: expect.objectContaining({
          amountCents: 4500,
          settlementRoute: "account-credit",
          settlementBookingModificationId: "mod-1",
        }),
      }),
      tx
    );
  });

  it("MUTATION: refuses to COMPLETE at zero and points the operator at dismissal instead", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(editReviewTask());

    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "completed",
        note: "Nothing turned out to be owed.",
        actingMemberId: "admin-1",
        confirmedAmountCents: 0,
        direction: "REFUND_TO_MEMBER",
      })
    ).rejects.toMatchObject({ status: 400 });

    // COMPLETED at 0 would write `amountCents = 0` and a $0.00 REFUNDED booking
    // event, which `booking-narrative.ts` selects by TYPE without filtering on
    // amount - shadowing any genuine later settlement event. "Reviewed, nothing
    // is due" is DISMISSED; magic zero is what this epic exists to remove.
    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
  });

  it("refuses to complete at zero even when the ZERO came from the task's own stored amount rather than the operator", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({ amountCents: 0, raisedAmountCents: 0 })
    );

    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "completed",
        note: "closing it",
        actingMemberId: "admin-1",
        confirmedAmountCents: null,
        direction: "REFUND_TO_MEMBER",
      })
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
  });

  it("tells the operator when the confirmed amount exceeds what was ever captured, instead of logging a 500 for a correct refusal", async () => {
    // Newly reachable: before #3030 the amount always came from cancellation or
    // capture policy and could not exceed the capture. `applyLocalRefundAllocation`
    // throws a plain Error, which the route's `instanceof ManualBookingPaymentError`
    // check misses - so the operator saw "Could not close the refund task" and
    // monitoring recorded a server fault for working code. The cap itself is
    // untouched: the allocation still refuses and the transaction still rolls back.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(editReviewTask());
    mocks.applyLocalRefundAllocation.mockRejectedValueOnce(
      new Error("Refund amount exceeds captured payments")
    );

    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "completed",
        note: "priced at 900",
        actingMemberId: "admin-1",
        confirmedAmountCents: 90000,
        direction: "REFUND_TO_MEMBER",
      })
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
  });

  it("does not disguise some OTHER allocation failure as an operator input error", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(editReviewTask());
    mocks.applyLocalRefundAllocation.mockRejectedValueOnce(
      new Error("connection reset")
    );

    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "completed",
        note: "priced",
        actingMemberId: "admin-1",
        confirmedAmountCents: 9000,
        direction: "REFUND_TO_MEMBER",
      })
    ).rejects.toMatchObject({ message: "connection reset" });
  });
});

describe("#3030 - amending at completion, audited (owner decision D2)", () => {
  it("amends a financial-review amount and records what it was before, what it was raised with, and that it moved", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({ amountCents: 5000, raisedAmountCents: 5000 })
    );

    const result = await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: "The second night was comped, so $42 not $50.",
      actingMemberId: "admin-1",
      confirmedAmountCents: 4200,
      direction: "REFUND_TO_MEMBER",
    });

    expect(result.amountAmended).toBe(true);
    expect(mocks.applyLocalRefundAllocation).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 4200 })
    );
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-payment.manual-refund-task.complete",
        metadata: expect.objectContaining({
          amountCents: 4200,
          previousAmountCents: 5000,
          raisedAmountCents: 5000,
          amountAmended: true,
        }),
      }),
      tx
    );
  });

  it("refuses to rewrite a LEGACY hand-back amount at close - policy computed it, and a differing figure means a stale screen", async () => {
    // The default fixture is a CANCELLED_BOOKING_HAND_BACK at 9000.
    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "completed",
        note: "paid back 80",
        actingMemberId: "admin-1",
        confirmedAmountCents: 8000,
        direction: "REFUND_TO_MEMBER",
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
  });

  it("lets a legacy hand-back close when the amount the admin saw still matches, so the field doubles as a stale-price guard", async () => {
    const result = await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: null,
      actingMemberId: "admin-1",
      confirmedAmountCents: 9000,
      direction: "REFUND_TO_MEMBER",
    });

    expect(result.amountAmended).toBe(false);
    expect(mocks.applyLocalRefundAllocation).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 9000 })
    );
  });
});

describe("#3030 - a confirmation cannot apply twice", () => {
  it("loses the claim rather than paying twice when a second confirmation arrives, and runs no side effect at all", async () => {
    // Two admins price the same OPEN task and both submit. The first claim wins;
    // the second finds no OPEN row. What must NOT happen is the second one
    // writing its amount, its allocation, or its booking event.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(editReviewTask());
    mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "completed",
        note: "priced at 90",
        actingMemberId: "admin-2",
        confirmedAmountCents: 9000,
        direction: "REFUND_TO_MEMBER",
      })
    ).rejects.toMatchObject({ status: 409 });

    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("refuses a second confirmation of an already COMPLETED review, so a terminal occurrence stays terminal", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({
        amountCents: 9000,
        raisedAmountCents: null,
        status: ManualRefundTaskStatus.COMPLETED,
      })
    );

    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "completed",
        note: "priced again",
        actingMemberId: "admin-2",
        confirmedAmountCents: 7000,
        direction: "REFUND_TO_MEMBER",
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
  });

  it("refuses to reopen a DISMISSED review, which is a real decision and not an absence of one", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({ status: ManualRefundTaskStatus.DISMISSED })
    );

    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "completed",
        note: "actually we do owe them",
        actingMemberId: "admin-2",
        confirmedAmountCents: 3000,
        direction: "REFUND_TO_MEMBER",
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
  });
});

describe("#2262 guard 4 — no third PaymentSource member", () => {
  it("PaymentSource stays exactly STRIPE | INTERNET_BANKING", () => {
    expect(Object.keys(PaymentSource).sort()).toEqual([
      "INTERNET_BANKING",
      "STRIPE",
    ]);
  });
});

describe("#2262 guard 3 — the self-match refutation, pinned", () => {
  it("upsertPaymentIntentTransaction hardcodes source STRIPE on BOTH arms, so the widened duplicate-capture predicate's non-Stripe arm can never match the row a Stripe settlement just wrote", async () => {
    // The widened predicate's non-Stripe OR arm carries NO arriving-row
    // exclusion. It cannot self-match, because the probe filters
    // PaymentTransaction.source and this writer hardcodes STRIPE. Pinned here
    // so a future "derive the source from the payment" refactor fails loudly
    // instead of quietly making a Stripe capture refund itself.
    const upsert = vi.fn().mockResolvedValue(undefined);
    const { upsertPaymentIntentTransaction } = await vi.importActual<
      typeof import("@/lib/payment-transactions")
    >("@/lib/payment-transactions");

    await upsertPaymentIntentTransaction({
      paymentId: "payment-1",
      kind: "PRIMARY",
      paymentIntentId: "pi_1",
      amountCents: 1000,
      status: "SUCCEEDED",
      store: {
        paymentTransaction: { upsert },
        payment: { update: vi.fn() },
      } as never,
    }).catch(() => {
      // reconcilePaymentAggregates runs against the same stub and is not the
      // subject of this pin; the upsert shape below is.
    });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ source: PaymentSource.STRIPE }),
        update: expect.objectContaining({ source: PaymentSource.STRIPE }),
      })
    );
  });
});

/**
 * #3032 (epic #2797): where a confirmed review amount actually goes, and the two
 * ways that can be refused.
 *
 * Every test here asserts the ROUTE and its arguments rather than re-testing the
 * three settlement functions themselves - each of those has its own suite, and
 * duplicating them here would prove nothing about the decision this module makes.
 * What this module owns is: which path, with which anchor, in which order
 * relative to the status claim, and what is refused before anything is written.
 */
describe("#3032 - routing a confirmed review amount through canonical settlement", () => {
  it("refunds a card-paid review through the canonical Stripe path, keyed to the TASK", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({ payment: { source: PaymentSource.STRIPE } })
    );

    const result = await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: "Priced from the June card receipt.",
      actingMemberId: "admin-1",
      confirmedAmountCents: 7300,
      direction: "REFUND_TO_MEMBER",
    });

    // NOT a second ledger write. `refundPaymentTransactions` increments
    // `refundedAmountCents` itself, so an `applyLocalRefundAllocation` here as
    // well would consume the refundable headroom twice for one refund.
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
    expect(mocks.createBookingModificationCredit).not.toHaveBeenCalled();

    expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "payment-1",
        amountCents: 7300,
        // TASK-scoped, not modification-scoped. One edit can raise TWO reviews
        // against one `BookingModification` (D-3032-1), so a modification-scoped
        // prefix would give two same-amount refunds the same per-slice key -
        // Stripe would answer the second with the FIRST refund and this code
        // would take the replayed id as success.
        idempotencyKeyPrefix:
          buildEditFinancialReviewRefundStripeKeyPrefix("task-1"),
        // The slices frozen inside the transaction, replayed verbatim.
        allocation: [{ paymentTransactionId: "txn-1", amountCents: 7300 }],
        metadata: { bookingId: "booking-1", reason: "edit_financial_review" },
      })
    );
    expect(result.stripeRefundId).toBe("re_test");
    expect(mocks.markEditFinancialReviewRefundRecoverySucceeded).toHaveBeenCalledWith(
      { taskId: "task-1" }
    );
    expect(mocks.recordBookingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: BookingEventType.REFUNDED,
        amountCents: 7300,
        reason: "edit_financial_review_completed",
      })
    );
  });

  it("persists the refund debt INSIDE the transaction, before Stripe is called", async () => {
    // The crash-safety property. The completion holds no advisory lock, so the
    // claim commits before the provider call; without a durable row a death in
    // that window leaves a COMPLETED task, an untouched `refundedAmountCents` and
    // no trace that money was owed. booking-cancel solves this on the same
    // infrastructure (#1349) and this is the same arrangement.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({ payment: { source: PaymentSource.STRIPE } })
    );

    await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: "Priced from the June card receipt.",
      actingMemberId: "admin-1",
      confirmedAmountCents: 7300,
      direction: "REFUND_TO_MEMBER",
    });

    expect(mocks.enqueueEditFinancialReviewRefundRecovery).toHaveBeenCalledWith({
      bookingId: "booking-1",
      paymentId: "payment-1",
      // The anchor is the TASK, so two reviews of one edit cannot upsert each
      // other's row - that upsert overwrites `amountCents` and `stripeKeyPrefix`,
      // so a partially-processed refund would replay at the wrong figure under a
      // different key.
      taskId: "task-1",
      amountCents: 7300,
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 7300 }],
      // On the CALLER'S transaction: the debt and the claim commit together or
      // neither does.
      store: tx,
    });
    expect(
      mocks.enqueueEditFinancialReviewRefundRecovery.mock
        .invocationCallOrder[0]
    ).toBeLessThan(
      mocks.refundPaymentTransactions.mock.invocationCallOrder[0]
    );
  });

  it("MUTATION: records no REFUNDED event when the Stripe refund did not issue", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({ payment: { source: PaymentSource.STRIPE } })
    );
    mocks.refundPaymentTransactions.mockRejectedValue(new Error("card_declined"));

    const result = await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: "Priced from the June card receipt.",
      actingMemberId: "admin-1",
      confirmedAmountCents: 7300,
      direction: "REFUND_TO_MEMBER",
    });

    // The task IS closed - the claim committed - but the member is not told
    // their money came back while it is still in the club's account. The
    // persisted recovery operation is what eventually moves it, so it is
    // deliberately NOT closed as succeeded here.
    expect(result.status).toBe(ManualRefundTaskStatus.COMPLETED);
    expect(result.stripeRefundId).toBeNull();
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
    expect(
      mocks.markEditFinancialReviewRefundRecoverySucceeded
    ).not.toHaveBeenCalled();
  });

  it("MUTATION: refuses a card amount larger than the capture BEFORE it claims the task", async () => {
    // The failure this replaces was silent and total: the cap lived only inside
    // `refundPaymentTransactions`, which runs AFTER the commit, so an over-cap
    // amount left the task permanently COMPLETED with nothing moved and the
    // operator was told "Refund recorded as paid back by hand".
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({ payment: { source: PaymentSource.STRIPE } })
    );
    mocks.planStripeRefundAllocation.mockResolvedValue({
      slices: [{ paymentTransactionId: "txn-1", amountCents: 5000 }],
      plannedAmountCents: 5000,
      totalRefundableCents: 5000,
    });

    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "completed",
        note: "Priced from the June card receipt.",
        actingMemberId: "admin-1",
        confirmedAmountCents: 7300,
        direction: "REFUND_TO_MEMBER",
      })
    ).rejects.toMatchObject({ status: 400 });

    // Nothing was claimed, so the task is still OPEN and still holds the money
    // question - and no provider call and no refund debt were created.
    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.enqueueEditFinancialReviewRefundRecovery).not.toHaveBeenCalled();
  });

  it("MUTATION: refuses a card route with nothing captured behind it, whatever Payment.source says", async () => {
    // `Payment.source` DEFAULTS to STRIPE in the schema, so a hand-settled
    // booking can carry it with no capture at all. Routing on the column alone
    // sent that booking down the card path.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({ payment: { source: PaymentSource.STRIPE } })
    );
    mocks.planStripeRefundAllocation.mockResolvedValue({
      slices: [],
      plannedAmountCents: 0,
      totalRefundableCents: 0,
    });

    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "completed",
        note: "Priced from the June card receipt.",
        actingMemberId: "admin-1",
        confirmedAmountCents: 7300,
        direction: "REFUND_TO_MEMBER",
      })
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
  });

  it("queues the Xero credit note for the confirmed amount, on the edit's own anchor", async () => {
    // Every edit-time settlement dispatches a Xero delta. A completion that moved
    // money and dispatched none would leave an issued invoice and the ledger
    // permanently disagreeing, with nothing that reconciles them later.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({
        payment: { source: PaymentSource.STRIPE },
        booking: {
          memberId: "member-1",
          status: "PAID",
          payment: { id: "payment-1", status: "SUCCEEDED", xeroInvoiceId: "inv-1" },
        },
      })
    );

    await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: "Priced from the June card receipt.",
      actingMemberId: "admin-1",
      confirmedAmountCents: 7300,
      direction: "REFUND_TO_MEMBER",
    });

    expect(mocks.queueXeroBookingEditSettlement).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        bookingModificationId: "mod-1",
        hasIssuedXeroInvoice: true,
        priceDiffCents: -7300,
        settlementAmountCents: 7300,
        // A card refund issues an ordinary modification credit note; account
        // credit issues the UNAPPLIED one. The method follows the route the money
        // actually took rather than an election nobody made.
        settlementMethod: "card",
        // The structural edit queued its own narration update when it committed.
        datesChanged: false,
        guestIdentityChanged: false,
      })
    );
  });

  it("MUTATION: queues NO Xero credit note when the booking has no issued invoice", async () => {
    // Without this the assertion above would pass against a dispatch that fired
    // unconditionally, which would mint a credit note against nothing.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({ payment: { source: PaymentSource.STRIPE } })
    );

    await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: "Priced from the June card receipt.",
      actingMemberId: "admin-1",
      confirmedAmountCents: 7300,
      direction: "REFUND_TO_MEMBER",
    });

    // The dispatch still runs - `classifyXeroBookingEditSettlement` owns the
    // "no invoice, nothing to do" decision and is the one place it is made - but
    // it is told the truth about the invoice rather than a hopeful default.
    expect(mocks.queueXeroBookingEditSettlement).toHaveBeenCalledWith(
      expect.objectContaining({ hasIssuedXeroInvoice: false })
    );
  });

  it("MUTATION: a raced ledger write is refused, never lost", async () => {
    // This completion holds no advisory lock, so a concurrent writer can move the
    // same `PaymentTransaction` between the read and the write. The
    // compare-and-set inside `applyLocalRefundAllocation` makes that loud; here
    // it becomes a 409 the operator can act on, with the transaction rolled back
    // and the task still OPEN.
    const { RefundAllocationRacedError } = await import(
      "@/lib/payment-transactions"
    );
    mocks.manualRefundTaskFindUnique.mockResolvedValue(editReviewTask());
    mocks.applyLocalRefundAllocation.mockRejectedValueOnce(
      new RefundAllocationRacedError()
    );

    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "completed",
        note: "priced",
        actingMemberId: "admin-1",
        confirmedAmountCents: 4500,
        direction: "REFUND_TO_MEMBER",
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
  });

  it("allocates against a captured payment when it issues account credit, so a later cancellation cannot refund the same cents twice", async () => {
    /*
      #3194 made this fixture's booking status load-bearing, and it is spelled
      out here rather than left absent. Since #3194 a captured payment on a
      booking still INSIDE its payment lifecycle takes the card or ledger route
      instead of this one, so the shape that still reaches the credit arm holding
      refundable money is the booking that has LEFT that lifecycle - cancelled,
      most obviously. Its cents are exactly as capable of being refunded twice,
      which is why the allocation is still written here.
    */
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({
        paymentId: null,
        booking: {
          memberId: "member-1",
          status: "CANCELLED",
          payment: {
            id: "payment-9",
            status: "SUCCEEDED",
            amountCents: 20000,
            refundedAmountCents: 0,
          },
        },
      })
    );

    await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: "Credited to the member account.",
      actingMemberId: "admin-1",
      confirmedAmountCents: 4500,
      direction: "REFUND_TO_MEMBER",
    });

    // #1031: an account credit consumes refundable value exactly like a card
    // refund, so the allocation has to be written or a later cancel refunds the
    // same cents a second time.
    expect(mocks.createBookingModificationCredit).toHaveBeenCalledWith(
      "member-1",
      4500,
      "booking-1",
      "mod-1",
      undefined,
      tx,
      "payment-9"
    );
  });

  it("MUTATION: refuses a credit whose modification already carries one, before it claims the task (owner decision D-3032-1)", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({ paymentId: null })
    );
    mocks.memberCreditFindUnique.mockResolvedValue({ id: "credit-existing" });

    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "completed",
        note: "Credited to the member account.",
        actingMemberId: "admin-1",
        confirmedAmountCents: 4500,
        direction: "REFUND_TO_MEMBER",
      })
    ).rejects.toMatchObject({ status: 409 });

    // The whole point of refusing BEFORE the claim: the task is still OPEN and
    // still holds the money question. A refusal after the claim would leave it
    // COMPLETED having moved nothing, which is the "pretends money moved"
    // failure this epic exists to remove.
    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.createBookingModificationCredit).not.toHaveBeenCalled();
    expect(mocks.memberCreditFindUnique).toHaveBeenCalledWith({
      where: { sourceBookingModificationId: "mod-1" },
      select: { id: true },
    });
  });

  it("MUTATION: refuses a settlement it has no anchor for, rather than guessing which modification to settle against", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({
        paymentId: null,
        reviewContext: reviewContext({ bookingModificationId: null }),
      })
    );

    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "completed",
        note: "Credited to the member account.",
        actingMemberId: "admin-1",
        confirmedAmountCents: 4500,
        direction: "REFUND_TO_MEMBER",
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
  });

  it("MUTATION: an unreadable reviewContext refuses rather than settling against a half-read anchor", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({
        paymentId: null,
        // A blob the strict parser rejects. It must NOT be salvaged field by
        // field: the parser returns null for the whole object on purpose, and a
        // settlement that indexed into it would move real money on evidence
        // nothing vouched for.
        reviewContext: { version: 1, bookingModificationId: "mod-1" },
      })
    );

    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "completed",
        note: "Credited to the member account.",
        actingMemberId: "admin-1",
        confirmedAmountCents: 4500,
        direction: "REFUND_TO_MEMBER",
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.createBookingModificationCredit).not.toHaveBeenCalled();
  });

  it("keeps a legacy hand-back on the ledger-mirror route untouched: no Stripe call, no credit, no anchor lookup", async () => {
    // The base fixture is a CANCELLED_BOOKING_HAND_BACK with a payment.
    await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: null,
      actingMemberId: "admin-1",
      confirmedAmountCents: null,
      direction: "REFUND_TO_MEMBER",
    });

    expect(mocks.applyLocalRefundAllocation).toHaveBeenCalledWith({
      paymentId: "payment-1",
      amountCents: 9000,
      store: tx,
    });
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.createBookingModificationCredit).not.toHaveBeenCalled();
    expect(mocks.memberCreditFindUnique).not.toHaveBeenCalled();
    // A legacy hand-back carries no `BookingModification` anchor, so no Xero
    // credit note is queued for it - the cancellation path already handled its
    // Xero side, and a second correction here would contradict it.
    expect(mocks.queueXeroBookingEditSettlement).not.toHaveBeenCalled();
    expect(mocks.recordBookingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: BookingEventType.REFUNDED })
    );
  });

  it("MUTATION: a DISMISSED review moves nothing at all, down any route", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({ paymentId: null })
    );

    const result = await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "dismissed",
      note: "Reviewed against the June invoice: nothing is owed.",
      actingMemberId: "admin-1",
    });

    // DISMISSED means reviewed and nothing is due. It must not look like a
    // settlement in ANY of the three places one is recorded.
    expect(mocks.createBookingModificationCredit).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
    expect(mocks.queueXeroBookingEditSettlement).not.toHaveBeenCalled();
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
    expect(result.amountCents).toBeNull();
    // And no amount is written onto the row - a zero there would be the magic
    // value this epic exists to remove.
    expect(mocks.manualRefundTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: ManualRefundTaskStatus.OPEN },
      data: expect.not.objectContaining({ amountCents: expect.anything() }),
    });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ settlementRoute: null }),
      }),
      tx
    );
  });

  it("MUTATION: a lost claim moves no money - the side effect is downstream of the claim, never beside it", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({ paymentId: null })
    );
    // Another admin closed it between this transaction's read and its claim.
    mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "completed",
        note: "Credited to the member account.",
        actingMemberId: "admin-1",
        confirmedAmountCents: 4500,
        direction: "REFUND_TO_MEMBER",
      })
    ).rejects.toMatchObject({ status: 409 });

    expect(mocks.createBookingModificationCredit).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
    expect(mocks.enqueueEditFinancialReviewRefundRecovery).not.toHaveBeenCalled();
  });
});

/**
 * #3194 (epic #2797): A MEMBER WHO PAYS BY CARD WHILE A REVIEW IS OPEN GETS
 * THEIR CARD BACK.
 *
 * `ManualRefundTask.paymentId` is written once, when the review is raised, from
 * the booking's captured payment at that instant - and nothing ever backfills
 * it. A review parked on a booking nobody has paid yet therefore carries NULL
 * for ever.
 *
 * That combination is not rare, it is the ordinary sequence. A parked edit does
 * not disarm the booking's pay controls or its emailed payment link, on purpose:
 * one change can surrender nights nobody can value while the stay itself goes
 * ahead, and an unregistered guest has no other way to pay. So "edit parks, then
 * the member pays" happens, and before this issue it ended with a task whose
 * column said there was no card - so the officer's confirmed refund could only
 * ever become club credit, on money that had arrived on a card and could have
 * gone straight back to it.
 *
 * The fix is a re-read, not a backfill: a task with NO payment id asks the
 * booking's own row, inside the completion transaction, through the same
 * `capturedBookingPayment` gate both raise sites use. Nothing is written, so
 * there is no second write for a webhook replay to duplicate.
 *
 * Every test here has its control, because the property being protected is
 * two-sided: the missing route has to open, and none of the existing ones may
 * move.
 */
describe("#3194 - a review raised before the member paid still refunds to their card", () => {
  /** The booking's own captured card money, as it stands at completion. */
  function paidBooking(overrides: Record<string, unknown> = {}) {
    return {
      memberId: "member-1",
      status: "PAID",
      payment: {
        id: "payment-9",
        status: "SUCCEEDED",
        amountCents: 20000,
        refundedAmountCents: 0,
        source: PaymentSource.STRIPE,
        stripeCustomerId: "cus_1",
      },
      ...overrides,
    };
  }

  it("refunds to the card the member paid with after the review was raised", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({
        // Raised while the booking was unpaid, so the column is null - and stays
        // null, because nothing backfills it.
        paymentId: null,
        payment: null,
        booking: paidBooking(),
      })
    );

    const result = await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: "Priced from the August card receipt.",
      actingMemberId: "admin-1",
      confirmedAmountCents: 7300,
      direction: "REFUND_TO_MEMBER",
    });

    // THE POINT OF THE ISSUE: the money goes back the way it came, rather than
    // becoming club credit the member never asked for and cannot spend anywhere
    // else.
    expect(mocks.createBookingModificationCredit).not.toHaveBeenCalled();
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        // The BOOKING's payment, read at completion.
        paymentId: "payment-9",
        amountCents: 7300,
        // Still keyed to the TASK, unchanged by this issue: one edit can raise
        // two reviews against one `BookingModification`, so a modification-scoped
        // key would give two same-amount refunds the same per-slice key.
        idempotencyKeyPrefix:
          buildEditFinancialReviewRefundStripeKeyPrefix("task-1"),
      })
    );
    // And the cap was taken against that same payment BEFORE the claim, so an
    // over-cap amount would have left the task OPEN.
    expect(mocks.planStripeRefundAllocation).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "payment-9", store: tx })
    );
    expect(
      mocks.planStripeRefundAllocation.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.manualRefundTaskUpdateMany.mock.invocationCallOrder[0]);
    expect(result.stripeRefundId).toBe("re_test");
  });

  it("persists the refund debt against that same payment, inside the transaction", async () => {
    // The crash-safety half. A refund routed by a re-read must persist its debt
    // against the payment it will actually refund, or the recovery cron replays
    // against nothing.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({
        paymentId: null,
        payment: null,
        booking: paidBooking(),
      })
    );

    await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: "Priced from the August card receipt.",
      actingMemberId: "admin-1",
      confirmedAmountCents: 7300,
      direction: "REFUND_TO_MEMBER",
    });

    expect(mocks.enqueueEditFinancialReviewRefundRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "payment-9",
        taskId: "task-1",
        store: tx,
      })
    );
  });

  it("mirrors it in the ledger when the money arrived by internet banking instead", async () => {
    // The same re-read, the other instrument. There is no card to reverse, so
    // the club moves the money by hand and this records the ledger mirror -
    // which is what the task would have taken had the review been raised after
    // the payment rather than before it.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({
        paymentId: null,
        payment: null,
        booking: paidBooking({
          payment: {
            id: "payment-9",
            status: "SUCCEEDED",
            amountCents: 20000,
            refundedAmountCents: 0,
            source: PaymentSource.INTERNET_BANKING,
            stripeCustomerId: null,
          },
        }),
      })
    );

    await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: "Refunded by bank transfer on 3 Sept.",
      actingMemberId: "admin-1",
      confirmedAmountCents: 4500,
      direction: "REFUND_TO_MEMBER",
    });

    expect(mocks.applyLocalRefundAllocation).toHaveBeenCalledWith({
      paymentId: "payment-9",
      amountCents: 4500,
      store: tx,
    });
    expect(mocks.createBookingModificationCredit).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });

  it("CONTROL: a booking that still has no payment at all becomes account credit, exactly as before", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({ paymentId: null, payment: null })
    );

    await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: "Credited to the member account.",
      actingMemberId: "admin-1",
      confirmedAmountCents: 4500,
      direction: "REFUND_TO_MEMBER",
    });

    expect(mocks.createBookingModificationCredit).toHaveBeenCalledWith(
      "member-1",
      4500,
      "booking-1",
      "mod-1",
      undefined,
      tx,
      undefined
    );
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
  });

  it("MUTATION: does not reach for a payment row that has captured nothing", async () => {
    // `Payment.source` DEFAULTS to STRIPE in the schema, so a payment row alone
    // proves nothing about a card. Without the captured-status half of the gate
    // this booking would be routed to a Stripe refund of money the club never
    // received.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({
        paymentId: null,
        payment: null,
        booking: paidBooking({
          payment: {
            id: "payment-9",
            status: "PENDING",
            amountCents: 20000,
            refundedAmountCents: 0,
            source: PaymentSource.STRIPE,
            stripeCustomerId: "cus_1",
          },
        }),
      })
    );

    await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: "Credited to the member account.",
      actingMemberId: "admin-1",
      confirmedAmountCents: 4500,
      direction: "REFUND_TO_MEMBER",
    });

    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
    expect(mocks.createBookingModificationCredit).toHaveBeenCalled();
  });

  it("MUTATION: does not reach for a payment on a booking that has left its payment lifecycle", async () => {
    // The other half of the same gate, and the reason it is
    // `capturedBookingPayment` rather than `hasCapturedPayment` alone. A DRAFT
    // booking can hold a payment row that captured money for a lifecycle it is
    // no longer in; the raise sites refuse it, so the completion refuses it too,
    // or the two would disagree about one member's money.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({
        paymentId: null,
        payment: null,
        booking: paidBooking({ status: "DRAFT" }),
      })
    );

    await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: "Credited to the member account.",
      actingMemberId: "admin-1",
      confirmedAmountCents: 4500,
      direction: "REFUND_TO_MEMBER",
    });

    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.createBookingModificationCredit).toHaveBeenCalled();
  });

  it("MUTATION: still refuses a re-read card refund larger than the capture, before it claims the task", async () => {
    // The pre-claim cap is not bypassed by the new route. A refusal here leaves
    // the task OPEN and still holding the money question; one after the claim
    // would leave it COMPLETED with nothing moved.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({
        paymentId: null,
        payment: null,
        booking: paidBooking(),
      })
    );
    mocks.planStripeRefundAllocation.mockResolvedValue({
      slices: [{ paymentTransactionId: "txn-1", amountCents: 5000 }],
      plannedAmountCents: 5000,
      totalRefundableCents: 5000,
    });

    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "completed",
        note: "Priced from the August card receipt.",
        actingMemberId: "admin-1",
        confirmedAmountCents: 7300,
        direction: "REFUND_TO_MEMBER",
      })
    ).rejects.toMatchObject({ status: 400 });

    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.createBookingModificationCredit).not.toHaveBeenCalled();
  });

  it("MUTATION: refuses a re-read card refund it has no anchor for", async () => {
    // The new route reaches the same anchor requirement as the old one. Without
    // it the Xero credit note has no modification to correct.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({
        paymentId: null,
        payment: null,
        booking: paidBooking(),
        reviewContext: reviewContext({ bookingModificationId: null }),
      })
    );

    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "completed",
        note: "Priced from the August card receipt.",
        actingMemberId: "admin-1",
        confirmedAmountCents: 7300,
        direction: "REFUND_TO_MEMBER",
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
  });

  it("CONTROL: a task that already carries a payment id is routed by that id, not by the booking's", async () => {
    /*
      The half of the change that must NOT move. Re-deriving unconditionally was
      rejected because the stored id reaches routes the booking's own row no
      longer would - a reversed manual settlement, or a booking that has left the
      settled set - and on those the amount is capped and an over-cap is REFUSED
      with the task left OPEN. Re-deriving would turn each of those refusals into
      account credit, quietly. So the stored id wins wherever it exists, and only
      the NULL is widened.
    */
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({
        paymentId: "payment-1",
        payment: { source: PaymentSource.STRIPE },
        // A booking whose own row would answer differently: not in a settled
        // status, so the re-read would find nothing and fall to account credit.
        booking: paidBooking({ status: "CANCELLED" }),
      })
    );

    await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: "Priced from the June card receipt.",
      actingMemberId: "admin-1",
      confirmedAmountCents: 7300,
      direction: "REFUND_TO_MEMBER",
    });

    expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "payment-1" })
    );
    expect(mocks.createBookingModificationCredit).not.toHaveBeenCalled();
  });

  it("CONTROL: a legacy hand-back kind is untouched by the re-read", async () => {
    // The pre-#3032 kinds return before any of this. They are raised for
    // cash-settled bookings with no card charge to reverse, so reaching for the
    // booking's payment would invent a route they have never had.
    mocks.manualRefundTaskFindUnique.mockResolvedValue({
      id: "task-1",
      bookingId: "booking-1",
      paymentId: null,
      amountCents: 9000,
      raisedAmountCents: 9000,
      kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK,
      status: ManualRefundTaskStatus.OPEN,
      payment: null,
      reviewContext: null,
      booking: paidBooking({ status: "CANCELLED" }),
    });

    await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: "Handed back in cash at the lodge.",
      actingMemberId: "admin-1",
      confirmedAmountCents: 9000,
    });

    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
    expect(mocks.createBookingModificationCredit).not.toHaveBeenCalled();
  });
});
