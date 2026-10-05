import type { BookingStatus } from "@prisma/client";
import { isBookingShownIn } from "@/lib/booking-delete-visibility";
import {
  formatPaidRefundedBreakdown,
  getRemainingRefundableCents,
  isCapturedPaymentStatus,
  paymentShowsCaptureEvidence,
} from "@/lib/booking-payment-state";
import {
  openCancellationHandBackOwedCents,
  type CancellationHandBackTaskRow,
} from "@/lib/manual-refund-task-settlement-rules";
import {
  cancelledBookingKeptCreditCents,
  type BookingCreditAmountRow,
  type CreditRestoreEvidence,
} from "@/lib/member-credit-booking-rows";

/**
 * The line beneath a Net Collected headline that sums a set of payments (the
 * dashboard card): "{paid} paid", then whichever of refunded or credited, owed
 * back on a cancellation, and account credit a cancellation kept (owner
 * decision on #3372, 3 Oct 2026) is non-zero, so the headline's arithmetic is
 * on screen. `null` when there is nothing but the paid figure; the wording of
 * the first two parts is `formatPaidRefundedBreakdown`'s.
 */
export function formatNetCollectedBreakdown(
  summary: Pick<
    CollectedCashSummary,
    "capturedGrossCents" | "refundedCents" | "handBackOwedCents" | "keptCreditCents"
  >,
  formatCents: (cents: number) => string,
): string | null {
  const extras = [
    summary.handBackOwedCents > 0
      ? `${formatCents(summary.handBackOwedCents)} owed back on cancellation`
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
   * On CANCELLED bookings, refunds the club still owes by hand on an open
   * hand-back task, taken off straight away (owner decision on #3372, 3 Oct
   * 2026; `openCancellationHandBackOwedCents`), capped at what is left of the
   * payment after `refundedCents`.
   */
  handBackOwedCents: number;
  /**
   * Account credit applied to CANCELLED bookings that the cancellation kept
   * (owner decision on #3372, 3 Oct 2026; `cancelledBookingKeptCreditCents`).
   * Zero for a live booking: credit it spent is not money kept.
   */
  keptCreditCents: number;
  /**
   * `capturedGrossCents - refundedCents - handBackOwedCents +
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
 * the scope's `deletedAt`, and for a CANCELLED booking the two facts the owner's
 * 3 Oct 2026 decision reads. The relation names are Prisma's, so a select hands
 * them in as loaded (`netCollectedBookingSelect` in `additional-ledger-gap.ts`);
 * each is required, so a surface cannot leave one out and read a smaller figure.
 */
export interface NetCollectedBookingFields extends NetCollectedBookingScopeFields {
  status: string;
  creditsApplied: ReadonlyArray<BookingCreditAmountRow>;
  creditsFromCancellation: ReadonlyArray<BookingCreditAmountRow & CreditRestoreEvidence>;
  manualRefundTasks: ReadonlyArray<CancellationHandBackTaskRow>;
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
  booking: NetCollectedBookingFields;
}

/** One payment's part of a Net Collected figure, in its four pieces. */
export interface NetCollectedPaymentParts {
  /** `amountCents` if the payment took money, else 0. */
  capturedGrossCents: number;
  /** Money it took and still holds: not refunded, credited or owed back. */
  heldCashCents: number;
  /** A cancelled booking's open hand-back, as far as the money it took covers. */
  handBackOwedCents: number;
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
 */
function netCollectedPaymentTookMoney(
  payment: NetCollectedPaymentRow & { status: string },
): boolean {
  if (!isCapturedPaymentStatus(payment.status)) return false;
  if (payment.status === "SUCCEEDED") return true;
  return paymentShowsCaptureEvidence(payment, payment._count.transactions > 0);
}

/**
 * THE one per-payment rule behind every "Net Collected" figure (owner review on
 * PR #3811 and the owner's decision on #3372, 3 Oct 2026). It does not apply the
 * booking scope; `summarizeCollectedCash` does, before calling it.
 *
 * - Cash: what the payment took and has not refunded or credited back
 *   (`getRemainingRefundableCents`): 0 if it never took money
 *   (`netCollectedPaymentTookMoney`), never below 0.
 * - On a CANCELLED booking, two more facts, each from its canonical reader:
 *   a hand-back refund still owed by hand is treated as gone straight away
 *   (`openCancellationHandBackOwedCents`), so only what the policy keeps
 *   counts; and applied account credit the cancellation kept counts
 *   (`cancelledBookingKeptCreditCents`). A live booking reads neither: its
 *   credit is spent on a stay, not kept, and it owes no hand-back.
 */
export function getNetCollectedPaymentParts(
  payment: NetCollectedPaymentRow,
): NetCollectedPaymentParts {
  const { status, booking } = payment;
  const captured = status !== null && netCollectedPaymentTookMoney({ ...payment, status });
  const remainingCents = captured
    ? getRemainingRefundableCents({ ...payment, status })
    : 0;
  const capturedGrossCents = captured ? payment.amountCents : 0;
  if (booking.status !== CANCELLED_BOOKING_STATUS) {
    return {
      capturedGrossCents,
      heldCashCents: remainingCents,
      handBackOwedCents: 0,
      keptCreditCents: 0,
    };
  }
  const handBackOwedCents = Math.min(
    openCancellationHandBackOwedCents(booking.manualRefundTasks),
    remainingCents,
  );
  return {
    capturedGrossCents,
    heldCashCents: remainingCents - handBackOwedCents,
    handBackOwedCents,
    keptCreditCents: cancelledBookingKeptCreditCents(booking),
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
 * A CANCELLED booking adds two more facts (owner decision on #3372, 3 Oct
 * 2026), both inside `getNetCollectedPaymentParts`: applied account credit the
 * cancellation KEPT counts (credit restored to the member does not), and a
 * hand-back refund still owed by hand counts as gone before its task is
 * completed. A live booking's applied credit is not in `amountCents`
 * (`INV-PAY-047`) and does not count.
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
  let capturedGrossCents = 0;
  let heldCashCents = 0;
  let handBackOwedCents = 0;
  let keptCreditCents = 0;
  for (const payment of netCollectedScopedPayments(payments)) {
    const parts = getNetCollectedPaymentParts(payment);
    capturedGrossCents += parts.capturedGrossCents;
    heldCashCents += parts.heldCashCents;
    handBackOwedCents += parts.handBackOwedCents;
    keptCreditCents += parts.keptCreditCents;
  }
  return {
    capturedGrossCents,
    refundedCents: capturedGrossCents - heldCashCents - handBackOwedCents,
    handBackOwedCents,
    keptCreditCents,
    netCollectedCents: heldCashCents + keptCreditCents,
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
