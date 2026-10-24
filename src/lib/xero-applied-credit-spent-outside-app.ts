/**
 * #4219 — bring the credit ledger into line with Xero when a credit note was
 * spent there by something the app did not do (an offset, a payment made against
 * the note, a manual allocation).
 *
 * The treasurer's entry in Xero is the decision, so the app mirrors it with no
 * officer step (owner decision, 17 Oct 2026): the lot the note funded is written
 * down, the booking's applied credit is released, and the failed allocation is
 * closed. No money moves: the member's credit balance is the same before and
 * after, the member owes the released amount on the booking's invoice, and Xero's
 * receivable already shows it. Nothing is written to Xero.
 *
 * THE SIGNAL is #4218's named failure: Xero refused the allocation and a read of
 * the note confirmed it (owner decision, 19 Oct 2026). That read also brings the
 * evidence this routine counts, Xero's own list of what was done to the note.
 *
 * WHAT COUNTS AS "SPENT OUTSIDE THE APP" is decided from that list, never from
 * the app's ledger. An allocation to an invoice the app has a record of, or a
 * payment the app made, is the app's own and is mirrored by the inbound sync. Only
 * an allocation to an invoice, and a payment, that the app has no record of is an
 * outside spend. Inferring it as "what the ledger thinks is free, less what Xero
 * says remains" was rejected in review: it reads another booking's allocation, or
 * an older allocation that predates the slice ledger, as an outside spend and
 * writes the member's credit down twice.
 *
 * ONE TRANSACTION, global lock then the member's credit-ledger lock
 * (`INV-LOCK-002`): releasing applied credit changes what the booking owes, so it
 * excludes the cancel, capture and refund writers that take the global key as well
 * as the credit writers that take the member's. Everything is re-read under the
 * locks. The routine is idempotent without a separate flag: the write-down counts
 * in the next calculation of what has been written down, so a second call finds
 * nothing missing and writes nothing.
 *
 * It FAILS CLOSED. Anything it cannot account for (no single slice for the note,
 * a slice Xero already holds, a note shared by several lots, a cancelled booking,
 * an owner who changed) writes nothing and says why; the caller keeps the
 * original failure.
 */
import { BookingStatus, CreditType, type Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import logger from "@/lib/logger";
import { createAuditLog } from "./audit";
import { bookingOwner } from "@/lib/booking-owner";
import { syncBookingLedgerCredits } from "@/lib/booking-ledger-credit-sync";
import { deriveBookingAppliedCreditCents, lockMemberCreditLedger } from "./member-credit";
import { unallocatedAppliedCents } from "./xero-applied-credit-ledger-state";
import { assertNoAppliedCreditDeallocationFence } from "./xero-applied-credit-operation-serialization";
import { findFundingLotsForNote, sliceHeldInXero } from "./xero-applied-credit-slice-lookup";
import { CREDIT_SPENT_OUTSIDE_APP_REASON_PREFIX } from "./xero-operation-resolution";
import {
  isCreditNoteSpentOutsideAppError,
  type XeroNoteAllocation,
  type XeroNotePayment,
} from "./xero-credit-note-spent-outside-app";
import { outsideSpendCents, spendIsExplained } from "./xero-credit-note-outside-spend";
import {
  creditNoteReleaseDescription,
  creditNoteWriteDownDescription,
  creditNoteWriteDownWhere,
  writtenDownCentsByCreditNote,
} from "./xero-credit-note-write-down";

/** `XeroSyncOperation.manuallyResolvedReason` for a failure this routine closed. */
export const CREDIT_SPENT_OUTSIDE_APP_RESOLUTION_REASON =
  `${CREDIT_SPENT_OUTSIDE_APP_REASON_PREFIX}: the credit note was used in Xero outside the app; the credit ledger was brought into line with Xero (#4219).`;

export type ConvergeRefusal =
  | "no-payment-or-owner"
  | "owner-changed"
  | "cancelled"
  | "no-single-slice"
  | "already-converged"
  | "slice-already-in-xero"
  | "shared-credit-note"
  | "unexplained-spend"
  | "nothing-missing";

export type ConvergeResult =
  | { converged: true; writtenDownCents: number; closedOperations: number }
  | { converged: false; reason: ConvergeRefusal };

export interface ConvergeInput {
  bookingId: string;
  creditNoteId: string;
  /** The slice the refused allocation tried to send, in cents. */
  requestedCents: number;
  /** The note's allocations and payments in Xero, from #4218's confirming read. */
  xeroAllocations: readonly XeroNoteAllocation[];
  xeroPayments: readonly XeroNotePayment[];
  /** The note's total and remaining credit in Xero, from the same read. */
  noteTotalCents: number | null;
  remainingCents: number;
  /**
   * The caller's own allocation operation that failed (#4338). When a concurrent
   * run already converged the booking, its close ran before this row failed, so
   * this run closes it.
   */
  failedOperationId?: string | null;
}

/**
 * Close failed allocation attempts through the resolution fields an officer's
 * mark uses (`INV-INT-025`): done, never re-run, off the Active list.
 * Status-guarded, so a retry's claim and this close cannot both win.
 */
function closeFailedAllocations(tx: Prisma.TransactionClient, match: Prisma.XeroSyncOperationWhereInput, at: Date) {
  return tx.xeroSyncOperation.updateMany({
    where: {
      ...match,
      entityType: "ALLOCATION",
      localModel: "MemberCreditNoteAllocation",
      status: { in: ["FAILED", "PARTIAL"] },
      manuallyResolvedAt: null,
    },
    data: {
      manuallyResolvedAt: at,
      manuallyResolvedReason: CREDIT_SPENT_OUTSIDE_APP_RESOLUTION_REASON,
      // Done: nothing is left to retry, so no Retry is offered.
      replayable: false,
    },
  });
}

/**
 * Did a converge run for this booking and note (#4338)? Its release (a marked
 * positive application to the booking) and its write-down (a marked negative row
 * stamped with the note) carry the same `outsideSpendConvergedAt`.
 */
async function convergeEvidenceExists(
  tx: Prisma.TransactionClient,
  memberId: string,
  bookingId: string,
  creditNoteId: string,
): Promise<boolean> {
  const releases = await tx.memberCredit.findMany({
    where: {
      memberId,
      appliedToBookingId: bookingId,
      type: CreditType.BOOKING_APPLIED,
      amountCents: { gt: 0 },
      outsideSpendConvergedAt: { not: null },
    },
    select: { outsideSpendConvergedAt: true },
  });
  const releasedAt = releases.flatMap((r) => (r.outsideSpendConvergedAt ? [r.outsideSpendConvergedAt] : []));
  if (releasedAt.length === 0) return false;
  const writeDown = await tx.memberCredit.findFirst({
    where: { ...creditNoteWriteDownWhere(memberId, [creditNoteId]), outsideSpendConvergedAt: { in: releasedAt } },
    select: { id: true },
  });
  return writeDown !== null;
}

export async function convergeCreditNoteSpentOutsideApp(input: ConvergeInput): Promise<ConvergeResult> {
  const { bookingId, creditNoteId, requestedCents } = input;
  if (!Number.isInteger(requestedCents) || requestedCents <= 0) {
    throw new Error(`The refused slice must be positive integer cents, got ${requestedCents}.`);
  }

  // The key to lock is read first; everything it protects is re-read under it.
  const booking = await prisma.booking.findUnique({ where: { id: bookingId }, include: { payment: true } });
  const lockedOwnerId = booking ? bookingOwner(booking).memberId : null;
  if (!booking?.payment || !lockedOwnerId) return { converged: false, reason: "no-payment-or-owner" };
  const paymentId = booking.payment.id;

  const result = await prisma.$transaction(async (tx): Promise<ConvergeResult> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    await lockMemberCreditLedger(lockedOwnerId, tx);

    const current = await tx.booking.findUnique({
      where: { id: bookingId },
      include: { payment: { select: { id: true } } },
    });
    if (!current?.payment || current.payment.id !== paymentId || bookingOwner(current).memberId !== lockedOwnerId) {
      return { converged: false, reason: "owner-changed" };
    }
    // A cancelled booking's credit is the cancel's to settle (restore or clearing note),
    // whether or not money was captured: a release here would lower what it restored.
    const restore = await tx.memberCredit.findUnique({ where: { restoredFromBookingId: bookingId }, select: { id: true } });
    if (current.status === BookingStatus.CANCELLED || restore !== null) {
      return { converged: false, reason: "cancelled" };
    }
    await assertNoAppliedCreditDeallocationFence(paymentId, tx);

    // A concurrent run converged first. Its close ran before this caller's own
    // attempt failed, so that row is closed here or it stays on the Active list.
    // Only on that run's evidence: its release for this booking and its write-down
    // for this note, minted together. Without it the row stays FAILED.
    const alreadyConverged = async (): Promise<ConvergeResult> => {
      if (input.failedOperationId && (await convergeEvidenceExists(tx, lockedOwnerId, bookingId, creditNoteId))) {
        const closedAt = new Date();
        const closed = await closeFailedAllocations(tx, { id: input.failedOperationId }, closedAt);
        if (closed.count > 0) {
          await createAuditLog(
            {
              action: "xero.credit_note.spent_outside_app_attempt_closed",
              subjectMemberId: lockedOwnerId,
              targetId: bookingId,
              entityType: "Booking",
              entityId: bookingId,
              category: "xero",
              severity: "info",
              outcome: "success",
              summary: "Credit note used outside the app: a concurrent attempt's failed allocation closed",
              details: CREDIT_SPENT_OUTSIDE_APP_RESOLUTION_REASON,
              metadata: { creditNoteId, operationId: input.failedOperationId },
            },
            tx,
          );
        }
      }
      return { converged: false, reason: "already-converged" };
    };
    const slices = await tx.memberCreditNoteAllocation.findMany({
      where: { appliedToBookingId: bookingId, xeroCreditNoteId: creditNoteId },
    });
    const [slice, ...otherSlices] = slices;
    if (!slice && (await unallocatedAppliedCents(bookingId, tx)) === 0) {
      // Nothing is left to allocate.
      return alreadyConverged();
    }
    if (!slice || otherSlices.length > 0) return { converged: false, reason: "no-single-slice" };
    if (slice.amountCents < requestedCents) {
      // A concurrent partial converge already shrank this slice below what was refused.
      return alreadyConverged();
    }
    const heldInXero = await sliceHeldInXero(tx, slice.id);
    if (heldInXero) return { converged: false, reason: "slice-already-in-xero" };

    const lots = await findFundingLotsForNote(tx, lockedOwnerId, creditNoteId);
    const [lot, ...otherLots] = lots;
    if (!lot || otherLots.length > 0 || lot.id !== slice.memberCreditId) {
      return { converged: false, reason: "shared-credit-note" };
    }

    // What Xero shows spent on things the app has no record of, less what this
    // routine has already written down for the note. The slice bounds the rest.
    if (
      !spendIsExplained({
        allocations: input.xeroAllocations,
        payments: input.xeroPayments,
        totalCents: input.noteTotalCents,
        remainingCents: input.remainingCents,
      })
    ) {
      return { converged: false, reason: "unexplained-spend" };
    }
    const spent = await outsideSpendCents(tx, input.xeroAllocations, input.xeroPayments);
    if (spent > lot.amountCents) return { converged: false, reason: "unexplained-spend" };
    const writtenDown = (await writtenDownCentsByCreditNote(tx, lockedOwnerId, [creditNoteId])).get(creditNoteId) ?? 0;
    const downCents = Math.min(slice.amountCents, spent - writtenDown);
    if (downCents <= 0) return { converged: false, reason: "nothing-missing" };

    // Additive rows, never edits. The write-down burns the lot; the release undoes
    // the application; together they leave the member's balance where it was.
    const convergedAt = new Date();
    await tx.memberCredit.create({
      data: {
        memberId: lockedOwnerId,
        amountCents: -downCents,
        type: CreditType.ADMIN_ADJUSTMENT,
        description: creditNoteWriteDownDescription(bookingId),
        xeroCreditNoteId: creditNoteId,
        outsideSpendConvergedAt: convergedAt,
      },
    });
    await tx.memberCredit.create({
      data: {
        memberId: lockedOwnerId,
        amountCents: downCents,
        type: CreditType.BOOKING_APPLIED,
        description: creditNoteReleaseDescription(bookingId),
        appliedToBookingId: bookingId,
        outsideSpendConvergedAt: convergedAt,
      },
    });
    await syncBookingLedgerCredits({ bookingId, store: tx });
    // The slice Xero never received shrinks (or goes), so every reader that totals a
    // booking's allocations sees only what Xero holds.
    if (downCents >= slice.amountCents) {
      await tx.memberCreditNoteAllocation.delete({ where: { id: slice.id } });
    } else {
      await tx.memberCreditNoteAllocation.update({
        where: { id: slice.id },
        data: { amountCents: slice.amountCents - downCents },
      });
    }
    // With nothing left to allocate the booking's rows are settled, as the engine
    // settles them once it has allocated: stamp the unstamped ones (the application
    // and the release) so a later application to the booking is not netted by the
    // release.
    if ((await unallocatedAppliedCents(bookingId, tx)) === 0) {
      await tx.memberCredit.updateMany({
        where: { appliedToBookingId: bookingId, type: CreditType.BOOKING_APPLIED, xeroCreditNoteId: null },
        data: { xeroCreditNoteId: creditNoteId },
      });
    }
    await tx.payment.update({
      where: { id: paymentId },
      data: { creditAppliedCents: await deriveBookingAppliedCreditCents(bookingId, tx) },
    });

    // Close this slice's failed allocation attempts.
    const closed = await closeFailedAllocations(tx, { localId: slice.id }, convergedAt);

    await createAuditLog(
      {
        action: "xero.credit_note.spent_outside_app_converged",
        // The system did this, not the member: the member is the subject.
        subjectMemberId: lockedOwnerId,
        targetId: bookingId,
        entityType: "Booking",
        entityId: bookingId,
        category: "xero",
        severity: "important",
        outcome: "success",
        summary: "Credit note used outside the app: credit ledger brought into line with Xero",
        details: CREDIT_SPENT_OUTSIDE_APP_RESOLUTION_REASON,
        metadata: {
          creditNoteId,
          writtenDownCents: downCents,
          sliceCentsBefore: slice.amountCents,
          outsideSpendCents: spent,
          closedOperations: closed.count,
        },
      },
      tx,
    );
    return { converged: true, writtenDownCents: downCents, closedOperations: closed.count };
  });

  if (result.converged) {
    logger.info(
      { bookingId, creditNoteId, writtenDownCents: result.writtenDownCents },
      "Converged the credit ledger with a credit note used outside the app",
    );
  } else if (result.reason === "already-converged") {
    logger.info({ bookingId, creditNoteId }, "A concurrent run already converged this credit note; planning again");
  } else {
    logger.warn(
      { bookingId, creditNoteId, reason: result.reason },
      "Credit note used outside the app was not converged; the original failure stands",
    );
  }
  return result;
}

/** Re-plans after a converge are bounded: each one removes a slice or fails closed. */
const MAX_CONVERGE_ATTEMPTS = 3;

/**
 * The worker's entry: did this failure get converged, so the allocation should be
 * planned again? True only for #4218's confirmed named failure, with attempts
 * left, when the routine converged or found a concurrent run already had.
 * Anything else leaves the failure standing.
 */
export async function convergedForNamedFailure(
  error: unknown,
  bookingId: string,
  attemptsSoFar = 0,
): Promise<boolean> {
  if (!isCreditNoteSpentOutsideAppError(error) || attemptsSoFar >= MAX_CONVERGE_ATTEMPTS) {
    return false;
  }
  const result = await convergeCreditNoteSpentOutsideApp({
    bookingId,
    creditNoteId: error.creditNoteId,
    requestedCents: error.requestedCents,
    xeroAllocations: error.xeroAllocations,
    xeroPayments: error.xeroPayments,
    noteTotalCents: error.totalCents,
    remainingCents: error.remainingCents,
    failedOperationId: error.operationId,
  });
  return result.converged || result.reason === "already-converged";
}
