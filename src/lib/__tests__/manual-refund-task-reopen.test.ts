import { beforeEach, describe, expect, it, vi } from "vitest";
import { ManualRefundTaskStatus } from "@prisma/client";
import { EDIT_REFUND_HAND_BACK_REOPEN_AFTER_CANCEL_MESSAGE } from "@/lib/manual-refund-task-settlement-rules";

/**
 * #3498 (owner decision D2, epic #2797): putting a DISMISSED money task back on
 * the queue.
 *
 * Every closure used to be terminal and the queue only ever read
 * `status: "OPEN"`, so a wrong dismissal was silent, permanent, and invisible to
 * every later reader - which on the live deployment came within one row of
 * discarding a real $140.00 adjustment. D2 makes a dismissal undoable and leaves
 * a completion terminal.
 *
 * MUTATION PROOF. Delete the DISMISSED-only refusal and "refuses a COMPLETED
 * task" fails. Delete the officer-dismissal fence and "refuses a dismissal the
 * webhook wrote" fails. Delete the `pg_advisory_xact_lock(1)` statement and
 * "takes the global settlement key BEFORE it reads the row" fails. All three
 * mutations were applied, each failed this file, and each was restored
 * (`docs/TESTING.md`).
 */

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  createAuditLog: vi.fn(),
  executeRaw: vi.fn(),
  aggregate: vi.fn(),
  creditAggregate: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: (...a: unknown[]) => mocks.transaction(...a) },
}));
vi.mock("@/lib/audit", () => ({
  createAuditLog: (...a: unknown[]) => mocks.createAuditLog(...a),
}));

import {
  REOPEN_ALREADY_OPEN_MESSAGE,
  REOPEN_EDIT_REFUND_EXCEEDS_CASH_MESSAGE,
  REOPEN_NOTE_REQUIRED_MESSAGE,
  REOPEN_ONLY_DISMISSED_MESSAGE,
  REOPEN_ONLY_OFFICER_DISMISSAL_MESSAGE,
  REOPEN_RACED_MESSAGE,
  reopenManualRefundTask,
} from "@/lib/manual-refund-task-reopen";

/** Every call the transaction makes, in order, so the LOCK's position is testable. */
const calls: string[] = [];

const tx = {
  $executeRaw: (...a: unknown[]) => {
    calls.push(`lock:${String((a[0] as { raw?: string[] })?.raw?.join("") ?? a[0])}`);
    return mocks.executeRaw(...a);
  },
  manualRefundTask: {
    findUnique: (...a: unknown[]) => {
      calls.push("findUnique");
      return mocks.findUnique(...a);
    },
    updateMany: (...a: unknown[]) => {
      calls.push("updateMany");
      return mocks.updateMany(...a);
    },
    aggregate: (...a: unknown[]) => mocks.aggregate(...a),
  },
  memberCredit: {
    aggregate: (...a: unknown[]) => mocks.creditAggregate(...a),
  },
  // `INV-PAY-118`: an appeal task's reopen re-reads the payment after the
  // handed-back sums; echo whatever the task row carried.
  payment: {
    findUnique: async () => {
      const task = (await mocks.findUnique.getMockImplementation()?.()) ?? null;
      return (task as { payment?: unknown } | null)?.payment ?? null;
    },
  },
};

const DISMISSED_BY_OFFICER = {
  id: "task-1",
  bookingId: "booking-1",
  kind: "EDIT_FINANCIAL_REVIEW",
  status: ManualRefundTaskStatus.DISMISSED,
  amountCents: null,
  raisedAmountCents: null,
  note: "Nothing owed either way.",
  completedAt: new Date("2026-06-20T03:00:00.000Z"),
  completedByMemberId: "officer-9",
  booking: { memberId: "member-1", organisation: null },
};

function reopen(note: string | null = "Closed by mistake.") {
  return reopenManualRefundTask({
    taskId: "task-1",
    actingMemberId: "admin-1",
    note,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  mocks.executeRaw.mockResolvedValue(1);
  mocks.transaction.mockImplementation(
    async (fn: (store: typeof tx) => Promise<unknown>) => fn(tx),
  );
  mocks.findUnique.mockResolvedValue(DISMISSED_BY_OFFICER);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.aggregate.mockResolvedValue({ _sum: { amountCents: null } });
  mocks.creditAggregate.mockResolvedValue({ _sum: { amountCents: null } });
});

describe("reopening a dismissed money task (#3498 D2)", () => {
  it("puts it back OPEN through a status-fenced claim, and clears the closure it no longer has", async () => {
    const result = await reopen();

    expect(result).toMatchObject({
      taskId: "task-1",
      bookingId: "booking-1",
      status: ManualRefundTaskStatus.OPEN,
    });
    /*
      The fence lives in the `where`, exactly as the closure's does in the other
      direction: a row somebody else has already reopened or completed matches
      nothing, and that is the whole single-flight guarantee on a path that
      takes no advisory lock.
    */
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: ManualRefundTaskStatus.DISMISSED },
      data: {
        status: ManualRefundTaskStatus.OPEN,
        completedAt: null,
        completedByMemberId: null,
      },
    });
    // And NOTHING about the money is touched: no amount, no direction. A
    // dismissal wrote neither, so there is nothing of a closure's to undo.
    const written = mocks.updateMany.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(written).not.toHaveProperty("amountCents");
    expect(written).not.toHaveProperty("settlementDirection");
    // The dismissing officer's own note is left exactly as they wrote it - it is
    // the record of the decision being questioned, and overwriting it with the
    // reopen's reason would destroy the thing under review.
    expect(written).not.toHaveProperty("note");
  });

  it("audits who undid what, and why - the only place the closure now survives", async () => {
    await reopen("Closed by mistake while working a booking that raised several rows.");

    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-payment.manual-refund-task.reopen",
        category: "payment",
        severity: "important",
        outcome: "success",
        entityType: "ManualRefundTask",
        entityId: "task-1",
        actorMemberId: "admin-1",
        subjectMemberId: "member-1",
        details:
          "Closed by mistake while working a booking that raised several rows.",
        metadata: expect.objectContaining({
          // Cleared from the row by the claim above, so this entry is the only
          // surviving record of whose decision was undone and when.
          dismissedByMemberId: "officer-9",
          dismissedAt: "2026-06-20T03:00:00.000Z",
          dismissalNote: "Nothing owed either way.",
        }),
      }),
      tx,
    );
  });

  it("MUTATION: refuses a COMPLETED task, whose money has already moved", async () => {
    // The asymmetry D2 draws, and the reason for it: a completion settled
    // against an anchor that enforces exactly-once, so reopening it would invite
    // an officer to price a second settlement the database will then refuse -
    // after they had done the work, in front of a screen that offered it.
    mocks.findUnique.mockResolvedValue({
      ...DISMISSED_BY_OFFICER,
      status: ManualRefundTaskStatus.COMPLETED,
      amountCents: 14_000,
    });

    await expect(reopen()).rejects.toMatchObject({
      message: REOPEN_ONLY_DISMISSED_MESSAGE,
      status: 409,
    });
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("MUTATION: refuses a dismissal the webhook wrote, which records a refund Stripe already made", async () => {
    // `completedByMemberId: null` is a machine closure, and one population of
    // those is the late-capture auto-refund: DISMISSED because the money had
    // ALREADY gone back. Putting one in the hand-settle queue invites a second
    // refund of the same capture.
    mocks.findUnique.mockResolvedValue({
      ...DISMISSED_BY_OFFICER,
      completedByMemberId: null,
    });

    await expect(reopen()).rejects.toMatchObject({
      message: REOPEN_ONLY_OFFICER_DISMISSAL_MESSAGE,
      status: 409,
    });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("CONTROL: an OPEN task is already where the officer wants it", async () => {
    mocks.findUnique.mockResolvedValue({
      ...DISMISSED_BY_OFFICER,
      status: ManualRefundTaskStatus.OPEN,
    });

    await expect(reopen()).rejects.toMatchObject({
      message: REOPEN_ALREADY_OPEN_MESSAGE,
      status: 409,
    });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("requires a note, because this undoes a decision somebody recorded", async () => {
    await expect(reopen("   ")).rejects.toMatchObject({
      message: REOPEN_NOTE_REQUIRED_MESSAGE,
      status: 400,
    });
    // Refused before the row is even read, so a note-less request costs nothing
    // and touches nothing.
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("answers a lost claim as the race it is, rather than reporting success", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(reopen()).rejects.toMatchObject({
      message: REOPEN_RACED_MESSAGE,
      status: 409,
    });
    // No audit entry either: nothing happened, so nothing is recorded as having.
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("answers 404 for a task that is not there", async () => {
    mocks.findUnique.mockResolvedValue(null);

    await expect(reopen()).rejects.toMatchObject({ status: 404 });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});

describe("the global settlement key the reopen takes (#3498 fix round, C1)", () => {
  /*
    The failure this is about is NOT two officers pressing at once - the
    status-fenced claim already answers that one. It is a money-affecting EDIT
    that read `assertNoPendingEditFinancialReview` while the task was
    `DISMISSED`, proceeded, and settled a credit against its own
    `BookingModification` while this transaction was putting the task back on
    the queue. `DISMISSED -> OPEN` tightens that fence RETROACTIVELY, which is
    the one direction the closure path it mirrors never moves it - so the
    closure's documented reason for holding no advisory key does not transfer.

    The lock has to come BEFORE the read as well as before the write: a reopen
    that read the row first and then queued behind the edit would decide on a
    snapshot the edit has already invalidated.
  */
  it("takes the global settlement key BEFORE it reads the row", async () => {
    await reopen();

    expect(calls[0]).toMatch(/^lock:/);
    expect(calls[0]).toContain("pg_advisory_xact_lock(1)");
    expect(calls.indexOf("findUnique")).toBeGreaterThan(0);
    expect(calls.indexOf("updateMany")).toBeGreaterThan(
      calls.indexOf("findUnique"),
    );
  });

  /*
    The key is taken inside the caller's transaction, which is what makes it
    transaction-scoped: a `pg_advisory_lock` on a pooled connection would
    outlive the rollback below and leak the key for the life of that connection.
  */
  it("holds it on the transaction, so a refusal releases it by rolling back", async () => {
    mocks.findUnique.mockResolvedValue({
      ...DISMISSED_BY_OFFICER,
      status: ManualRefundTaskStatus.COMPLETED,
    });

    await expect(reopen()).rejects.toThrow(REOPEN_ONLY_DISMISSED_MESSAGE);

    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});

describe("reopening a dismissed EDIT refund hand-back (#3827, INV-PAY-117)", () => {
  /** A $200 edit refund on a $300 internet-banking payment, dismissed. */
  function dismissedEditRefund(payment: { amountCents: number; refundedAmountCents: number }) {
    return {
      ...DISMISSED_BY_OFFICER,
      kind: "CANCELLED_BOOKING_HAND_BACK",
      occurrenceKey: "edit-refund-hand-back:mod-1",
      amountCents: 20000,
      raisedAmountCents: 20000,
      payment: { id: "pay-1", status: "SUCCEEDED", ...payment },
    };
  }

  it("puts it back when the cash it promises is still there", async () => {
    mocks.findUnique.mockResolvedValue(dismissedEditRefund({ amountCents: 30000, refundedAmountCents: 0 }));
    mocks.aggregate.mockResolvedValue({ _sum: { amountCents: 10000 } });

    await expect(reopen()).resolves.toMatchObject({ status: ManualRefundTaskStatus.OPEN });
    expect(mocks.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ paymentId: "pay-1", status: "OPEN" }) }),
    );
  });

  it("refuses when a later edit has since promised that cash back, and writes nothing", async () => {
    // $300 taken; a later edit raised its own $200 task after this one was
    // dismissed. Reopening would promise $400 back.
    mocks.findUnique.mockResolvedValue(dismissedEditRefund({ amountCents: 30000, refundedAmountCents: 0 }));
    mocks.aggregate.mockResolvedValue({ _sum: { amountCents: 20000 } });

    await expect(reopen()).rejects.toMatchObject({ message: REOPEN_EDIT_REFUND_EXCEEDS_CASH_MESSAGE });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("refuses when the cash has since been refunded another way", async () => {
    mocks.findUnique.mockResolvedValue(dismissedEditRefund({ amountCents: 30000, refundedAmountCents: 15000 }));

    await expect(reopen()).rejects.toMatchObject({ message: REOPEN_EDIT_REFUND_EXCEEDS_CASH_MESSAGE });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("refuses once the booking is cancelled, even with the cash still there: the cancel sized its refund without it", async () => {
    mocks.findUnique.mockResolvedValue({
      ...dismissedEditRefund({ amountCents: 30000, refundedAmountCents: 0 }),
      booking: { memberId: "member-1", status: "CANCELLED", organisation: null },
    });
    mocks.aggregate.mockResolvedValue({ _sum: { amountCents: null } });

    await expect(reopen()).rejects.toMatchObject({
      status: 409,
      message: EDIT_REFUND_HAND_BACK_REOPEN_AFTER_CANCEL_MESSAGE,
    });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("CONTROL: a cancellation's own dismissed hand-back on a cancelled booking still reopens", async () => {
    mocks.findUnique.mockResolvedValue({
      ...DISMISSED_BY_OFFICER,
      kind: "CANCELLED_BOOKING_HAND_BACK",
      occurrenceKey: null,
      booking: { memberId: "member-1", status: "CANCELLED", organisation: null },
    });

    await expect(reopen()).resolves.toMatchObject({ status: ManualRefundTaskStatus.OPEN });
  });
});

describe("reopening a dismissed refund APPEAL hand-back (#3827, D-3813-7, INV-PAY-118)", () => {
  /** A $100 appeal task on a cancelled $200 internet-banking payment, dismissed. */
  function dismissedAppeal(payment: { amountCents: number; refundedAmountCents: number }) {
    return {
      ...DISMISSED_BY_OFFICER,
      kind: "CANCELLED_BOOKING_HAND_BACK",
      occurrenceKey: "refund-request-hand-back:req-1",
      amountCents: 10000,
      raisedAmountCents: 10000,
      payment: { id: "pay-1", bookingId: "booking-1", status: "PARTIALLY_REFUNDED", ...payment },
      booking: { memberId: "member-1", status: "CANCELLED", organisation: null },
    };
  }

  it("reopens on its cancelled booking while the cash is still there", async () => {
    mocks.findUnique.mockResolvedValue(dismissedAppeal({ amountCents: 20000, refundedAmountCents: 10000 }));
    mocks.aggregate.mockResolvedValue({ _sum: { amountCents: null } });

    await expect(reopen()).resolves.toMatchObject({ status: ManualRefundTaskStatus.OPEN });
  });

  it("refuses once a later appeal has promised that cash back", async () => {
    mocks.findUnique.mockResolvedValue(dismissedAppeal({ amountCents: 20000, refundedAmountCents: 10000 }));
    mocks.aggregate.mockResolvedValue({ _sum: { amountCents: 10000 } });

    await expect(reopen()).rejects.toMatchObject({ message: REOPEN_EDIT_REFUND_EXCEEDS_CASH_MESSAGE });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  // `INV-PAY-118`: an appeal's task is measured by the APPEAL's ceiling - every
  // open hand-back (a cancellation's own included) and the late-cash credit.
  it("measures it against every open hand-back, any kind", async () => {
    mocks.findUnique.mockResolvedValue(dismissedAppeal({ amountCents: 20000, refundedAmountCents: 10000 }));

    await reopen();

    expect(mocks.aggregate).toHaveBeenCalledWith({
      where: { paymentId: "pay-1", status: "OPEN", kind: "CANCELLED_BOOKING_HAND_BACK" },
      _sum: { amountCents: true },
    });
  });

  it("refuses once the member already holds that cash as late-cash credit", async () => {
    mocks.findUnique.mockResolvedValue(dismissedAppeal({ amountCents: 20000, refundedAmountCents: 10000 }));
    mocks.creditAggregate.mockResolvedValue({ _sum: { amountCents: 5000 } });

    await expect(reopen()).rejects.toMatchObject({ message: REOPEN_EDIT_REFUND_EXCEEDS_CASH_MESSAGE });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});
