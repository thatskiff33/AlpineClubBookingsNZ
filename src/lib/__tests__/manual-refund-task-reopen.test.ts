import { beforeEach, describe, expect, it, vi } from "vitest";
import { ManualRefundTaskStatus } from "@prisma/client";

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
 * webhook wrote" fails. Both mutations were applied, both failed this file, and
 * both were restored (`docs/TESTING.md`).
 */

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  createAuditLog: vi.fn(),
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
  REOPEN_NOTE_REQUIRED_MESSAGE,
  REOPEN_ONLY_DISMISSED_MESSAGE,
  REOPEN_ONLY_OFFICER_DISMISSAL_MESSAGE,
  REOPEN_RACED_MESSAGE,
  reopenManualRefundTask,
} from "@/lib/manual-refund-task-reopen";

const tx = {
  manualRefundTask: {
    findUnique: (...a: unknown[]) => mocks.findUnique(...a),
    updateMany: (...a: unknown[]) => mocks.updateMany(...a),
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
  mocks.transaction.mockImplementation(
    async (fn: (store: typeof tx) => Promise<unknown>) => fn(tx),
  );
  mocks.findUnique.mockResolvedValue(DISMISSED_BY_OFFICER);
  mocks.updateMany.mockResolvedValue({ count: 1 });
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
