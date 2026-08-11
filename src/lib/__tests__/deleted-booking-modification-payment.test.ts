import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2700 surface 2, part 2 — when the race still fires, the money is recorded
 * AND a human is told.
 *
 * THE DECISION, and it rejected both of the options the issue body offered.
 * "Record it anyway" leaves a ledger row against a ghost booking with nobody
 * told. "Refuse and let Stripe reconciliation surface it" leaves the club
 * holding a member's money with no record of it at all. The owner's 10 Aug 2026
 * answer does both halves of the right thing: record the payment, so the money
 * is accounted for, and raise an OPEN `ManualRefundTask`, so a person decides
 * whether to refund rather than the system deciding silently either way.
 *
 * NO AUTOMATIC REFUND FROM THIS PATH — a money movement triggered by a race,
 * and if the DELETION was itself the mistake, refunding automatically compounds
 * it instead of surfacing it. "raises the task without moving any money"
 * asserts that directly.
 *
 * WHY A `DISMISSED` CLOSE EXISTS AND IS NOT A CONTRADICTION. The browser
 * confirm is not the only writer that hears about the capture: Stripe also
 * sends `payment_intent.succeeded`, and since #1350 the webhook routes an
 * additional payment on a CANCELLED booking through
 * `handleCancelledBookingAdditionalPaymentSucceeded`, which refunds it in full.
 * A soft-deleted booking is ALWAYS CANCELLED (`INV-ADDPAY-030`), so that
 * pre-existing path covers deleted bookings too. If it runs after this task was
 * raised, the task's question is already answered, and leaving it OPEN would
 * invite an operator to COMPLETE it — which writes a second refund allocation
 * through `resolveManualRefundTask` and double-counts one refund in the ledger.
 * Closing a task whose subject is resolved moves no money; the refund it
 * records was #1350's behaviour and is not introduced here.
 *
 * AND THE CLOSE ONLY COVERS ONE ORDERING, WHICH IS WHY THE RAISE IS ALSO
 * FENCED. The close catches a webhook that arrives after the task exists. The
 * reverse interleaving is just as producible: the confirm route reads the
 * transaction's status once, then spends a Stripe round trip in
 * `getPaymentIntent`, and a webhook that completes entirely inside that window
 * refunds the capture and returns 200 before the route looks again. The route's
 * already-captured early return no longer fires, `markPaymentIntentTransaction-
 * Succeeded` writes SUCCEEDED back over the REFUNDED status, and a raise there
 * queues an operator to hand back money Stripe already returned — a task that
 * cannot even be completed, because `applyLocalRefundAllocation` throws "Refund
 * amount exceeds captured payments". So the raise re-reads the transaction under
 * the same lock and skips. `refundedAmountCents` is the field that decides it,
 * not `status`, precisely because the status is the thing that got overwritten.
 *
 * AND SINCE #2760 THE WEBHOOK WRITES THE ROW WHEN NOTHING RAISED ONE (owner
 * decision 10 Aug 2026, taken over the narrower recommendation). The close alone
 * left a record on exactly one ordering, and none at all for a late capture on a
 * booking that is cancelled but not deleted — the raise never fires there. So
 * `recordAutomaticCancelledBookingRefundTask` closes an OPEN task if there is one
 * and otherwise creates the row already DISMISSED, for either population, keyed on
 * the intent across both population sentences. Never OPEN, no allocation, no
 * operator queued, and no change to the refund itself.
 *
 * MUTATION PROOF. Drop the `findFirst` pre-check in
 * `raiseDeletedBookingModificationRefundTask` and "raises exactly one task when
 * the same capture is confirmed twice" fails. Drop `pg_advisory_xact_lock(1)`
 * and "takes the global settlement lock before the find-then-create" fails —
 * and, in the writer, "takes the global settlement lock before it reads or writes
 * anything". Drop the refund fence and "raises nothing for a capture Stripe has
 * already refunded" fails; fence it on `status` alone instead of
 * `refundedAmountCents` and "still skips when the status was overwritten back to
 * SUCCEEDED" fails; move the fence outside the lock and "reads the refund state
 * under the same lock as the raise" fails. Widen the writer's `where` to drop
 * `reason` and "never touches an unrelated ManualRefundTask on the same booking"
 * fails; drop `status: OPEN` from the close and "claims nothing on a replay"
 * fails. Change `DISMISSED` to `COMPLETED` and "closes an OPEN task as DISMISSED"
 * fails. Delete the create and "writes the record itself, already DISMISSED, when
 * no task was raised" fails; write it OPEN and the same test fails; share one
 * reason sentence between the populations and "stores the cancelled-population
 * sentence for a booking that is not deleted" fails; narrow either lookup to one
 * population and "finds a row of EITHER population" fails. Take Prisma's default
 * transaction budget and "budgets its transaction for lock(1) contention" fails;
 * collapse the hand-resolved case back into one `alreadyRecorded: true` and
 * "reports a HAND-resolved row as such, and warns" fails.
 */

const mocks = vi.hoisted(() => ({
  manualRefundTaskFindFirst: vi.fn(),
  manualRefundTaskCreate: vi.fn(),
  manualRefundTaskUpdateMany: vi.fn(),
  paymentTransactionFindUnique: vi.fn(),
  executeRaw: vi.fn(),
  transaction: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // Both writers open a transaction since #2760: the record-or-close became a
    // find-then-write and took the same global lock the raise already held, so
    // there is no bare `prisma.manualRefundTask` call left in the module.
    $transaction: (...args: unknown[]) => mocks.transaction(...args),
  },
}));

import {
  AUTOMATIC_CANCELLED_BOOKING_REFUND_NOTE_PREFIX,
  automaticCancelledBookingRefundNote,
  automaticCancelledBookingRefundTaskReasons,
  cancelledBookingModificationRefundReason,
  deletedBookingModificationRefundReason,
  raiseDeletedBookingModificationRefundTask,
  recordAutomaticCancelledBookingRefundTask,
} from "@/lib/deleted-booking-modification-payment";

const BOOKING_ID = "booking-1";
const PAYMENT_ID = "payment-1";
const INTENT_ID = "pi_modification";
const AMOUNT_CENTS = 2500;

const tx = {
  $executeRaw: mocks.executeRaw,
  manualRefundTask: {
    findFirst: (...args: unknown[]) => mocks.manualRefundTaskFindFirst(...args),
    create: (...args: unknown[]) => mocks.manualRefundTaskCreate(...args),
    updateMany: (...args: unknown[]) =>
      mocks.manualRefundTaskUpdateMany(...args),
  },
  paymentTransaction: {
    findUnique: (...args: unknown[]) =>
      mocks.paymentTransactionFindUnique(...args),
  },
};

/**
 * A row shaped the way THIS writer writes one: DISMISSED, no acting member, and
 * carrying the automatic note. That trio is what tells "my own row, redelivered"
 * apart from "an operator closed this by hand", which the card cannot show.
 */
function ownRecordRow() {
  return {
    id: "task-existing",
    status: "DISMISSED",
    completedByMemberId: null,
    note: automaticCancelledBookingRefundNote(INTENT_ID),
  };
}

function raise() {
  return raiseDeletedBookingModificationRefundTask({
    bookingId: BOOKING_ID,
    paymentId: PAYMENT_ID,
    paymentIntentId: INTENT_ID,
    amountCents: AMOUNT_CENTS,
  });
}

/**
 * The webhook's writer. `bookingDeleted` defaults to the deleted population,
 * which is the one #2700 shipped and every pre-#2760 assertion here was written
 * against; the merely-cancelled population passes `false` explicitly.
 *
 * `captureKind` defaults to `"modification"` for the same reason: every assertion
 * in this file predates #2773, which widened the writer to the booking's OWN
 * payment as well. The primary kind is exercised explicitly where it matters.
 */
function record(
  bookingDeleted = true,
  captureKind: "modification" | "primary" = "modification",
) {
  return recordAutomaticCancelledBookingRefundTask({
    bookingId: BOOKING_ID,
    paymentId: PAYMENT_ID,
    paymentIntentId: INTENT_ID,
    amountCents: AMOUNT_CENTS,
    bookingDeleted,
    captureKind,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executeRaw.mockResolvedValue(1);
  mocks.transaction.mockImplementation(
    async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
  );
  mocks.manualRefundTaskFindFirst.mockResolvedValue(null);
  mocks.manualRefundTaskCreate.mockResolvedValue({ id: "task-1" });
  mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 1 });
  // The ordinary state at the moment of the raise: captured, nothing refunded.
  mocks.paymentTransactionFindUnique.mockResolvedValue({
    status: "SUCCEEDED",
    refundedAmountCents: 0,
    amountCents: AMOUNT_CENTS,
  });
});

describe("raiseDeletedBookingModificationRefundTask (#2700)", () => {
  it("raises an OPEN task carrying the booking, payment and captured amount", async () => {
    const result = await raise();

    expect(result).toEqual({ taskId: "task-1", created: true, alreadyRefunded: false });
    expect(mocks.manualRefundTaskCreate).toHaveBeenCalledTimes(1);
    expect(mocks.manualRefundTaskCreate.mock.calls[0][0]).toMatchObject({
      data: {
        bookingId: BOOKING_ID,
        paymentId: PAYMENT_ID,
        amountCents: AMOUNT_CENTS,
        status: "OPEN",
      },
    });
  });

  it("raises the task without moving any money", async () => {
    // The whole point of the decision. This module holds no refund call at all,
    // and the assertion is on the object it is handed: a task creation and
    // nothing else.
    await raise();

    const created = mocks.manualRefundTaskCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(Object.keys(created.data).sort()).toEqual([
      "amountCents",
      "bookingId",
      "paymentId",
      "reason",
      "status",
    ]);
    // Nothing here completes the task or records that money went back.
    expect(created.data.completedAt).toBeUndefined();
    expect(created.data.completedByMemberId).toBeUndefined();
  });

  it("names the situation in a reason a person can act on, and fits the column", async () => {
    await raise();

    const reason = (
      mocks.manualRefundTaskCreate.mock.calls[0][0] as {
        data: { reason: string };
      }
    ).data.reason;
    expect(reason).toContain(INTENT_ID);
    expect(reason).toContain("#2700");
    // `ManualRefundTask.reason` is VarChar(500).
    expect(reason.length).toBeLessThanOrEqual(500);
  });

  it("raises exactly one task when the same capture is confirmed twice", async () => {
    // Two operators, two refunds is the failure this prevents. The match is on
    // bookingId + paymentId + this intent's reason, across EVERY status, so a
    // retry after somebody already completed or dismissed the task raises
    // nothing either.
    mocks.manualRefundTaskFindFirst.mockResolvedValue({ id: "task-existing" });

    const result = await raise();

    expect(result).toEqual({
      taskId: "task-existing",
      created: false,
      alreadyRefunded: false,
    });
    expect(mocks.manualRefundTaskCreate).not.toHaveBeenCalled();
    expect(mocks.manualRefundTaskFindFirst).toHaveBeenCalledWith({
      where: {
        bookingId: BOOKING_ID,
        paymentId: PAYMENT_ID,
        // #2760: BOTH population sentences. The webhook may already have written
        // the cancelled-population row for this capture and the booking may have
        // been deleted afterwards, so matching only this path's own sentence
        // would raise a duplicate OPEN task for money already returned.
        reason: { in: automaticCancelledBookingRefundTaskReasons(INTENT_ID) },
      },
      select: { id: true },
    });
  });

  it("takes the global settlement lock before the find-then-create", async () => {
    // find-then-create is not atomic on its own. `pg_advisory_xact_lock(1)` is
    // the canonical global booking/settlement key and is the one
    // `booking-cancel.ts` already holds when IT creates a ManualRefundTask, so
    // this write joins that cohort rather than minting a new keyspace. It takes
    // that key and nothing else, for two statements, with every Stripe call
    // made by the caller outside this transaction — so it adds no lock ordering.
    await raise();

    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.executeRaw.mock.calls[0][0].join("?")).toContain(
      "pg_advisory_xact_lock(1)",
    );
    // The lock is taken FIRST, before anything is read.
    expect(
      mocks.executeRaw.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.manualRefundTaskFindFirst.mock.invocationCallOrder[0]);
  });

  it("raises nothing for a capture Stripe has already refunded", async () => {
    // THE REVERSE INTERLEAVING. The webhook refunded the capture inside the
    // confirm route's own Stripe round trip, so the close ran before there was
    // a task to close and Stripe will not redeliver. Without this fence the
    // operator gets an OPEN task for money already returned — and completing it
    // throws out of `applyLocalRefundAllocation`, so it looks unresolvable.
    mocks.paymentTransactionFindUnique.mockResolvedValue({
      status: "REFUNDED",
      refundedAmountCents: AMOUNT_CENTS,
      amountCents: AMOUNT_CENTS,
    });

    const result = await raise();

    expect(result).toEqual({
      taskId: null,
      created: false,
      alreadyRefunded: true,
    });
    expect(mocks.manualRefundTaskCreate).not.toHaveBeenCalled();
  });

  it("still skips when the status was overwritten back to SUCCEEDED", async () => {
    // The producible shape, and the reason `refundedAmountCents` decides this
    // rather than `status`: `markPaymentIntentTransactionSucceeded` writes
    // SUCCEEDED over the REFUNDED status but never touches the refunded total,
    // so by the time the raise looks, the status is the field that is lying.
    mocks.paymentTransactionFindUnique.mockResolvedValue({
      status: "SUCCEEDED",
      refundedAmountCents: AMOUNT_CENTS,
      amountCents: AMOUNT_CENTS,
    });

    const result = await raise();

    expect(result.alreadyRefunded).toBe(true);
    expect(mocks.manualRefundTaskCreate).not.toHaveBeenCalled();
  });

  it("still raises for a PARTIAL refund that does not cover the capture", async () => {
    // The complement. A partial refund leaves money the club is still holding
    // against a deleted booking, which is exactly what the task is for — and
    // `PARTIALLY_REFUNDED` alone is not enough to conclude "settled".
    mocks.paymentTransactionFindUnique.mockResolvedValue({
      status: "SUCCEEDED",
      refundedAmountCents: AMOUNT_CENTS - 1,
      amountCents: AMOUNT_CENTS,
    });

    const result = await raise();

    expect(result.alreadyRefunded).toBe(false);
    expect(mocks.manualRefundTaskCreate).toHaveBeenCalledTimes(1);
  });

  it("reads the refund state under the same lock as the raise", async () => {
    // Outside the lock it is a stale read: a refund committing between the
    // check and the create is exactly the interleaving being fenced.
    await raise();

    expect(mocks.paymentTransactionFindUnique).toHaveBeenCalledWith({
      where: { stripePaymentIntentId: INTENT_ID },
      select: { status: true, refundedAmountCents: true, amountCents: true },
    });
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.paymentTransactionFindUnique.mock.invocationCallOrder[0],
    );
    expect(
      mocks.paymentTransactionFindUnique.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.manualRefundTaskCreate.mock.invocationCallOrder[0]);
  });

  it("raises normally when there is no transaction row to read", async () => {
    // A missing row is not evidence of a refund. Refusing to raise there would
    // trade one silent hole for another.
    mocks.paymentTransactionFindUnique.mockResolvedValue(null);

    const result = await raise();

    expect(result.created).toBe(true);
    expect(mocks.manualRefundTaskCreate).toHaveBeenCalledTimes(1);
  });

  it("does not confuse another booking's task for this one", async () => {
    // Two different intents on the same booking and payment produce two
    // different reasons, so neither suppresses the other.
    expect(deletedBookingModificationRefundReason("pi_a")).not.toBe(
      deletedBookingModificationRefundReason("pi_b"),
    );
  });
});

describe("recordAutomaticCancelledBookingRefundTask (#2700 close, #2760 write)", () => {
  it("closes an OPEN task as DISMISSED, which writes no refund allocation", async () => {
    // In `manual-booking-payment.ts` COMPLETED means "an operator handed the
    // money back by hand" and is what writes the local refund allocation.
    // Stripe refunded this one and `refundPaymentTransactions` already wrote the
    // allocation, so COMPLETED here would be both untrue and a second allocation
    // for one refund.
    const outcome = await record();

    expect(outcome).toEqual({
      closed: 1,
      created: false,
      alreadyRecorded: false,
      // #2774: null whenever this call closed or created the row - nothing was
      // already there, so there is no prior status and no double payment to detect.
      existingStatus: null,
    });
    const call = mocks.manualRefundTaskUpdateMany.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(call.data.status).toBe("DISMISSED");
    expect(call.data.status).not.toBe("COMPLETED");
    // No member did it, so no member is named as having done it.
    expect(call.data.completedByMemberId).toBeUndefined();
    expect(call.data.note).toContain(INTENT_ID);
    // Nothing was created: the row already existed and was claimed.
    expect(mocks.manualRefundTaskCreate).not.toHaveBeenCalled();
  });

  it("claims nothing on a replay, because the close is fenced on OPEN", async () => {
    // A webhook retry, or an operator who got there first, must claim nothing.
    await record();

    const call = mocks.manualRefundTaskUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(call.where.status).toBe("OPEN");
  });

  it("never touches an unrelated ManualRefundTask on the same booking", async () => {
    // `booking-cancel.ts` raises a cash/manual settlement task on the same
    // booking and payment. Only the reason distinguishes them, so the reason is
    // part of the match — for the close AND for the duplicate check behind it.
    await record();

    expect(mocks.manualRefundTaskUpdateMany.mock.calls[0][0]).toMatchObject({
      where: {
        bookingId: BOOKING_ID,
        paymentId: PAYMENT_ID,
        reason: { in: automaticCancelledBookingRefundTaskReasons(INTENT_ID) },
        status: "OPEN",
      },
    });
  });

  it("takes the global settlement lock before it reads or writes anything", async () => {
    /*
      #2760 REPLACES "needs no lock of its own", and the replacement is the point.

      Until #2760 this was one status-fenced `updateMany`, which is its own atomic
      claim and needed no lock. It is now close-or-create — a find-then-write —
      and two Stripe deliveries of one capture landing together would each find no
      row and each write one, putting a single refund on the card twice. It takes
      `pg_advisory_xact_lock(1)`, the same canonical global key the raise above
      holds and the one `booking-cancel.ts` holds when IT creates a
      ManualRefundTask, and nothing else. Every Stripe call is the caller's and is
      already finished before this runs.
    */
    mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 0 });

    await record();

    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.executeRaw.mock.calls[0][0].join("?")).toContain(
      "pg_advisory_xact_lock(1)",
    );
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.manualRefundTaskUpdateMany.mock.invocationCallOrder[0],
    );
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.manualRefundTaskCreate.mock.invocationCallOrder[0],
    );
  });

  it("writes the record itself, already DISMISSED, when no task was raised", async () => {
    /*
      #2760, and the whole reason the issue exists. Three of the four orderings
      never reach the confirm route's raise, so the close claimed nothing and the
      refund reached no screen. The row is now written here instead.
    */
    mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 0 });

    const outcome = await record();

    expect(outcome).toEqual({
      closed: 0,
      created: true,
      alreadyRecorded: false,
      existingStatus: null,
    });
    const created = mocks.manualRefundTaskCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(created.data.status).toBe("DISMISSED");
    // NEVER OPEN. An OPEN row is work, and there is none: completing one would
    // write a second refund allocation for money Stripe has already returned.
    expect(created.data.status).not.toBe("OPEN");
    expect(created.data.status).not.toBe("COMPLETED");
    expect(created.data.bookingId).toBe(BOOKING_ID);
    expect(created.data.paymentId).toBe(PAYMENT_ID);
    // The captured cents, as they were captured. Nothing recomputes a refund.
    expect(created.data.amountCents).toBe(AMOUNT_CENTS);
    // The CREATED arm's note, which shares the frozen prefix the card filters on
    // and differs after it: nothing was closed here, so a row that opened
    // "Closed automatically ... so there is nothing left to pay back by hand" and
    // stopped there told the operator reading the card something untrue about the
    // majority of its rows (review of #2760).
    expect(created.data.note).toBe(
      automaticCancelledBookingRefundNote(INTENT_ID, "created"),
    );
    expect(created.data.note).not.toBe(
      automaticCancelledBookingRefundNote(INTENT_ID, "closed"),
    );
    expect(created.data.note).toContain(
      AUTOMATIC_CANCELLED_BOOKING_REFUND_NOTE_PREFIX,
    );
    expect(created.data.note).toContain("this row is the record itself");
    // No acting member, which is the claim the finance card makes on screen.
    expect(created.data.completedByMemberId).toBeUndefined();
    // `completedAt` is written: the card's 30-day window and its ordering both
    // read it, so a row without one would be invisible on the surface it exists
    // for.
    expect(created.data.completedAt).toBeInstanceOf(Date);
  });

  it("stores the deleted-population sentence for a deleted booking", async () => {
    mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 0 });

    await record(true);

    const created = mocks.manualRefundTaskCreate.mock.calls[0][0] as {
      data: { reason: string };
    };
    expect(created.data.reason).toBe(
      deletedBookingModificationRefundReason(INTENT_ID),
    );
  });

  it("stores the cancelled-population sentence for a booking that is not deleted", async () => {
    /*
      #2760's second population, and why it needs its own sentence rather than
      sharing the deleted one: the deleted sentence says the booking "had already
      been deleted" and asks an operator to decide whether to refund. Both are
      false on a booking that is merely cancelled, and the card prints the
      sentence.
    */
    mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 0 });

    await record(false);

    const created = mocks.manualRefundTaskCreate.mock.calls[0][0] as {
      data: { reason: string };
    };
    expect(created.data.reason).toBe(
      cancelledBookingModificationRefundReason(INTENT_ID),
    );
    expect(created.data.reason).not.toContain("deleted");
    expect(created.data.reason).toContain(INTENT_ID);
    // `ManualRefundTask.reason` is VarChar(500).
    expect(created.data.reason.length).toBeLessThanOrEqual(500);
  });

  it("leaves a row it wrote itself exactly as it is, and calls it its own", async () => {
    // Stripe redelivery of one capture. Nothing is re-dated, re-noted, or
    // duplicated, and the outcome says the record already exists rather than that
    // something else accounted for it.
    mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 0 });
    mocks.manualRefundTaskFindFirst.mockResolvedValue(ownRecordRow());

    const outcome = await record();

    expect(outcome).toEqual({
      closed: 0,
      created: false,
      alreadyRecorded: "self",
      // #2774: this writer's own row is DISMISSED, which is not the status that
      // means an operator paid the member back by hand.
      existingStatus: "DISMISSED",
    });
    expect(mocks.manualRefundTaskCreate).not.toHaveBeenCalled();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it("reports a HAND-resolved row as such, and warns, because that refund reaches no card", async () => {
    /*
      The one ordering the finance card cannot show, found in review of #2760 and
      left as the conservative behaviour pending an owner ruling (#2774). An
      operator resolved the confirm route's OPEN task themselves before Stripe's
      refund landed, so the row carries THEIR note and `completedByMemberId` and
      matches neither the OPEN-fenced close nor
      `automaticallyRefundedManualRefundTaskFilter`. Writing a second row would put
      two `ManualRefundTask` rows on one capture - the property every lookup here
      exists to prevent - so the row is left alone and the gap is named at WARN,
      which is the only place it is named at all.
    */
    mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 0 });
    mocks.manualRefundTaskFindFirst.mockResolvedValue({
      id: "task-hand-dismissed",
      status: "DISMISSED",
      completedByMemberId: "member-operator",
      note: "Rang the member, sorted it out on the phone.",
    });

    const outcome = await record();

    expect(outcome).toEqual({
      closed: 0,
      created: false,
      alreadyRecorded: "hand-resolved",
      // #2774 D1: DISMISSED is the carve-out that issue keeps (the orchestrator's
      // call on its Recommended option, not the owner's) - settled another
      // way, no allocation written, nobody paid twice. COMPLETED in this field is
      // what the caller escalates as a suspected double payment.
      existingStatus: "DISMISSED",
    });
    expect(mocks.manualRefundTaskCreate).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    expect(mocks.logger.warn.mock.calls[0][0]).toMatchObject({
      bookingId: BOOKING_ID,
      paymentIntentId: INTENT_ID,
      existingStatus: "DISMISSED",
    });
  });

  it("treats a hand COMPLETED row the same way, and never reopens or rewrites it", async () => {
    // A human handed the money back before the webhook arrived. Reopening or
    // re-noting it would rewrite an operator's own record of a refund they made.
    mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 0 });
    mocks.manualRefundTaskFindFirst.mockResolvedValue({
      id: "task-hand-completed",
      status: "COMPLETED",
      completedByMemberId: "member-operator",
      note: "Paid back by internet banking.",
    });

    const outcome = await record();

    expect(outcome.alreadyRecorded).toBe("hand-resolved");
    expect(mocks.manualRefundTaskCreate).not.toHaveBeenCalled();
    expect(mocks.manualRefundTaskUpdateMany).toHaveBeenCalledTimes(1);
    expect(
      (
        mocks.manualRefundTaskUpdateMany.mock.calls[0][0] as {
          where: { status: string };
        }
      ).where.status,
    ).toBe("OPEN");
  });

  it("budgets its transaction for lock(1) contention rather than taking Prisma's defaults", async () => {
    /*
      The blocker this pins (review of #2760). The advisory wait counts against the
      interactive-transaction budget, and Prisma's default is maxWait 2s / timeout
      5s while the longest-lived holder of lock(1) in the tree - `assignBedRange` -
      runs on `{ maxWait: 10_000, timeout: 30_000 }`. On the defaults an admin
      assigning a bed range concurrently with a Stripe delivery blows this
      transaction with a P2028; the caller must not fail the webhook, so the row
      would simply be lost and Stripe never redelivers a 200. Tighter than the
      admin precedent on purpose: a webhook has Stripe's delivery timeout over it.
    */
    await record();

    const [, options] = mocks.transaction.mock.calls[0] as [
      unknown,
      { maxWait?: number; timeout?: number } | undefined,
    ];
    expect(options).toBeDefined();
    expect(options?.timeout).toBeGreaterThan(5_000);
    expect(options?.timeout).toBeLessThan(30_000);
    expect(options?.maxWait).toBeGreaterThan(2_000);
    expect(options?.maxWait).toBeLessThan(10_000);
  });

  it("finds a row of EITHER population, so a deletion between deliveries writes no second row", async () => {
    /*
      The producible duplicate this guards. Delivery 1 sees a cancelled booking
      and writes the cancelled-population row; an admin then deletes the booking;
      Stripe redelivers and this writer now sees the deleted population. Keyed per
      population, that redelivery finds nothing and writes a second row for one
      refund.
    */
    mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 0 });
    const rows = [
      {
        ...ownRecordRow(),
        id: "task-cancelled-population",
        reason: cancelledBookingModificationRefundReason(INTENT_ID),
      },
    ];
    mocks.manualRefundTaskFindFirst.mockImplementation(
      async (args: { where: { reason: { in: string[] } } }) =>
        rows.find((row) => args.where.reason.in.includes(row.reason)) ?? null,
    );

    const outcome = await record(true);

    expect(outcome.created).toBe(false);
    expect(outcome.alreadyRecorded).toBe("self");
    expect(mocks.manualRefundTaskCreate).not.toHaveBeenCalled();
  });

  it("reports the close rather than creating when a task was claimed", async () => {
    mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 1 });

    const outcome = await record();

    expect(outcome.closed).toBe(1);
    expect(mocks.manualRefundTaskFindFirst).not.toHaveBeenCalled();
    expect(mocks.manualRefundTaskCreate).not.toHaveBeenCalled();
  });
});
