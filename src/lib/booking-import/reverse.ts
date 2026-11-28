/**
 * Reversing a paid-booking import batch (#5005, child B; `INV-PAY-163`).
 *
 * A batch is reversed booking by booking, and only the bookings nobody has
 * touched since the import are reversed: still PAID, the stay not started, no
 * edit, no refund, no refund task, no card payment and no Xero link
 * (`INV-PAY-045` plus "not edited"). A touched booking is kept and named.
 *
 * Each untouched booking goes through two existing writers, never a copy:
 *
 *  1. `reverseManualBookingPayment` takes the manual payment back. Under its
 *     locks (lock(1), the lodge key, the Payment row) its `beforeReverse` hook
 *     re-checks "untouched" and claims the import row REVERSED with a
 *     status-guarded update, so the row and the money move together or not at
 *     all. A free stay has no manual payment: a short transaction under the
 *     same two keys re-checks and claims the row instead.
 *  2. `cancelBooking` then cancels the now-unpaid booking with no email, no
 *     refund and its beds released.
 *
 * Resumable: a REVERSED row whose booking is not yet cancelled is cancelled
 * on the next run, so a run stopped between the two steps finishes later.
 * Running it again on a finished batch changes nothing. A reversed row frees
 * its Booking Ref, because the partial unique index covers IMPORTED rows only.
 */
import {
  BookingImportBatchStatus,
  BookingImportRowStatus,
  BookingStatus,
  PaymentSource,
  type Prisma,
} from "@prisma/client";

import { logAudit } from "@/lib/audit";
import { cancelBooking } from "@/lib/booking-cancel";
import { bookingStayHasStarted } from "@/lib/booking-edit-policy";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import type { ClubFormat } from "@/lib/club-time";
import { LOCK1_HOLDER_TRANSACTION_BUDGET } from "@/lib/db-transaction";
import { ManualBookingPaymentError } from "@/lib/manual-booking-payment-error";
import { reverseManualBookingPayment } from "@/lib/payment-reconciliation";
import { prisma } from "@/lib/prisma";

type Db = Prisma.TransactionClient | typeof prisma;

/** Thrown under the locks to roll a booking's reversal back and keep it. */
class ImportReversalKept extends Error {
  constructor(readonly reasons: string[]) {
    super("BOOKING_IMPORT_REVERSAL_KEPT");
  }
}

const CHANGED_AFTER_REVERSAL =
  "Its payment was reversed, but the booking changed before it could be cancelled; check it and cancel it by hand if it should go";

/**
 * Why an imported booking can no longer be reversed: empty when it is
 * untouched. Plain sentences an officer may read; none names a person.
 * The reversal writer's own refusals (`INV-PAY-045`) are a second wall.
 */
export async function importedBookingTouches(
  db: Db,
  input: { bookingId: string; importedAmountCents: number; today: Date },
): Promise<string[]> {
  const booking = await db.booking.findUnique({
    where: { id: input.bookingId },
    select: {
      status: true,
      checkIn: true,
      finalPriceCents: true,
      payment: {
        select: {
          id: true,
          amountCents: true,
          refundedAmountCents: true,
          manuallyMarkedPaidAt: true,
          stripePaymentIntentId: true,
          xeroInvoiceId: true,
        },
      },
    },
  });
  if (!booking) return ["The booking no longer exists"];
  const reasons: string[] = [];
  if (booking.status === BookingStatus.CANCELLED) reasons.push("It has been cancelled");
  else if (booking.status !== BookingStatus.PAID) reasons.push("It is no longer marked paid");
  if (bookingStayHasStarted(booking.checkIn, input.today)) reasons.push("The stay has started");

  const [modifications, refundTasks] = await Promise.all([
    db.bookingModification.count({ where: { bookingId: input.bookingId } }),
    db.manualRefundTask.count({ where: { bookingId: input.bookingId } }),
  ]);
  if (modifications > 0 || booking.finalPriceCents !== input.importedAmountCents) {
    reasons.push("It has been edited since the import");
  }
  if (refundTasks > 0) reasons.push("It has a refund task");

  const payment = booking.payment;
  if (!payment) return [...reasons, "Its payment record is missing"];
  const [refunds, cardTransactions, xeroOperations] = await Promise.all([
    db.paymentRefund.count({ where: { paymentId: payment.id } }),
    db.paymentTransaction.count({ where: { paymentId: payment.id, source: PaymentSource.STRIPE } }),
    db.xeroSyncOperation.count({ where: { localId: { in: [input.bookingId, payment.id] } } }),
  ]);
  if (payment.refundedAmountCents !== 0 || refunds > 0) reasons.push("Money has been refunded on it");
  if (payment.stripePaymentIntentId || cardTransactions > 0) reasons.push("A card payment has been started or taken on it");
  if (payment.xeroInvoiceId || xeroOperations > 0) reasons.push("It has been linked to Xero");
  const settledAsImported =
    payment.amountCents === input.importedAmountCents &&
    (input.importedAmountCents === 0 ? payment.manuallyMarkedPaidAt === null : payment.manuallyMarkedPaidAt !== null);
  if (!settledAsImported) reasons.push("Its recorded payment has changed since the import");
  return reasons;
}

export type BookingImportReversalRowState =
  /** Will be reversed. */
  | "UNTOUCHED"
  /** Kept: something has happened to it since the import. */
  | "TOUCHED"
  /** Already reversed (its booking may still be awaiting cancellation). */
  | "REVERSED"
  /** Refused at import, so there is nothing to reverse. */
  | "NOT_IMPORTED";

export type BookingImportReversalRow = {
  bookingRef: string;
  firstLineNumber: number;
  bookingId: string | null;
  state: BookingImportReversalRowState;
  reasons: string[];
  amountCents: number;
  guestCount: number;
  guestNightCount: number;
};

export type BookingImportReversalTotals = {
  bookings: number;
  guests: number;
  guestNights: number;
  amountCents: number;
};

export type BookingImportReversalPlan = {
  batchId: string;
  lodgeId: string;
  status: BookingImportBatchStatus;
  rows: BookingImportReversalRow[];
  totals: Record<BookingImportReversalRowState, BookingImportReversalTotals>;
};

const emptyTotals = (): BookingImportReversalTotals => ({ bookings: 0, guests: 0, guestNights: 0, amountCents: 0 });

/**
 * What a reversal would do, read-only: which bookings are untouched and which
 * are kept, and why, before anything changes. Null when there is no batch.
 */
export async function planBookingImportReversal(
  db: Db,
  input: { batchId: string; today: Date },
): Promise<BookingImportReversalPlan | null> {
  const batch = await db.bookingImportBatch.findUnique({
    where: { id: input.batchId },
    select: { id: true, lodgeId: true, status: true },
  });
  if (!batch) return null;
  const rows = await db.bookingImportRow.findMany({
    where: { batchId: batch.id },
    orderBy: { firstLineNumber: "asc" },
    select: {
      bookingRef: true,
      firstLineNumber: true,
      status: true,
      bookingId: true,
      amountCents: true,
      guestCount: true,
      guestNightCount: true,
    },
  });
  const totals: BookingImportReversalPlan["totals"] = {
    UNTOUCHED: emptyTotals(),
    TOUCHED: emptyTotals(),
    REVERSED: emptyTotals(),
    NOT_IMPORTED: emptyTotals(),
  };
  const planned: BookingImportReversalRow[] = [];
  for (const row of rows) {
    let state: BookingImportReversalRowState;
    let reasons: string[] = [];
    if (row.status === BookingImportRowStatus.REVERSED) state = "REVERSED";
    else if (row.status !== BookingImportRowStatus.IMPORTED || !row.bookingId) state = "NOT_IMPORTED";
    else {
      reasons = await importedBookingTouches(db, {
        bookingId: row.bookingId,
        importedAmountCents: row.amountCents,
        today: input.today,
      });
      state = reasons.length === 0 ? "UNTOUCHED" : "TOUCHED";
    }
    const sum = totals[state];
    sum.bookings += 1;
    sum.guests += row.guestCount;
    sum.guestNights += row.guestNightCount;
    sum.amountCents += row.amountCents;
    planned.push({
      bookingRef: row.bookingRef,
      firstLineNumber: row.firstLineNumber,
      bookingId: row.bookingId,
      state,
      reasons,
      amountCents: row.amountCents,
      guestCount: row.guestCount,
      guestNightCount: row.guestNightCount,
    });
  }
  return { batchId: batch.id, lodgeId: batch.lodgeId, status: batch.status, rows: planned, totals };
}

export type BookingImportReversalRowResult =
  | { bookingRef: string; outcome: "REVERSED"; bookingId: string }
  | { bookingRef: string; outcome: "KEPT"; bookingId: string; reasons: string[] }
  /** Its payment was reversed but the cancel did not finish; the next run retries it. */
  | { bookingRef: string; outcome: "CANCEL_PENDING"; bookingId: string; reason: string };

export type BookingImportReversalResult =
  | { outcome: "not_found" }
  /** The batch is still being imported: finish the import first. */
  | { outcome: "not_completed" }
  | {
      outcome: "reversed";
      batchId: string;
      rows: BookingImportReversalRowResult[];
      /** Bookings left for another run when `maxBookings` stopped this one. */
      remaining: number;
    };

/**
 * Reverse a completed batch. Safe to run again: a finished row is skipped, a
 * row stopped half-way is finished, and each row's claim makes a concurrent
 * reversal take each booking once. `maxBookings` bounds one call so a route
 * can repeat it until `remaining` is zero.
 */
export async function reverseBookingImport(input: {
  batchId: string;
  officerMemberId: string;
  today: Date;
  format: ClubFormat;
  ipAddress: string;
  maxBookings?: number;
}): Promise<BookingImportReversalResult> {
  const batch = await prisma.bookingImportBatch.findUnique({
    where: { id: input.batchId },
    select: { id: true, lodgeId: true, status: true },
  });
  if (!batch) return { outcome: "not_found" };
  if (batch.status === BookingImportBatchStatus.OPEN) return { outcome: "not_completed" };

  // The batch is claimed once, by whichever reversal gets there first; a
  // reversed batch's file can no longer be confirmed (`confirmBookingImport`).
  const claimed = await prisma.bookingImportBatch.updateMany({
    where: { id: batch.id, status: BookingImportBatchStatus.COMPLETED },
    data: {
      status: BookingImportBatchStatus.REVERSED,
      reversedByMemberId: input.officerMemberId,
      reversedAt: new Date(),
    },
  });

  // A REVERSED row whose booking is not yet cancelled is unfinished work, so
  // it is picked up again alongside the still-imported rows.
  const rows = await prisma.bookingImportRow.findMany({
    where: {
      batchId: batch.id,
      bookingId: { not: null },
      OR: [
        { status: BookingImportRowStatus.IMPORTED },
        { status: BookingImportRowStatus.REVERSED, booking: { status: { not: BookingStatus.CANCELLED } } },
      ],
    },
    orderBy: { firstLineNumber: "asc" },
    select: { id: true, bookingRef: true, status: true, bookingId: true, amountCents: true },
  });
  const limit = input.maxBookings ?? rows.length;
  const results: BookingImportReversalRowResult[] = [];
  for (const row of rows.slice(0, limit)) {
    results.push(await reverseOneRow(input, batch.lodgeId, { ...row, bookingId: row.bookingId! }));
  }

  const reversed = results.filter((row) => row.outcome === "REVERSED").length;
  const kept = results.filter((row) => row.outcome === "KEPT").length;
  if (claimed.count === 1 || reversed > 0) {
    logAudit({
      action: "booking_import.reversed",
      memberId: input.officerMemberId,
      actorMemberId: input.officerMemberId,
      entityType: "BookingImportBatch",
      entityId: batch.id,
      targetId: batch.id,
      category: "booking",
      outcome: "success",
      summary: "Paid-booking import batch reversed",
      metadata: {
        lodgeId: batch.lodgeId,
        firstRun: claimed.count === 1,
        reversed,
        kept,
        cancelPending: results.length - reversed - kept,
      },
    });
  }
  return { outcome: "reversed", batchId: batch.id, rows: results, remaining: Math.max(0, rows.length - limit) };
}

type ReversalRow = {
  id: string;
  bookingRef: string;
  status: BookingImportRowStatus;
  bookingId: string;
  amountCents: number;
};

async function reverseOneRow(
  input: Parameters<typeof reverseBookingImport>[0],
  lodgeId: string,
  row: ReversalRow,
): Promise<BookingImportReversalRowResult> {
  const { bookingRef, bookingId } = row;
  if (row.status === BookingImportRowStatus.IMPORTED) {
    const touch = { bookingId, importedAmountCents: row.amountCents, today: input.today };
    // A cheap read first, so an obviously touched booking never waits for lock(1).
    const touched = await importedBookingTouches(prisma, touch);
    if (touched.length > 0) return { bookingRef, outcome: "KEPT", bookingId, reasons: touched };

    // Under the locks: re-check, then claim the row in the same transaction.
    const claimRow = async (tx: Prisma.TransactionClient) => {
      const reasons = await importedBookingTouches(tx, touch);
      if (reasons.length > 0) throw new ImportReversalKept(reasons);
      const claimed = await tx.bookingImportRow.updateMany({
        where: { id: row.id, status: BookingImportRowStatus.IMPORTED },
        data: { status: BookingImportRowStatus.REVERSED },
      });
      if (claimed.count !== 1) throw new ImportReversalKept(["Another reversal has already taken this booking"]);
    };
    try {
      if (row.amountCents > 0) {
        await reverseManualBookingPayment({
          bookingId,
          actingAdminMemberId: input.officerMemberId,
          note: `Import batch ${input.batchId} reversed (Booking Ref ${bookingRef})`,
          beforeReverse: (tx) => claimRow(tx),
        });
      } else {
        // A free stay has no manual payment to take back. The same keys the
        // reversal takes (`INV-LOCK-002`) exclude a concurrent edit or cancel.
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
          await acquireLodgeCapacityLock(tx, lodgeId);
          await claimRow(tx);
        }, LOCK1_HOLDER_TRANSACTION_BUDGET);
      }
    } catch (err) {
      const reasons =
        err instanceof ImportReversalKept ? err.reasons : err instanceof ManualBookingPaymentError ? [err.message] : null;
      if (!reasons) throw err;
      // A concurrent reversal may have claimed the row first. Finishing its
      // cancel is then safe: the cancel's own claim lets only one through.
      const now = await prisma.bookingImportRow.findUnique({ where: { id: row.id }, select: { status: true } });
      if (now?.status !== BookingImportRowStatus.REVERSED) return { bookingRef, outcome: "KEPT", bookingId, reasons };
    }
  }
  return cancelReversedBooking(input, row);
}

/**
 * Step 2: cancel the reversed booking with no email; nothing is left to
 * refund. Only the shape step 1 leaves is cancelled: an unpaid booking whose
 * manual payment was taken back, or a free stay still on its $0 payment. If a
 * card payment landed in between, the booking is left for an officer, never
 * cancelled into a refund here.
 */
async function cancelReversedBooking(
  input: Parameters<typeof reverseBookingImport>[0],
  row: ReversalRow,
): Promise<BookingImportReversalRowResult> {
  const { bookingRef, bookingId } = row;
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { status: true, payment: { select: { amountCents: true, refundedAmountCents: true, manuallyMarkedPaidAt: true } } },
  });
  if (booking?.status === BookingStatus.CANCELLED) return { bookingRef, outcome: "REVERSED", bookingId };
  const payment = booking?.payment;
  const asStepOneLeftIt =
    row.amountCents > 0
      ? booking?.status === BookingStatus.PAYMENT_PENDING && payment?.manuallyMarkedPaidAt === null
      : booking?.status === BookingStatus.PAID && payment?.amountCents === 0 && payment.refundedAmountCents === 0;
  if (!asStepOneLeftIt) {
    return { bookingRef, outcome: "CANCEL_PENDING", bookingId, reason: CHANGED_AFTER_REVERSAL };
  }
  const result = await cancelBooking(bookingId, input.officerMemberId, "ADMIN", input.ipAddress, input.format, "card", {
    hasBookingsEditAccess: true,
    notifyMember: false,
  });
  if (result.status === 200) return { bookingRef, outcome: "REVERSED", bookingId };
  // A member or officer may have cancelled it in between: the end is the same.
  const after = await prisma.booking.findUnique({ where: { id: bookingId }, select: { status: true } });
  if (after?.status === BookingStatus.CANCELLED) return { bookingRef, outcome: "REVERSED", bookingId };
  return { bookingRef, outcome: "CANCEL_PENDING", bookingId, reason: result.error };
}
