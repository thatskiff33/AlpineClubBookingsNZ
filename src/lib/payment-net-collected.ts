import type { BookingStatus } from "@prisma/client";
import { isBookingShownIn } from "@/lib/booking-delete-visibility";
import {
  formatPaidRefundedBreakdown,
  getRemainingRefundableCents,
  isCapturedPaymentStatus,
  paymentShowsCaptureEvidence,
} from "@/lib/booking-payment-state";
import { sumInternetBankingLateCashCreditCents } from "@/lib/internet-banking-late-cash-credit";
import {
  openTaskOwedCents,
  type HandBackTaskRow,
} from "@/lib/manual-refund-task-settlement-rules";
import {
  openCardRefundOwedCents,
  type CardRefundOperationRow,
  type RecordedCardRefundRow,
} from "@/lib/open-card-refund-owed";
import {
  cancelledBookingKeptCreditCents,
  type BookingCreditAmountRow,
  type CreditRestoreEvidence,
} from "@/lib/member-credit-booking-rows";

/**
 * The line beneath a Net Collected headline that sums a set of payments (the
 * dashboard card): "{paid} paid", then whichever of refunded or credited, owed
 * back by hand, card refunds not yet paid, late card charges awaiting the
 * treasurer, late bank payments credited back, and account credit a
 * cancellation kept (owner decisions on #3372, 3 and 7 Oct 2026) is non-zero,
 * so the headline's arithmetic is on screen. `null` when there is nothing but
 * the paid figure; the wording of the first two parts is
 * `formatPaidRefundedBreakdown`'s.
 */
export function formatNetCollectedBreakdown(
  summary: Pick<
    CollectedCashSummary,
    | "capturedGrossCents"
    | "refundedCents"
    | "handBackOwedCents"
    | "cardRefundOwedCents"
    | "lateCaptureOwedCents"
    | "lateCashCreditedCents"
    | "keptCreditCents"
  >,
  formatCents: (cents: number) => string,
): string | null {
  const extras = [
    summary.handBackOwedCents > 0
      ? `${formatCents(summary.handBackOwedCents)} owed back by hand`
      : null,
    summary.cardRefundOwedCents > 0
      ? `${formatCents(summary.cardRefundOwedCents)} card refunds not yet paid`
      : null,
    summary.lateCaptureOwedCents > 0
      ? `${formatCents(summary.lateCaptureOwedCents)} late card charges awaiting the treasurer`
      : null,
    summary.lateCashCreditedCents > 0
      ? `${formatCents(summary.lateCashCreditedCents)} late bank payments credited back`
      : null,
    summary.keptCreditCents > 0
      ? `plus ${formatCents(summary.keptCreditCents)} account credit kept on cancellation`
      : null,
  ].filter((part): part is string => part !== null);
  const paidRefunded = formatPaidRefundedBreakdown(
    summary.capturedGrossCents,
    summary.refundedCents,
    formatCents,
  );
  if (extras.length === 0) return paidRefunded;
  return [paidRefunded ?? `${formatCents(summary.capturedGrossCents)} paid`, ...extras].join(", ");
}

/**
 * Money collected on a set of payments: what was captured, what has gone back
 * out as a refund or an account credit, and the difference.
 */
export interface CollectedCashSummary {
  /** `Payment.amountCents` summed over captured payments only — before refunds. */
  capturedGrossCents: number;
  /**
   * How much of `capturedGrossCents` has gone back out: each captured
   * payment's `refundedAmountCents` — card refunds and cancellation credit to
   * the member's account alike (`INV-PAY-050`) — capped at what that payment
   * took. A refund recorded on a payment that never took money is not here:
   * nothing came in for it to reverse.
   */
  refundedCents: number;
  /**
   * Refunds the club still owes by hand on an open hand-back task, taken off
   * straight away (owner decisions on #3372: 3 Oct 2026 for a cancelled
   * booking, 7 Oct 2026 for a live one; `openHandBackOwedCents`), capped at
   * what is left of the
   * payment after `refundedCents`.
   */
  handBackOwedCents: number;
  /**
   * Card refunds started and not yet paid by Stripe, taken off straight away
   * (owner, #3372, 7 Oct 2026: "count in both"; `openCardRefundOwedCents`),
   * capped at what is left after the hand-back.
   */
  cardRefundOwedCents: number;
  /**
   * Late card charges on a cancelled booking awaiting the treasurer's
   * refund-or-keep decision (owner, #3372, 7 Oct 2026: "count as owed";
   * `isLateCaptureAwaitingDecisionTask`), capped at what is left. Once kept,
   * they count as collected.
   */
  lateCaptureOwedCents: number;
  /**
   * On a CANCELLED booking, bank-transfer cash that arrived after the cancel
   * and was credited to the member's account
   * (`sumInternetBankingLateCashCreditCents`): it never moves
   * `refundedAmountCents`, and it is in "Credits owed", so it is not kept.
   * Capped at what is left.
   */
  lateCashCreditedCents: number;
  /**
   * Account credit applied to CANCELLED bookings that the cancellation kept
   * (owner decision on #3372, 3 Oct 2026; `cancelledBookingKeptCreditCents`).
   * Zero for a live booking: credit it spent is not money kept.
   */
  keptCreditCents: number;
  /**
   * `capturedGrossCents - refundedCents - handBackOwedCents -
   * cardRefundOwedCents - lateCaptureOwedCents - lateCashCreditedCents +
   * keptCreditCents`, exactly: per payment, the parts
   * `getNetCollectedPaymentParts` returns. No payment adds less than nothing
   * and one that never took money adds nothing (beyond credit a cancellation
   * kept). Not "cash the club holds" — a credit is still owed to the member as
   * a future booking, and it is subtracted here all the same.
   */
  netCollectedCents: number;
}

/**
 * The booking a payment belongs to, as far as the Net Collected scope needs it.
 */
export interface NetCollectedBookingScopeFields {
  deletedAt: Date | null;
}

/**
 * The booking a payment belongs to, as far as a Net Collected figure needs it:
 * the scope's `deletedAt`, its open tasks (hand-backs and late captures; owner
 * decisions on #3372, 3 and 7 Oct 2026), and for a CANCELLED booking the credit
 * rows the 3 Oct decision reads and the late bank-payment credit (F2). The relation names are Prisma's, so a select hands
 * them in as loaded (`netCollectedBookingSelect` in `additional-ledger-gap.ts`);
 * each is required, so a surface cannot leave one out and read a smaller figure.
 */
export interface NetCollectedBookingFields extends NetCollectedBookingScopeFields {
  status: string;
  creditsApplied: ReadonlyArray<BookingCreditAmountRow>;
  creditsFromCancellation: ReadonlyArray<BookingCreditAmountRow & CreditRestoreEvidence>;
  manualRefundTasks: ReadonlyArray<HandBackTaskRow>;
}

const CANCELLED_BOOKING_STATUS = "CANCELLED" satisfies BookingStatus;

/**
 * #3372, owner decision A (29 Sep 2026): THE booking scope of every "Net
 * Collected" figure - the dashboard card, the payments board tile, Reports'
 * Net Collected and the finance dashboard's Net Collected (#3637). A
 * payment counts when its booking has not been
 * soft-deleted, whatever the booking's status.
 *
 * What a CANCELLED booking adds (owner review on PR #3811, 2 Oct 2026, and the
 * owner's decision on #3372, 3 Oct 2026) is only what the cancellation KEPT of
 * what was actually paid: cash not refunded, credited or owed back by hand, and
 * applied account credit not restored. A booking cancelled before anything was
 * paid adds nil, whatever fee its policy would have charged: the figure is
 * never built from a price or a policy, only from what was paid
 * (`getNetCollectedPaymentParts`).
 *
 * Before the decision each screen chose its own set: Reports a fixed status
 * list, the payments tile everything but cancelled (#773, which kept a refunded
 * booking's GROSS out of "Total Revenue" - a job the netting now does), the
 * dashboard everything. The same month's figure differed by every kept fee.
 *
 * It is not a caller's choice. `summarizeCollectedCash` applies it to every row
 * itself, and its row type requires the booking's `deletedAt`, so a surface
 * cannot hand in rows without the fact the rule reads. A surface's OWN filters
 * (a date range, a lodge, the payments board's filter bar) still narrow which
 * payments it hands in; the Reports "deleted" view does not widen this scope.
 */
export function isInNetCollectedBookingScope(
  booking: NetCollectedBookingScopeFields,
): boolean {
  // #3745: "not deleted" is Reports' hide view, defined once beside the query
  // filter the Finance booking reads ask.
  return isBookingShownIn("hide", booking);
}

/** A payment as `summarizeCollectedCash` reads it. */
export interface NetCollectedPaymentRow {
  status: string | null;
  amountCents: number;
  refundedAmountCents: number;
  /** Capture evidence (`netCollectedCaptureEvidenceSelect`): `_count` counts CAPTURED ledger rows only. */
  source: string;
  _count: { transactions: number };
  /** Card refunds not yet paid, and the refunds to net them against (`netCollectedCardRefundSelect`). */
  recoveryOperations: ReadonlyArray<CardRefundOperationRow>;
  refunds: ReadonlyArray<RecordedCardRefundRow>;
  booking: NetCollectedBookingFields;
}

/** One payment's part of a Net Collected figure, in its pieces. */
export interface NetCollectedPaymentParts {
  /** `amountCents` if the payment took money, else 0. */
  capturedGrossCents: number;
  /** Money it took and still holds: not refunded, credited or owed back. */
  heldCashCents: number;
  /** The booking's open hand-back, as far as the money it took covers. */
  handBackOwedCents: number;
  /** Its card refunds not yet paid, as far as what is left covers. */
  cardRefundOwedCents: number;
  /** Late card charges awaiting the treasurer, as far as what is left covers. */
  lateCaptureOwedCents: number;
  /** On a cancelled booking, late bank-transfer cash credited back. */
  lateCashCreditedCents: number;
  /** Applied credit a cancellation kept; 0 unless the booking is cancelled. */
  keptCreditCents: number;
}

/**
 * #3372 (owner, PR #3811: only money actually received counts). `SUCCEEDED` is
 * taken at its word; a refunded status counts only with the cancel path's
 * capture evidence (`paymentShowsCaptureEvidence`). The Xero inbound reconcile
 * folds a modification credit note into a never-paid Internet Banking payment
 * (`amountCents` = its full price) and marks it PARTIALLY_REFUNDED: bookkeeping,
 * not cash. A paid one has a captured ledger row, so its remainder still counts.
 * The booking page's "Original payment" gate reads it too (#3924), so the page
 * never shows a payment as taken that its retained line counts as nothing.
 */
export function netCollectedPaymentTookMoney(
  payment: Omit<NetCollectedPaymentRow, "booking"> & { status: string },
): boolean {
  if (!isCapturedPaymentStatus(payment.status)) return false;
  if (payment.status === "SUCCEEDED") return true;
  return paymentShowsCaptureEvidence(payment, payment._count.transactions > 0);
}

/** A payment as the CASH half of the per-payment rule reads it: no applied-credit rows. */
export type NetCollectedCashRow = Omit<NetCollectedPaymentRow, "booking"> & {
  booking: Pick<
    NetCollectedBookingFields,
    "status" | "deletedAt" | "manualRefundTasks" | "creditsFromCancellation"
  >;
};

/**
 * THE CASH HALF of the one per-payment rule (`getNetCollectedPaymentParts`):
 * what the payment took, what of it the club still holds, and what is owed
 * back out of it, each taken off straight away and each capped at what the
 * ones before it left, so no cent comes off twice (owner decisions on #3372,
 * 3 and 7 Oct 2026):
 *
 * 1. an open hand-back refund owed by hand, on any booking
 *    (`openTaskOwedCents`);
 * 2. card refunds started and not yet paid by Stripe
 *    (`openCardRefundOwedCents`, net of slices already recorded);
 * 3. late card charges awaiting the treasurer's refund-or-keep decision
 *    (`isLateCaptureAwaitingDecisionTask`);
 * 4. on a CANCELLED booking, late bank-transfer cash credited to the member
 *    (`sumInternetBankingLateCashCreditCents`), which "Credits owed" counts.
 *
 * Exported for the booking detail's "Non-refundable amount retained" line,
 * which is this booking's cash part of Net Collected and so can never read
 * higher than what Net Collected counts for it.
 */
export function getNetCollectedCashParts(
  payment: NetCollectedCashRow,
): Omit<NetCollectedPaymentParts, "keptCreditCents"> {
  const { status, booking } = payment;
  const captured = status !== null && netCollectedPaymentTookMoney({ ...payment, status });
  let leftCents = captured
    ? getRemainingRefundableCents({ ...payment, status })
    : 0;
  const capturedGrossCents = captured ? payment.amountCents : 0;
  const takeOff = (owedCents: number): number => {
    const cents = Math.min(Math.max(0, owedCents), leftCents);
    leftCents -= cents;
    return cents;
  };
  const tasks = openTaskOwedCents(booking.manualRefundTasks, booking);
  const handBackOwedCents = takeOff(tasks.handBackCents);
  const cardRefundOwedCents = takeOff(
    captured ? openCardRefundOwedCents({ ...payment, status }) : 0,
  );
  const lateCaptureOwedCents = takeOff(tasks.lateCaptureCents);
  const lateCashCreditedCents = takeOff(
    booking.status === CANCELLED_BOOKING_STATUS
      ? sumInternetBankingLateCashCreditCents(
          booking.creditsFromCancellation.map((credit) => ({
            ...credit,
            description: credit.description ?? null,
          })),
        )
      : 0,
  );
  return {
    capturedGrossCents,
    heldCashCents: leftCents,
    handBackOwedCents,
    cardRefundOwedCents,
    lateCaptureOwedCents,
    lateCashCreditedCents,
  };
}

/**
 * THE one per-payment rule behind every "Net Collected" figure (owner review on
 * PR #3811 and the owner's decision on #3372, 3 Oct 2026). It does not apply the
 * booking scope; `summarizeCollectedCash` does, before calling it.
 *
 * - Cash (`getNetCollectedCashParts`): what the payment took and has not
 *   refunded or credited back (`getRemainingRefundableCents`): 0 if it never
 *   took money (`netCollectedPaymentTookMoney`), never below 0. Money owed
 *   back out of it is treated as gone straight away: a hand-back refund owed
 *   by hand, on a cancelled booking (3 Oct 2026, so only what the policy keeps
 *   counts) and on a live one (7 Oct 2026: an edit's refund (`INV-PAY-117`) or
 *   an approved refund request's (`INV-PAY-118`)); a card refund not yet paid,
 *   and a late card charge awaiting the treasurer (7 Oct 2026); and on a
 *   cancelled booking, late bank-transfer cash credited back.
 * - On a CANCELLED booking, applied account credit the cancellation kept
 *   counts too (`cancelledBookingKeptCreditCents`). A live booking's credit is
 *   spent on a stay, not kept, so it adds none.
 */
export function getNetCollectedPaymentParts(
  payment: NetCollectedPaymentRow,
): NetCollectedPaymentParts {
  const cash = getNetCollectedCashParts(payment);
  return {
    ...cash,
    keptCreditCents:
      payment.booking.status === CANCELLED_BOOKING_STATUS
        ? cancelledBookingKeptCreditCents(payment.booking)
        : 0,
  };
}

/**
 * The payments inside the Net Collected booking scope - for a check that must
 * run over exactly the payments the figure counts, such as the ledger-gap
 * warning beside it. The surfaces get both from one call,
 * `summarizeNetCollectedWithLedgerGap` in `additional-ledger-gap.ts` (#3637).
 */
export function netCollectedScopedPayments<T extends NetCollectedPaymentRow>(
  payments: ReadonlyArray<T>,
): T[] {
  return payments.filter((payment) =>
    isInNetCollectedBookingScope(payment.booking),
  );
}

/**
 * `Payment.refundedAmountCents` summed over the rows handed in, captured or not:
 * card refunds and account credits alike (`INV-PAY-050`). The payments board's
 * "Refunded / Credited" tile uses it over every payment its filters match. NOT
 * the net's refund: `summarizeCollectedCash` nets each payment on its own
 * (`getRemainingRefundableCents`), so a refund can never reach past the
 * payment it was made on.
 */
export function sumRefundedAndCreditedCents(
  payments: ReadonlyArray<{ refundedAmountCents: number }>,
): number {
  return payments.reduce(
    (sum, payment) => sum + payment.refundedAmountCents,
    0,
  );
}


/**
 * #3372: net collected cash over a set of payments, for the officer surfaces —
 * the Reports summary, the dashboard's "Net Collected This Month" card and the
 * payments board's "Net Collected" tile all read it (`INV-SSOT-001`), so
 * they cannot disagree about what "net of refunds and credits" means, nor about
 * which bookings count: the Net Collected booking scope
 * (`isInNetCollectedBookingScope`) is applied here, to every row, and a row
 * outside it contributes nothing. Each surface still decides WHICH payments it
 * hands in - a month's, a filter's, a report range's - and says so on screen.
 *
 * The finance dashboard's "Net Collected" (`finance-booking-metrics.ts`)
 * reads it too, over the bookings staying in its window (#3637).
 *
 * PER PAYMENT, never pooled (owner review on PR #3811): each in-scope payment
 * adds what it received and has not refunded or credited back -
 * `getRemainingRefundableCents`, the one "money taken and still held" reading,
 * which is 0 for a payment that never took money (`netCollectedPaymentTookMoney`)
 * and never below 0. So a cancelled booking that was never paid adds nil. The old
 * pooled sum (all captured gross less ALL refunds) let a refund recorded on a
 * never-captured payment - the inbound reconcile folds a modification credit
 * note into an unpaid Internet Banking payment's mirror, and the unpaid cancel
 * then marks it FAILED (`booking-cancel.ts`) - or a refund above its own
 * capture, subtract from OTHER bookings' money.
 *
 * More facts, all inside `getNetCollectedPaymentParts`: money owed back out of
 * a payment counts as gone straight away - a hand-back refund owed by hand on
 * any booking, a card refund Stripe has not yet paid, a late card charge
 * awaiting the treasurer, and on a cancelled booking late bank-transfer cash
 * credited back (owner decisions on #3372, 3 and 7 Oct 2026); and on a
 * CANCELLED booking applied account credit the cancellation KEPT counts
 * (credit restored to the member does not). A live booking's applied credit is not in
 * `amountCents` (`INV-PAY-047`) and does not count.
 *
 * Cash is payment-derived and deliberately NOT allocated over stay nights.
 * `Payment.amountCents` already contains captured additions (#2408); rebuilding
 * it from transaction rows would undercount legacy/group captures or double
 * count a later addition.
 *
 * `status` is `string | null`, not `PaymentStatus`: the payments service hands
 * in a plain string, and a `null` captures nothing.
 */
export function summarizeCollectedCash(
  payments: ReadonlyArray<NetCollectedPaymentRow>,
): CollectedCashSummary {
  const sums = {
    capturedGrossCents: 0,
    heldCashCents: 0,
    handBackOwedCents: 0,
    cardRefundOwedCents: 0,
    lateCaptureOwedCents: 0,
    lateCashCreditedCents: 0,
    keptCreditCents: 0,
  };
  for (const payment of netCollectedScopedPayments(payments)) {
    const parts = getNetCollectedPaymentParts(payment);
    for (const key of Object.keys(sums) as Array<keyof typeof sums>) {
      sums[key] += parts[key];
    }
  }
  const { heldCashCents, ...rest } = sums;
  return {
    ...rest,
    refundedCents:
      sums.capturedGrossCents -
      heldCashCents -
      sums.handBackOwedCents -
      sums.cardRefundOwedCents -
      sums.lateCaptureOwedCents -
      sums.lateCashCreditedCents,
    netCollectedCents: heldCashCents + sums.keptCreditCents,
  };
}

/**
 * #3372: the "may understate" warning that goes with a Net Collected figure
 * when `summarizeAdditionalLedgerGap` finds payments that record an additional
 * payment as collected with no captured ADDITIONAL ledger row behind it. One
 * sentence for every surface that runs the check - Reports, the payments board
 * and the finance dashboard (#3637) - so the warning cannot read differently on
 * each. `subject` names what the count counts on that surface; `formatCents`
 * and `formatCount` are the surface's money and number formatters in the
 * club's format (#3205), so the count groups like every other count on that
 * page. `null` when there is no gap.
 *
 * The admin dashboard card, the fourth Net Collected figure, does not carry it:
 * it reads only each payment's status and amounts for the month, with no
 * ledger rows, and loading every payment's ledger on the landing page is not
 * worth it for a check the other three surfaces already run.
 */
export function formatNetCollectedLedgerGapWarning(
  gap: { additionalLedgerGapCents: number; additionalLedgerGapBookings: number },
  subject: { one: string; many: string },
  formatCents: (cents: number) => string,
  formatCount: (count: number) => string,
): string | null {
  const count = gap.additionalLedgerGapBookings;
  if (count === 0) return null;
  const singular = count === 1;
  return `Net Collected may understate by ${formatCents(gap.additionalLedgerGapCents)}: ${formatCount(count)} ${singular ? subject.one : subject.many} record${singular ? "s" : ""} an additional payment as collected without a matching captured additional-payment record. Ask a developer to reconcile ${singular ? "that payment's ledger" : "those payments' ledgers"} before trusting this figure.`;
}
