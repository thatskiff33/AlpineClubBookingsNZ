import type { BookingStatus } from "@prisma/client";
import { isBookingShownIn } from "@/lib/booking-delete-visibility";
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
 * The `Payment.status` values that mean MONEY WAS TAKEN — captured, and possibly
 * refunded since. `REFUNDED` belongs here: the question is whether a capture
 * ever happened, not whether the club still holds the cash.
 *
 * THE ONE HOME for this list (`INV-SSOT-001`, #3340, #3503). Every reader of an
 * aggregate `Payment.status` asks `isCapturedPaymentStatus` or spreads
 * `CAPTURED_PAYMENT_STATUS_LIST`. `payment-transaction-status-list-guard.test.ts`
 * holds that by TEXT over `src/`, `scripts/` and `prisma/` (not migrations): it
 * refuses a list, comparison chain, fall-through `switch`, `true`-keyed map or
 * SQL `IN (…)` naming exactly these three, outside its named exceptions, and
 * pins the set of modules that read `isCapturedPaymentStatus` or
 * `CAPTURED_PAYMENT_STATUS_LIST` directly. Readers of the derived
 * `hasCapturedPayment` / `getRemainingRefundableCents` are not registered; the
 * guard's by-name receiver tripwire refuses `hasCapturedPayment` handed a
 * value named for a transaction, and nothing stronger. It cannot see a copy built
 * indirectly (a filter over the enum, a list assembled at runtime) or a superset
 * of these three. #3340 once routed
 * `additional-ledger-gap.ts` here, but that module reads `PaymentTransaction`
 * rows, so #3632 moved it to the transaction leaf. This file is a pure leaf — no
 * client, no logger, no `server-only` — so a census, a route and a page can all
 * import it without dragging anything behind it.
 *
 * NOT the same list as `isCapturedTransactionStatus` in `payment-transaction-status.ts`,
 * which asks the question of ONE `PaymentTransaction` rather than of the
 * aggregate. The two spell the same three values today and answer different
 * questions; merging them would be a claim about the ledger that this list is not
 * making.
 */
export const CAPTURED_PAYMENT_STATUS_LIST = [
  "SUCCEEDED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
] as const;

const CAPTURED_PAYMENT_STATUSES = new Set<string>(CAPTURED_PAYMENT_STATUS_LIST);

/**
 * M6 (#2262): the `Payment.status` values a manual cash / off-Xero settlement
 * may settle FROM. PENDING/PROCESSING are the ordinary unsettled shapes; FAILED
 * is a legitimate settle-from too — a declined or expired card attempt is
 * exactly what an admin remedies with cash at the lodge. SUCCEEDED and the
 * refunded variants can never be flipped: money has already moved through this
 * payment, and recording cash over the top of it would misstate the ledger.
 *
 * Lives in this leaf module (#2397) because THREE places must agree: the
 * read-time refusal and the fenced write in `payment-reconciliation.ts`, and
 * the admin page's advisory state in `manual-booking-payment-state.ts`. Keeping
 * it here lets the last of those share it without dragging the whole
 * reconciliation module (and Stripe with it) into a page's import graph.
 */
export const MANUAL_SETTLE_FROM_PAYMENT_STATUS_LIST = [
  "PENDING",
  "PROCESSING",
  "FAILED",
] as const;

const MANUAL_SETTLE_FROM_PAYMENT_STATUSES = new Set<string>(
  MANUAL_SETTLE_FROM_PAYMENT_STATUS_LIST
);

/**
 * #2397: the refusal an already-captured payment gets, shared so the admin page
 * shows the SAME sentence before the click that the server returns after it.
 */
export const MANUAL_CAPTURED_PAYMENT_REFUSAL =
  "This booking's payment has already taken money — it cannot also be recorded as a cash settlement. Check the payment (and any refund owing) before recording anything.";

/** Whether a manual cash / off-Xero settlement may settle from this status. */
export function isManualSettleFromPaymentStatus(status: string): boolean {
  return MANUAL_SETTLE_FROM_PAYMENT_STATUSES.has(status);
}

// Booking statuses whose payment lifecycle has been entered (an invoice can
// exist / money can have moved). Moved here from booking-modify-settlement
// (#1729) so the Xero period lock-date guard can share the derivation below
// without importing the whole modify-settlement chain.
const SETTLED_BOOKING_STATUSES = new Set([
  "PAYMENT_PENDING",
  "CONFIRMED",
  "PAID",
  "COMPLETED",
]);

export function isSettledBookingStatus(status: string): boolean {
  return SETTLED_BOOKING_STATUSES.has(status);
}

/**
 * A booking's PRIMARY Xero invoice counts as issued for edit-settlement
 * purposes when the booking is in a settled-lifecycle status and its payment
 * row carries the Xero invoice id. This is the exact `hasIssuedXeroInvoice`
 * that `applyPaymentAdjustments` feeds `queueXeroBookingEditSettlement`,
 * shared with the pre-transaction ordinary-edit lock-date guard (#1729).
 */
export function hasIssuedPrimaryXeroInvoice(booking: {
  status: string;
  // REQUIRED, not optional (#3200 review), because the failure it prevents is
  // silent: a caller handed a payment loaded without this column is told "no
  // invoice raised" for ever, so the difference is simply never billed and
  // nothing fails or logs.
  //
  // `xeroInvoiceId?` did NOT leave that open today, and the reason is worth
  // knowing before anyone relaxes it again: one optional property and nothing
  // else makes this a WEAK type, which TypeScript rejects when the argument has
  // no property in common. That cover is incidental and narrow. Measured: give
  // this shape a SECOND optional field, or hand it a loosely-typed payment
  // (`Record<string, unknown>`), and the old signature accepted both in
  // silence. Required is the version that does not depend on staying one field
  // wide — `INV-SSOT-001`, unrepresentable over policed.
  payment: { xeroInvoiceId: string | null } | null | undefined;
}): boolean {
  return (
    isSettledBookingStatus(booking.status) &&
    Boolean(booking.payment?.xeroInvoiceId)
  );
}

export interface BookingPaymentState {
  status: string;
  amountCents?: number | null;
  refundedAmountCents?: number | null;
}

/**
 * #3244: the STATUS half, named, because it is a question in its own right and
 * two callers want it without the amount clause below.
 *
 * `hasCapturedPayment` folds two facts together — a captured status AND money
 * actually held — and most callers want the conjunction. A caller that wants
 * only "is this one of the states money has moved through?" used to have no way
 * to say so except by rebuilding the list, which is how a hand-written triple
 * came to sit in four modules. Now it asks this.
 *
 * Still the AGGREGATE `Payment` question. Not `isCapturedTransactionStatus` in
 * `payment-transaction-status.ts`, which asks it of one `PaymentTransaction`; the two
 * spell the same three values and answer different questions, and the docblock
 * at the top of this file is the standing warning against merging them.
 */
export function isCapturedPaymentStatus(status: string): boolean {
  return CAPTURED_PAYMENT_STATUSES.has(status);
}

export function hasCapturedPayment(
  payment: BookingPaymentState | null | undefined
): boolean {
  if (!payment || !isCapturedPaymentStatus(payment.status)) {
    return false;
  }

  if (typeof payment.amountCents === "number") {
    return payment.amountCents > 0;
  }

  return true;
}

export function getRemainingRefundableCents(
  payment: BookingPaymentState | null | undefined
): number {
  if (!payment || !hasCapturedPayment(payment)) {
    return 0;
  }

  return Math.max(
    (payment.amountCents ?? 0) - (payment.refundedAmountCents ?? 0),
    0
  );
}

/**
 * #3372: ONE payment row's amount net of what has gone back out of it —
 * `amountCents - refundedAmountCents`, with NO status gate and no floor. It is
 * the figure the payments list's "Amount (net)" column shows for every row
 * (`INV-PAY-047`), and the order that column sorts in, so a list whose headline
 * is net cannot be sorted or described by a different sum.
 *
 * NOT `getRemainingRefundableCents` above, which asks a different question —
 * "how much more could a refund take out?" — and so answers 0 whenever nothing
 * was captured: a PENDING or FAILED row has nothing to refund, but its row still
 * shows its amount. Routing the column through that helper would blank every
 * unpaid row.
 *
 * `refundedAmountCents` counts cancellation credit to the member's account as
 * well as money back to the card (`INV-PAY-050`), so "net of refunds and
 * credits" is the honest reading, not "cash the club holds".
 *
 * Both fields are REQUIRED, not the optional `BookingPaymentState` shape: a row
 * loaded without `refundedAmountCents` would otherwise read as unrefunded and
 * print the gross — the #3340 misreading this helper exists to prevent.
 */
export function getPaymentNetOfRefundsCents(payment: {
  amountCents: number;
  refundedAmountCents: number;
}): number {
  return payment.amountCents - payment.refundedAmountCents;
}

/**
 * #3372: the "{gross} paid, {refunded} refunded or credited" line printed
 * beneath a net headline, so the arithmetic is on screen — the one wording for
 * the payments list, the dashboard card and the change-requests panel.
 *
 * Returns `null` when nothing was refunded or credited, and every caller renders
 * the line only when it is non-null, so the guard lives here once rather than
 * at three sites. The caller supplies its own cents formatter (exact cents —
 * never a rounded one, which could disagree with the headline by a dollar), so
 * this leaf keeps no formatting import. It makes no net-versus-gross choice of
 * its own: the caller decides which sums it passes.
 */
export function formatPaidRefundedBreakdown(
  grossCents: number,
  refundedCents: number,
  formatCents: (cents: number) => string,
): string | null {
  if (refundedCents <= 0) return null;
  return `${formatCents(grossCents)} paid, ${formatCents(refundedCents)} refunded or credited`;
}

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
  /**
   * With `_count` below, the capture evidence a refunded status needs before it
   * counts as money received (`netCollectedPaymentTookMoney`). Both are loaded by
   * `netCollectedCaptureEvidenceSelect` in `additional-ledger-gap.ts`.
   */
  source: string;
  /**
   * `transactions`: how many of the payment's `PaymentTransaction` rows hold a
   * CAPTURED status (`CAPTURED_TRANSACTION_STATUS_LIST`) - a filtered relation
   * count, never a count of every row: an Internet Banking payment carries a
   * PENDING ledger row before it is paid.
   */
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
 * #3372 (owner's rule on PR #3811: only money actually received counts): did
 * this payment take money, for a Net Collected figure?
 *
 * A captured `Payment.status` is not enough on its own. `SUCCEEDED` is taken at
 * its word, as before. A refunded status (`REFUNDED` / `PARTIALLY_REFUNDED`)
 * counts only with the capture evidence the cancel path asks
 * (`paymentShowsCaptureEvidence`): a captured ledger row, or a STRIPE refund
 * mirror. The Xero inbound reconcile folds an invoice-applied modification
 * credit note into a never-paid Internet Banking payment's mirror and marks it
 * `PARTIALLY_REFUNDED` - bookkeeping, not cash - and that payment's
 * `amountCents` is the full price it was created at, so without the evidence
 * the figure counted most of an unpaid booking's price as received. A paid
 * Internet Banking payment carries a captured ledger row (the receipt writes
 * one), so a later partial refund still leaves its remaining cash counted.
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
 *   (`getRemainingRefundableCents`): 0 if it never took money, never below 0.
 *   "Took money" is `netCollectedPaymentTookMoney`: a refunded status counts
 *   only with captured-ledger or STRIPE-mirror evidence, so a never-paid
 *   Internet Banking payment the inbound reconcile marked PARTIALLY_REFUNDED
 *   adds nothing, live or cancelled.
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
 * The base a paid-path cancellation tiers its refund off (#1031, INV-PAY-018) -
 * the one derivation, shared by the executed cancel (`booking-cancel.ts`) and
 * the preview a member sees before confirming (`booking-route-decisions.ts`),
 * which must agree (`INV-SSOT`).
 *
 * What was paid and not yet handed back (`amountCents - refundedAmountCents`),
 * capped at what the booking is now worth (`finalPrice + changeFee`), less the
 * non-refundable change fee. The cap is why a stale mirror cannot pay out more
 * than the booking is worth; the refunded term is why an understated mirror
 * would (#3640).
 */
export function cancelRefundableBaseCents(input: {
  amountCents: number;
  refundedAmountCents: number;
  finalPriceCents: number;
  changeFeeCents: number;
}): number {
  const paidAmountCents = input.amountCents - input.refundedAmountCents;
  return (
    Math.min(paidAmountCents, input.finalPriceCents + input.changeFeeCents) -
    input.changeFeeCents
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
 * #1473/#1491: the pre-ledger half of a cancel's capture evidence, for a payment
 * with no captured `PaymentTransaction` row to read. A STRIPE payment's refund
 * mirror is trustworthy there: a Stripe refund needs a captured charge, and the
 * invoice-side fold cannot reach an uncaptured Stripe booking (its Xero invoice
 * is issued only at or after capture). Any other source's mirror is NOT: the
 * inbound reconcile folds invoice-applied modification credit notes into
 * `refundedAmountCents` / `PARTIALLY_REFUNDED` on never-captured Internet
 * Banking payments, which is bookkeeping, not cash. The one home for that rule
 * (`INV-SSOT-001`, #3630); every caller asks it through
 * `paymentShowsCaptureEvidence` below, after its own ledger read.
 */
export function stripeRefundMirrorShowsCapture(payment: {
  source: string;
  status: string;
  refundedAmountCents: number;
}): boolean {
  return (
    payment.source === "STRIPE" &&
    (payment.status === "REFUNDED" ||
      payment.status === "PARTIALLY_REFUNDED" ||
      payment.refundedAmountCents > 0)
  );
}

/**
 * #1473/#1491: THE capture evidence for a payment whose aggregate status cannot
 * be taken at its word - ledger truth first (the caller says whether the
 * payment has a `PaymentTransaction` row with a captured status, read through
 * `CAPTURED_TRANSACTION_STATUS_LIST` / `isCapturedTransactionStatus`), then the
 * pre-ledger STRIPE mirror (`stripeRefundMirrorShowsCapture`). One home
 * (`INV-SSOT-001`) for the cancel path (`booking-cancel.ts`, after a ledger
 * query), the flattened-status backfill (an in-memory ledger read) and Net
 * Collected (`netCollectedPaymentTookMoney`, a filtered relation count).
 */
export function paymentShowsCaptureEvidence(
  payment: { source: string; status: string; refundedAmountCents: number },
  hasCapturedLedgerRow: boolean,
): boolean {
  return hasCapturedLedgerRow || stripeRefundMirrorShowsCapture(payment);
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
 * which is never below 0, and 0 for a payment that never took money
 * (`netCollectedPaymentTookMoney`: a refunded status needs capture evidence). So a cancelled booking that was never paid adds nil. The old
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

/**
 * The payment shape the two accessors below need, spelled out so a caller cannot
 * hand them a payment row loaded without its id.
 */
export type EditReviewSettlementPayment =
  | (BookingPaymentState & { id: string })
  | null
  | undefined;

/**
 * #3166 / #3194 (epic #2797): the captured payment a PARKED edit's financial
 * review settles against, or `null` — THE one derivation of that rule
 * (`INV-SSOT`), asked at both ends of the review's life.
 *
 * It answers "is there money behind this booking that a refund could come out
 * of?", and it answers it the way the whole settlement surface already does: the
 * booking is inside its payment lifecycle AND the payment row has actually
 * captured something. Neither half is sufficient on its own. `Payment.source`
 * defaults to `STRIPE` in the schema, so a hand-settled booking carries that
 * column with nothing captured behind it; and a DRAFT or WAITLISTED booking can
 * hold a `PENDING` payment row that has never taken a cent. It is the same test
 * `applyPaymentAdjustments` uses, so a booking with nothing taken carries null
 * and a confirmed amount can never be routed to a refund of money that was never
 * received. Null is an ordinary answer, not a gap: owner decision D2 makes the
 * task's `paymentId` nullable precisely because a credit owed for a surrendered
 * night need not sit against any one captured payment.
 *
 * TWO CALLERS, ONE QUESTION, and the second is why this returns the payment ROW:
 *
 *  - AT RAISE TIME, `raiseParkedEditFinancialReviewTasks` stamps the id onto the
 *    task. Four parked edit doors (the batch edit, the date change, the
 *    single-guest removal and the guest-add route) each computed it inline from
 *    the same two predicates before #3166 gathered them.
 *  - AT COMPLETION, `chooseEditReviewSettlementRoute` re-asks it of the booking
 *    as it stands NOW, but ONLY where the task carries no id — the stamped value
 *    is a snapshot of the moment the edit parked and nothing backfills it, so a
 *    member who paid afterwards would otherwise be refunded as club credit for
 *    ever. That path needs the row's `source` as well as its id to tell a card
 *    refund from a hand-settled ledger mirror, and re-reading the same row
 *    through a second accessor would reintroduce the disagreement this removes.
 *
 * Getting it wrong does not fail: it routes real money down the wrong path weeks
 * later, in front of an admin with no way to tell. That is why both ends read
 * this and not a copy of it.
 *
 * Lives here beside `hasIssuedPrimaryXeroInvoice`, which is the same shape for
 * the same reason, rather than in `edit-financial-review.ts` — that module is
 * deliberately about the review STATE and reads no payment policy of its own.
 *
 * NOT the same question as the `account-credit` route's
 * `allocateAgainstPaymentId`, which deliberately drops the settled-status half;
 * `edit-financial-review-settlement.ts` states why at that site.
 */
export function editReviewSettlementPayment<
  T extends BookingPaymentState & { id: string },
>(booking: { status: string; payment: T | null | undefined }): T | null {
  return isSettledBookingStatus(booking.status) &&
    hasCapturedPayment(booking.payment)
    ? (booking.payment ?? null)
    : null;
}

/**
 * The id half of `editReviewSettlementPayment` above, which is all a raise site
 * stores. Derived from it rather than repeating its two predicates, so the two
 * ends of a review's life cannot drift apart (`INV-SSOT`).
 */
export function editReviewSettlementPaymentId(booking: {
  status: string;
  payment: EditReviewSettlementPayment;
}): string | null {
  return editReviewSettlementPayment(booking)?.id ?? null;
}
