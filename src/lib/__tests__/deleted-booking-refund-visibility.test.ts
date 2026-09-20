import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2750 — the record is only "a human is told" if a human can see it.
 *
 * THE DECISION, AND WHY THERE IS NO GATE HERE. Since #1350 the Stripe webhook
 * refunds a modification payment captured against an already-CANCELLED booking
 * automatically, and a soft-deleted booking is always CANCELLED
 * (`INV-ADDPAY-030`), so a late capture on a deleted booking is refunded before
 * anybody sees it. #2750 kept that deliberately: the member's money going back
 * is the safe direction when nobody is watching, and gating it leaves the club
 * holding a member's money until somebody acts. What #2750 changed is that the
 * `ManualRefundTask` the webhook closes behind itself now reaches an operator —
 * `/admin/payments` lists rows matching
 * `automaticallyRefundedManualRefundTaskFilter` as a read-only card.
 *
 * NO MONEY BEHAVIOUR CHANGED, and the round trip at the bottom pins that from
 * the money side: still exactly one task per capture, still closed exactly once,
 * replays included.
 *
 * THE CARD IS COMPLETE SINCE #2760 (owner decision 10 Aug 2026), and the
 * orderings that used to leave no row are pinned below as rows that now exist.
 * #2750 shipped a partial record: a `ManualRefundTask` existed only where the
 * member's browser reached the confirm endpoint before the Stripe webhook did,
 * and the confirm route only raises one for a DELETED booking at all. The webhook
 * now writes the row itself whenever its fenced close claims nothing — for a
 * deleted booking AND for one that is cancelled but still on file, which the
 * owner chose deliberately over the narrower recommendation. "What the card
 * cannot show" below is therefore now "what the card shows on every ordering",
 * and `INV-ADDPAY-037`'s qualification is lifted in the same change.
 *
 * BOTH POPULATIONS, EVERY ORDERING, EXACTLY ONE ROW. That is the acceptance
 * criterion the owner extended the issue body with, and the round trips at the
 * bottom are it: webhook-first, confirm-first, member-never-returns, interleaved,
 * plus Stripe redelivery and confirm retries, on a deleted booking and on a
 * merely cancelled one.
 *
 * NO MONEY BEHAVIOUR CHANGED. Still one row per capture, still DISMISSED, still
 * no allocation and no operator queued.
 *
 * MUTATION PROOF. Reword the note prefix and "pins the stored bytes of the note
 * prefix" fails — that one assertion is a golden string precisely because every
 * other one derives its expectation from the constant and so cannot catch a
 * reword. Reword the writer's note without moving the shared constant and
 * "the note the writer writes is the note the surface matches on" fails. Drop
 * `completedByMemberId: null` from the filter and "an operator's own dismissal is
 * never presented as an automatic refund" fails on its first row; drop the note
 * condition and the same test fails on its second, which is the row the schema's
 * `onDelete: SetNull` produces. Widen the filter to any DISMISSED row and "an
 * OPEN task is work, not a notice" fails. Break the raise's idempotence, the
 * close's OPEN fence, or the writer's duplicate check and one of the six ordering
 * round trips fails. Write the created row OPEN, or with an acting member, and
 * every ordering that goes through the webhook stops matching the filter.
 */

const mocks = vi.hoisted(() => ({
  manualRefundTaskFindFirst: vi.fn(),
  manualRefundTaskCreate: vi.fn(),
  manualRefundTaskUpdateMany: vi.fn(),
  paymentTransactionFindUnique: vi.fn(),
  executeRaw: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // #2760: the writer became close-or-create and moved inside a transaction
    // under the same global lock the raise takes, so there is no bare
    // `prisma.manualRefundTask` call left in the module.
    $transaction: (...args: unknown[]) => mocks.transaction(...args),
  },
}));

import {
  AUTOMATIC_CANCELLED_BOOKING_REFUND_NOTE_PREFIX,
  cancelledBookingModificationRefundReason,
  cancelledBookingPrimaryPaymentRefundReason,
  deletedBookingPrimaryPaymentRefundReason,
  AUTOMATIC_REFUND_NOTICE_WINDOW_DAYS,
  automaticCancelledBookingRefundNote,
  automaticallyRefundedManualRefundTaskFilter,
  raiseDeletedBookingModificationRefundTask,
  recordAutomaticCancelledBookingRefundTask,
} from "@/lib/deleted-booking-modification-payment";

const BOOKING_ID = "booking-1";
const PAYMENT_ID = "payment-1";
const INTENT_ID = "pi_modification";
const AMOUNT_CENTS = 2500;

interface StoredTask {
  id: string;
  bookingId: string;
  paymentId: string;
  reason: string;
  status: string;
  note: string | null;
  completedByMemberId: string | null;
}

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

function raise() {
  return raiseDeletedBookingModificationRefundTask({
    bookingId: BOOKING_ID,
    paymentId: PAYMENT_ID,
    paymentIntentId: INTENT_ID,
    amountCents: AMOUNT_CENTS,
  });
}

/**
 * The webhook's writer: closes an OPEN raise, or writes the row itself.
 *
 * `captureKind` defaults to `"modification"`, the kind every ordering in this file
 * was written against; #2773's primary kind is passed explicitly by the tests
 * that are about it.
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

/**
 * Applies the exported filter's own conditions to a candidate row.
 *
 * A unit test has no database, so the alternative is asserting only the filter's
 * shape — which cannot catch a filter whose shape is fine and whose semantics
 * still admit an operator's own dismissal. This reads each condition off the
 * exported object rather than restating it, so it goes wrong exactly when the
 * filter goes wrong.
 */
function matchesFilter(row: {
  status: string;
  completedByMemberId: string | null;
  note: string | null;
}): boolean {
  const filter = automaticallyRefundedManualRefundTaskFilter as {
    status: string;
    completedByMemberId: null;
    note: { startsWith: string };
  };
  return (
    row.status === filter.status &&
    row.completedByMemberId === filter.completedByMemberId &&
    (row.note ?? "").startsWith(filter.note.startsWith)
  );
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
  mocks.paymentTransactionFindUnique.mockResolvedValue({
    status: "SUCCEEDED",
    refundedAmountCents: 0,
    amountCents: AMOUNT_CENTS,
  });
});

describe("the note the writer writes and the surface reads (#2750)", () => {
  it("pins the stored bytes of the note prefix, which are data and not copy", () => {
    /*
      A GOLDEN STRING, deliberately, and the one assertion in this file that does
      NOT derive its expectation from the constant.

      Every other assertion here reads the expected value off
      `AUTOMATIC_CANCELLED_BOOKING_REFUND_NOTE_PREFIX`, which is right for proving
      writer and reader agree — and is a tautology with respect to the value
      itself. Rewording the constant would keep all of them green while making
      every note ALREADY IN THE DATABASE stop matching `startsWith`, silently
      emptying the card of every automatic refund the club has had so far. That is
      the exact defect #2750 exists to close, arriving through the back door.

      So these bytes are stored data, not display copy. Changing them needs a
      migration that rewrites the existing notes (or a reader that matches both
      the old and the new prefix), not an edit here. Reworded on purpose? Then
      update this string in the same commit as that migration and say so.
    */
    expect(AUTOMATIC_CANCELLED_BOOKING_REFUND_NOTE_PREFIX).toBe(
      "Closed automatically: Stripe refunded this capture under the cancelled-booking late-capture path",
    );
  });

  it("the note the writer writes is the note the surface matches on", async () => {
    // Two copies of one sentence would not fail a build. It would silently empty
    // the card, which is the entire mechanism by which anybody is told.
    await record();

    const call = mocks.manualRefundTaskUpdateMany.mock.calls[0][0] as {
      data: { note: string };
    };
    expect(call.data.note).toBe(automaticCancelledBookingRefundNote(INTENT_ID));
    expect(
      call.data.note.startsWith(AUTOMATIC_CANCELLED_BOOKING_REFUND_NOTE_PREFIX),
    ).toBe(true);
    expect(automaticallyRefundedManualRefundTaskFilter.note).toEqual({
      startsWith: AUTOMATIC_CANCELLED_BOOKING_REFUND_NOTE_PREFIX,
    });
  });

  it("still fits the 500-char column for an implausibly long payment intent id", () => {
    const note = automaticCancelledBookingRefundNote("pi_".padEnd(600, "x"));

    expect(note.length).toBeLessThanOrEqual(500);
  });

  it("leaves no acting member, which is what the card claims on screen", async () => {
    await record();

    const call = mocks.manualRefundTaskUpdateMany.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    // Neither the close nor the create writes `completedByMemberId`, so the
    // column keeps its NULL and the card's "no person did this" claim holds.
    expect(call.data.completedByMemberId).toBeUndefined();
    expect(automaticallyRefundedManualRefundTaskFilter).toMatchObject({
      status: "DISMISSED",
      completedByMemberId: null,
    });
  });

  it("bounds the card's reach to a review window rather than all history", () => {
    // Unbounded is the state that makes an operator stop reading the card.
    expect(AUTOMATIC_REFUND_NOTICE_WINDOW_DAYS).toBeGreaterThan(0);
    expect(AUTOMATIC_REFUND_NOTICE_WINDOW_DAYS).toBeLessThanOrEqual(90);
  });
});

describe("which rows the operator surface shows (#2750)", () => {
  it("shows the row the webhook closed", () => {
    expect(
      matchesFilter({
        status: "DISMISSED",
        completedByMemberId: null,
        note: automaticCancelledBookingRefundNote(INTENT_ID),
      }),
    ).toBe(true);
  });

  it("an operator's own dismissal is never presented as an automatic refund", () => {
    // Two rows, failing on different halves of the filter. The first is an
    // ordinary hand dismissal. The second is that same dismissal after the
    // member who made it was deleted: `ManualRefundTask.completedBy` is
    // `onDelete: SetNull`, so the column that said who did it now says nobody
    // did — and on the note condition alone being dropped, the club's own
    // deliberate dismissal would be shown as a refund it never made.
    expect(
      matchesFilter({
        status: "DISMISSED",
        completedByMemberId: "member-1",
        note: "Member asked us to keep it as a donation",
      }),
    ).toBe(false);
    expect(
      matchesFilter({
        status: "DISMISSED",
        completedByMemberId: null,
        note: "Member asked us to keep it as a donation",
      }),
    ).toBe(false);
  });

  it("an OPEN task is work, not a notice", () => {
    // It belongs in the hand-back queue above, where it has buttons.
    expect(
      matchesFilter({ status: "OPEN", completedByMemberId: null, note: null }),
    ).toBe(false);
  });

  it("a COMPLETED task is money an operator handed back by hand", () => {
    expect(
      matchesFilter({
        status: "COMPLETED",
        completedByMemberId: "member-1",
        note: "Cash handed back at the lodge",
      }),
    ).toBe(false);
  });
});

/**
 * A fake `ManualRefundTask` table, one row per create, shared by every ordering
 * round trip below.
 *
 * A unit test has no database, so the orderings are only meaningful if the raise
 * and the webhook writer see each other's writes. This is the smallest store that
 * makes them: it honours the `reason IN (...)` match both writers use, the OPEN
 * fence on the close, and the "across every status" duplicate check, so a broken
 * fence or a per-population key shows up as a second row rather than as a passing
 * assertion about mock arguments.
 */
interface TaskWhere {
  bookingId: string;
  paymentId: string;
  reason: string | { in: string[] };
  status?: string;
}

function installTaskStore() {
  const rows: StoredTask[] = [];
  let nextId = 1;

  const matches = (row: StoredTask, where: TaskWhere) =>
    row.bookingId === where.bookingId &&
    row.paymentId === where.paymentId &&
    (typeof where.reason === "string"
      ? row.reason === where.reason
      : where.reason.in.includes(row.reason)) &&
    (where.status === undefined || row.status === where.status);

  mocks.manualRefundTaskFindFirst.mockImplementation(
    async (args: { where: TaskWhere }) =>
      rows.find((row) => matches(row, args.where)) ?? null,
  );
  mocks.manualRefundTaskCreate.mockImplementation(
    async (args: { data: Record<string, unknown> }) => {
      const row: StoredTask = {
        id: `task-${nextId++}`,
        bookingId: args.data.bookingId as string,
        paymentId: args.data.paymentId as string,
        reason: args.data.reason as string,
        status: args.data.status as string,
        note: (args.data.note as string | undefined) ?? null,
        completedByMemberId:
          (args.data.completedByMemberId as string | undefined) ?? null,
      };
      rows.push(row);
      return { id: row.id };
    },
  );
  mocks.manualRefundTaskUpdateMany.mockImplementation(
    async (args: { where: TaskWhere; data: { status: string; note: string } }) => {
      const claimed = rows.filter((row) => matches(row, args.where));
      for (const row of claimed) {
        row.status = args.data.status;
        row.note = args.data.note;
      }
      return { count: claimed.length };
    },
  );

  return rows;
}

describe("the record is complete: every ordering, both populations (#2760)", () => {
  /*
    WHAT THIS DESCRIBE REPLACED, AND WHY THAT IS THE POINT.

    Until #2760 this file carried "what the card cannot show": two tests pinning
    that a webhook-first refund and the interleaved ordering left NO row, because
    the confirm endpoint was the only writer of one and the card was therefore a
    partial record. The owner's 10 Aug 2026 decision reversed that on purpose — the
    webhook writes the row itself when its fenced close claims nothing — and
    widened it to every cancelled booking rather than only deleted ones. So the
    same orderings are pinned here with the opposite expectation, which is exactly
    the "changed on purpose" the old comment asked for.

    Each case runs the writers against one in-memory table and asserts EXACTLY ONE
    row that the finance card's filter matches. One row, not "at least one": two
    rows for one refund would show a single money movement twice on a card whose
    entire job is to be trusted.
  */
  it("webhook first, on a deleted booking: the webhook writes the row itself", async () => {
    // The ordinary healthy case. Nothing raised a task, so the OPEN-fenced close
    // claims nothing and the row is created already DISMISSED.
    const rows = installTaskStore();

    const outcome = await record(true);

    expect(outcome.created).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("DISMISSED");
    expect(matchesFilter(rows[0])).toBe(true);
  });

  it("webhook first, on a booking cancelled but not deleted: also a row", async () => {
    // The population #2760 added. The confirm route's raise NEVER fires here — it
    // is gated on `deletedAt` — so before #2760 this refund reached no screen at
    // all, whichever order things arrived in.
    const rows = installTaskStore();

    const outcome = await record(false);

    expect(outcome.created).toBe(true);
    expect(rows).toHaveLength(1);
    expect(matchesFilter(rows[0])).toBe(true);
  });

  it("the member never returns to the confirm step: still exactly one row", async () => {
    /*
      The member pays and closes the tab, so the confirm endpoint is never called
      at all. Indistinguishable from webhook-first as far as this module can see —
      and that is the assertion: the record does not depend on the member's
      browser coming back, which is what made it partial before.
    */
    const rows = installTaskStore();

    await record(true);
    // Stripe redelivers the same event; the member still never returns.
    await record(true);

    expect(rows).toHaveLength(1);
    expect(mocks.manualRefundTaskCreate).toHaveBeenCalledTimes(1);
  });

  it("confirm first: the raise's OPEN task is closed, never duplicated", async () => {
    // The one ordering that produced a row before #2760, unchanged: the raise
    // creates it OPEN, the webhook's close claims it, and nothing is created.
    const rows = installTaskStore();

    const raised = await raise();
    expect(raised.created).toBe(true);
    expect(rows[0].status).toBe("OPEN");

    const outcome = await record(true);

    expect(outcome).toEqual({
      closed: 1,
      created: false,
      alreadyRecorded: false,
      // #2774: null whenever this call closed or created the row - nothing was
      // already there, so there is no prior status and no double payment to detect.
      existingStatus: null,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("DISMISSED");
    expect(matchesFilter(rows[0])).toBe(true);
  });

  it("interleaved: the raise still declines, and the webhook's row is the record", async () => {
    /*
      Stripe refunded the capture inside the confirm route's own round trip. The
      raise's refund fence still declines to queue an operator to hand back money
      that has already gone — that behaviour is deliberately unchanged — but the
      refund is no longer invisible, because the webhook wrote the row.
    */
    const rows = installTaskStore();

    await record(true);
    // The confirm route now catches up. Its transaction row shows the refund.
    mocks.paymentTransactionFindUnique.mockResolvedValue({
      status: "REFUNDED",
      refundedAmountCents: AMOUNT_CENTS,
      amountCents: AMOUNT_CENTS,
    });

    const raised = await raise();

    // It finds the webhook's row on the duplicate check, so it does not even
    // reach the refund fence — either way, no second row and no OPEN task.
    expect(raised.created).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("DISMISSED");
  });

  it("Stripe redelivery does not re-date or duplicate the row", async () => {
    const rows = installTaskStore();

    await record(true);
    const noteAfterFirst = rows[0].note;

    const second = await record(true);

    // `"self"`, not a bare `true`: the writer recognises its OWN row (DISMISSED,
    // no acting member, its note prefix) and says so, because the caller has to
    // tell that apart from a row an operator resolved by hand — which is on no
    // card at all. See the next case.
    expect(second).toEqual({
      closed: 0,
      created: false,
      alreadyRecorded: "self",
      // #2774: this writer's own row is DISMISSED, which is not the status that
      // means an operator paid the member back by hand.
      existingStatus: "DISMISSED",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe(noteAfterFirst);
  });

  it("an operator who closed the hand-back task by hand first leaves the refund on NO card, and the writer says so", async () => {
    /*
      THE ONE ORDERING THIS RECORD DOES NOT COVER, pinned against the real store
      rather than left unasserted (review of #2760 found nothing pinned it either
      way). The confirm route raised an OPEN task, an operator resolved it
      themselves before Stripe's refund landed, and the refund then arrives.

      The OPEN-fenced close claims nothing (the row has moved), and the writer
      refuses to create a second row — one `ManualRefundTask` per capture is the
      property every lookup here protects, and widening the card's filter to admit
      actor-bearing rows would present a hand dismissal as an automatic refund,
      which is the #2750 defect. So the row stays exactly as the operator left it,
      the card's filter does not match it, and the outcome is `"hand-resolved"` so
      the caller can name the gap. Whether the webhook should write its own row
      anyway is #2774.
    */
    const rows = installTaskStore();

    const raised = await raise();
    expect(raised.created).toBe(true);
    // The operator resolves it: their own note, their member id, no longer OPEN.
    rows[0].status = "DISMISSED";
    rows[0].completedByMemberId = "member-operator";
    rows[0].note = "Rang the member and sorted it out on the phone.";

    const outcome = await record(true);

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
    expect(rows).toHaveLength(1);
    // Untouched: not re-dated, not re-noted, not reopened.
    expect(rows[0].completedByMemberId).toBe("member-operator");
    expect(rows[0].note).toBe("Rang the member and sorted it out on the phone.");
    // And it is on neither card: the hand-back queue lists OPEN, and the record
    // card's filter needs a null acting member and the automatic note prefix.
    expect(rows[0].status).not.toBe("OPEN");
    expect(matchesFilter(rows[0])).toBe(false);
  });

  it("a confirm retry after the webhook has recorded raises nothing", async () => {
    // The retried confirm matches across EVERY status and both population
    // sentences, so the webhook's DISMISSED row stops it raising an OPEN one for
    // money already returned.
    const rows = installTaskStore();

    await record(true);
    const retry = await raise();

    expect(retry.created).toBe(false);
    expect(retry.taskId).toBe(rows[0].id);
    expect(rows).toHaveLength(1);
  });

  it("a deletion landing between two deliveries still leaves one row", async () => {
    // Delivery 1 sees a cancelled booking, delivery 2 sees a deleted one. Keyed
    // per population, the second delivery would write a second row for one
    // refund.
    const rows = installTaskStore();

    await record(false);
    const second = await record(true);

    expect(second.created).toBe(false);
    expect(rows).toHaveLength(1);
    // The row keeps the sentence that was true when it was written.
    expect(rows[0].reason).toBe(
      cancelledBookingModificationRefundReason(INTENT_ID),
    );
  });

  it("records the booking's OWN payment too, with its own sentence (#2773)", async () => {
    /*
      #2773. The primary handler refunded the same way and left NO row at all until
      now, and the sentence it stores has to be its own: the modification sentences
      open "Booking modification payment ...", which is false about a booking's own
      payment and is printed verbatim on the finance card.

      On this path there is never an OPEN task to close - nothing in the tree raises
      one for a primary intent - so the create arm is the only reachable one, which
      is exactly why "the card is complete" has to be checked here separately rather
      than inferred from the modification orderings above.
    */
    const rows = installTaskStore();

    const deleted = await record(true, "primary");

    expect(deleted.created).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe(
      deletedBookingPrimaryPaymentRefundReason(INTENT_ID),
    );
    // And it lands on the card: DISMISSED, no acting member, automatic note prefix.
    expect(rows[0].status).toBe("DISMISSED");
    expect(matchesFilter(rows[0])).toBe(true);

    const cancelledRows = installTaskStore();
    await record(false, "primary");
    expect(cancelledRows[0].reason).toBe(
      cancelledBookingPrimaryPaymentRefundReason(INTENT_ID),
    );
    expect(matchesFilter(cancelledRows[0])).toBe(true);
  });

  it("a Stripe redelivery of a primary capture writes no second row (#2773)", async () => {
    // The lookup matches all four sentences, so the redelivery finds the row this
    // writer already wrote regardless of kind or population.
    const rows = installTaskStore();

    await record(true, "primary");
    const redelivery = await record(true, "primary");

    expect(redelivery.created).toBe(false);
    expect(redelivery.alreadyRecorded).toBe("self");
    expect(rows).toHaveLength(1);
  });

  it("a deletion between two primary deliveries still leaves one row (#2773)", async () => {
    // The population can change under us; the capture kind cannot. Both are covered
    // by the same four-sentence lookup.
    const rows = installTaskStore();

    await record(false, "primary");
    const second = await record(true, "primary");

    expect(second.created).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe(
      cancelledBookingPrimaryPaymentRefundReason(INTENT_ID),
    );
  });

  it("never leaves an OPEN row behind, on either population", async () => {
    // An OPEN row is work an operator is asked to do, and there is none: Stripe
    // returned the money before anybody saw the capture, and completing such a
    // task throws out of `applyLocalRefundAllocation`.
    const deletedRows = installTaskStore();
    await record(true);
    expect(deletedRows.every((row) => row.status === "DISMISSED")).toBe(true);

    const cancelledRows = installTaskStore();
    await record(false);
    expect(cancelledRows.every((row) => row.status === "DISMISSED")).toBe(true);
  });
});
