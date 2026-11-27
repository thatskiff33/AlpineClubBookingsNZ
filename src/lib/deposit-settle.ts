/**
 * #5008 child A (`INV-ADDPAY-053`): the parts of settling a booking by a DEPOSIT that
 * are the deposit's own. The settle itself runs in the one settlement body in
 * `payment-reconciliation.ts` (`settleBookingByDeposit`), under its locks, through
 * the manual arm: the deposit is recorded as the officer's cash receipt that settles
 * the booking, and the rest of the amount owing is raised here, in the same
 * transaction, as one request with cause `balance` and a due date.
 *
 * The arithmetic is the manual settle's "the cash did not cover the extra" answer
 * (#2397): received + credit + still owed = the booking's worth (`INV-PAY-047`).
 * The request carries no money (R25): it is a PENDING row with no instrument, and
 * the member's card door and the officer's balance door are #5008 child B.
 *
 * Nothing calls the settle yet; #5005's import is its first caller.
 */
import { PaymentSource, PaymentStatus, PaymentTransactionKind, type Prisma } from "@prisma/client";

import { isAdditionalAmountUncollected } from "@/lib/additional-payment-chase";
import { createAuditLog } from "@/lib/audit";
import { calendarDateOfDateOnlyInstant, compareCalendarDates, dateOnlyInstantOf, type CalendarDate } from "@/lib/club-time";
import { DEPOSIT_BALANCE_ASK_REASON } from "@/lib/credit-release-ask-keys";
import { ManualBookingPaymentError } from "@/lib/manual-booking-payment-error";
import { manualSettleIntentHygieneAuditFields } from "@/lib/manual-settlement-intent-hygiene";
import { CAPTURED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import type { DepositSettlementSource } from "@/lib/payment-reconciliation-sources";

/** The `reason` on the PRIMARY cash row a deposit settle records. */
export const DEPOSIT_SETTLE_RECEIPT_REASON = "deposit_settle";

/**
 * The deposit's split of the amount owing, decided under the settlement body's locks
 * from its post-lock snapshot and BEFORE its first write. The figures and refusals
 * the manual arm's `prepareManualSettlement` shares (status, refund history, Xero
 * evidence, the amount owing) have already run; these are the deposit's own.
 */
export async function prepareDepositSplit(
  tx: Prisma.TransactionClient,
  booking: { checkIn: Date },
  settlement: DepositSettlementSource,
  owed: {
    payment: { id: string; additionalAmountCents: number; additionalPaymentStatus: string | null } | null;
    effectiveAmountCents: number;
    creditAppliedCents: number;
  },
) {
  const { payment, effectiveAmountCents, creditAppliedCents } = owed;
  // One request per booking: a balance is raised only on a booking with no request open, so it
  // never folds into, or is folded into, an extra by this door (an edit merges into it later).
  const openRows = payment === null ? 0 : await tx.paymentTransaction.count({
    where: {
      paymentId: payment.id,
      kind: PaymentTransactionKind.ADDITIONAL,
      withdrawnAt: null,
      status: { notIn: [...CAPTURED_TRANSACTION_STATUS_LIST] },
    },
  });
  if (openRows > 0 || isAdditionalAmountUncollected(payment)) {
    throw new ManualBookingPaymentError(
      "This booking already has a payment request open, so it cannot be settled by a deposit. Settle or withdraw that request first.",
      409,
    );
  }

  const { depositCents, balanceDueOn, today } = settlement;
  if (!Number.isSafeInteger(depositCents) || depositCents <= 0 || depositCents >= effectiveAmountCents) {
    throw new ManualBookingPaymentError(
      "A deposit must be more than nothing and less than the amount owing. Record the whole amount as a manual payment instead.",
      409,
    );
  }
  // `INV-DATE-010`/`-019`: club calendar dates compared as dates, the stay's from its `@db.Date`.
  if (compareCalendarDates(balanceDueOn, today) < 0) {
    throw new ManualBookingPaymentError("The balance's due date is in the past. Choose today or a later date.", 409);
  }
  if (compareCalendarDates(balanceDueOn, calendarDateOfDateOnlyInstant(booking.checkIn)) > 0) {
    throw new ManualBookingPaymentError("The balance's due date is after check-in. Choose a date on or before check-in.", 409);
  }

  // The manual settle's prepared shape, on its "not covered" answer: the balance is the uncollected term.
  return {
    amountOwingCents: effectiveAmountCents,
    settlementAmountCents: depositCents,
    creditAppliedCents,
    paymentId: payment?.id ?? null,
    outstandingAdditionalCents: 0,
    additionalSettlementCents: 0,
    uncollectedAdditionalCents: effectiveAmountCents - depositCents,
    previousAdditionalPaymentStatus: payment?.additionalPaymentStatus ?? null,
    additionalPaymentIntentId: null,
  };
}

/**
 * The balance request: one ADDITIONAL row with cause `balance`, its due date, and no
 * instrument. Written under the Payment row lock the settle holds, after the deposit's
 * cash row, so it is the payment's newest request and the summary columns the settle
 * writes beside it are the ones `reconcilePaymentAggregates` would derive.
 */
export async function raiseDepositBalanceRequest(
  tx: Prisma.TransactionClient,
  request: { paymentId: string; balanceCents: number; balanceDueOn: CalendarDate },
): Promise<string> {
  const row = await tx.paymentTransaction.create({
    data: {
      paymentId: request.paymentId,
      kind: PaymentTransactionKind.ADDITIONAL,
      // No card and no invoice: a request the member pays by card (a new Stripe row then
      // carries it) or an officer records. Never STRIPE, which readers take to mean a card.
      source: PaymentSource.INTERNET_BANKING,
      stripePaymentIntentId: null,
      amountCents: request.balanceCents,
      status: PaymentStatus.PENDING,
      reason: DEPOSIT_BALANCE_ASK_REASON,
      balanceDueOn: dateOnlyInstantOf(request.balanceDueOn),
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * The deposit settle's audit row, in the settle's transaction: what was received, the
 * credit applied, the balance owing and its due date, the card intents queued for
 * cancellation (the manual settle's hygiene) and any credit election it cleared.
 */
export async function recordDepositSettleAudit(
  tx: Prisma.TransactionClient,
  entry: {
    bookingId: string;
    /** The booking's owner (`bookingOwner`), or null for an organisation's booking. */
    subjectMemberId: string | null;
    previousStatus: string;
    paymentId: string;
    actingAdminMemberId: string;
    note: string | null;
    depositCents: number;
    creditAppliedCents: number;
    balanceCents: number;
    balanceDueOn: CalendarDate;
    cancelledIntentIds: string[];
    adoptedIntentIds: string[];
    clearedCreditElectionCents: number | null;
  },
): Promise<void> {
  await createAuditLog(
    {
      action: "booking-payment.deposit.settle",
      memberId: entry.actingAdminMemberId,
      actorMemberId: entry.actingAdminMemberId,
      subjectMemberId: entry.subjectMemberId,
      targetId: entry.bookingId,
      entityType: "Payment",
      entityId: entry.paymentId,
      category: "payment",
      severity: "important",
      outcome: "success",
      summary: "Booking settled by a deposit, with the balance owing by its due date",
      details: entry.note,
      metadata: {
        bookingId: entry.bookingId,
        paymentId: entry.paymentId,
        depositCents: entry.depositCents,
        creditAppliedCents: entry.creditAppliedCents,
        balanceCents: entry.balanceCents,
        balanceDueOn: entry.balanceDueOn,
        previousStatus: entry.previousStatus,
        ...manualSettleIntentHygieneAuditFields({ cancelledIntentIds: entry.cancelledIntentIds, adoptedIntentIds: entry.adoptedIntentIds }),
        clearedCreditElectionCents: entry.clearedCreditElectionCents,
      },
    },
    tx,
  );
}
