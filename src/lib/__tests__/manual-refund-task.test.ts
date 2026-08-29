import { beforeEach, describe, expect, it, vi } from "vitest";
import {
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
  applyLocalRefundAllocation: vi.fn(),
  createAuditLog: vi.fn(),
  recordBookingEvent: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: (...a: unknown[]) => mocks.transaction(...a) },
}));
vi.mock("@/lib/payment-transactions", () => ({
  applyLocalRefundAllocation: (...a: unknown[]) =>
    mocks.applyLocalRefundAllocation(...a),
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

import { resolveManualRefundTask } from "@/lib/manual-refund-task-resolution";

const tx = {
  manualRefundTask: {
    findUnique: (...a: unknown[]) => mocks.manualRefundTaskFindUnique(...a),
    updateMany: (...a: unknown[]) => mocks.manualRefundTaskUpdateMany(...a),
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
    booking: { memberId: "member-1" },
  });
  mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 1 });
});

describe("resolveManualRefundTask", () => {
  it("completing writes the ledger allocation and the REFUNDED booking event — that is when the money is recorded as returned", async () => {
    await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: "cash handed back",
      actingMemberId: "admin-1",
      confirmedAmountCents: null,
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
    booking: { memberId: "member-1" },
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
        })
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
  });

  it("MUTATION: completes a credit-only task without claiming a refund the system never made", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      editReviewTask({ paymentId: null })
    );

    const result = await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: "Credited to the member account.",
      actingMemberId: "admin-1",
      confirmedAmountCents: 4500,
    });

    // There is nothing to allocate a refund against, and inventing a payment
    // link to satisfy the model is exactly what owner decision D2 removed.
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
    expect(result.amountCents).toBe(4500);

    // And NO booking event. Nothing here writes account credit, nothing moves in
    // the ledger and `Payment.refundedAmountCents` is untouched - so a REFUNDED
    // event would put a claim in the booking's durable, MEMBER-FACING log that
    // the system can point to nothing to back: `booking-narrative.ts` turns the
    // first REFUNDED/CREDITED event into the sentence a member reads about their
    // cancelled booking's settlement. The admin's action is in the audit log,
    // which is where it belongs.
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-payment.manual-refund-task.complete",
        metadata: expect.objectContaining({ amountCents: 4500 }),
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
