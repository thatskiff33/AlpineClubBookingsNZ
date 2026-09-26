/**
 * The `Payment.status` values that mean MONEY WAS TAKEN — captured, and possibly
 * refunded since. `REFUNDED` belongs here: the question is whether a capture
 * ever happened, not whether the club still holds the cash.
 *
 * THE ONE HOME for this list (`INV-SSOT-001`, #3340). There were two copies —
 * this module's and `additional-ledger-gap.ts`'s — and the change that
 * generalised the ledger mirror added a third, which is the finding that put the
 * list here. This file is a pure leaf — no
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
 * Money collected on a set of payments: what was captured, what has gone back
 * out as a refund or an account credit, and the difference.
 */
export interface CollectedCashSummary {
  /** `Payment.amountCents` summed over captured payments only — before refunds. */
  capturedGrossCents: number;
  /**
   * `Payment.refundedAmountCents` summed — card refunds and cancellation credit
   * to the member's account alike (`INV-PAY-050`).
   */
  refundedCents: number;
  /**
   * `capturedGrossCents - refundedCents`, floored at zero: collected money net
   * of refunds AND credits. Not "cash the club holds" — a credit is still owed
   * to the member as a future booking, and it is subtracted here all the same.
   */
  netCollectedCents: number;
}

/**
 * #3372: net collected cash over a set of payments, for the officer surfaces —
 * the Reports summary, the dashboard's "Net Collected This Month" card and the
 * payments board's "Net Collected Cash" tile all read it (`INV-SSOT-001`), so
 * they cannot disagree about what "net of refunds and credits" means. Each
 * surface still decides WHICH payments it hands in — a month's, a filter's, a
 * report range's — and says so on screen. Rows may be whole payments or
 * `groupBy` sums per status: the arithmetic is linear, so a status group is the
 * same as its members.
 *
 * Captured is `isCapturedPaymentStatus` above. `refundedCents` is summed over
 * EVERY row handed in, captured or not, and the net is floored at zero.
 *
 * Cash is payment-derived and deliberately NOT allocated over stay nights.
 * `Payment.amountCents` already contains captured additions (#2408); rebuilding
 * it from transaction rows would undercount legacy/group captures or double
 * count a later addition.
 *
 * KNOWN SECOND COPY: `src/lib/finance-booking-metrics.ts` still sums
 * `capturedGrossCents`, `refundedCents` and the floored net by hand for the
 * finance dashboard, against its own `FINANCE_CAPTURED_PAYMENT_STATUSES`. It is
 * being converged onto this function by a follow-up child of epic #3372; until
 * then a change to the rule here must be made there too.
 *
 * `status` is `string | null`, not `PaymentStatus`: the payments service hands
 * in a plain string, and a `null` (no payment) captures nothing.
 */
export function summarizeCollectedCash(
  payments: ReadonlyArray<{
    status: string | null;
    amountCents: number;
    refundedAmountCents: number;
  } | null>,
): CollectedCashSummary {
  let capturedGrossCents = 0;
  let refundedCents = 0;
  for (const payment of payments) {
    if (!payment) continue;
    if (payment.status !== null && isCapturedPaymentStatus(payment.status)) {
      capturedGrossCents += payment.amountCents;
    }
    refundedCents += payment.refundedAmountCents;
  }
  return {
    capturedGrossCents,
    refundedCents,
    netCollectedCents: Math.max(capturedGrossCents - refundedCents, 0),
  };
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
