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
 * #3827 (`INV-PAY-117`): the remaining refundable cash LESS the edit refunds
 * the club has promised back by bank transfer and not yet sent. The one
 * arithmetic for the server cap (`refundableCashNetOfOpenHandBacks`, which
 * reads the promised sum) and the screens that show that cap from a loaded
 * row (`sumOpenNonCancellationHandBackCents`), so the ceiling a screen offers is
 * the ceiling the route enforces.
 */
export function getRemainingRefundableCentsNetOf(
  payment: BookingPaymentState | null | undefined,
  promisedBackCents: number
): number {
  return Math.max(0, getRemainingRefundableCents(payment) - promisedBackCents);
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
 *
 * #3827 (`INV-PAY-117`): "not yet handed back" also excludes the edit refunds
 * already PROMISED back by hand (`openNonCancellationHandBackCents`, the sum of the
 * payment's open edit refund hand-backs), REQUIRED so no caller can forget it:
 * a cancellation must not refund or credit cash the treasurer still owes on an
 * earlier edit's task.
 */
export function cancelRefundableBaseCents(input: {
  amountCents: number;
  refundedAmountCents: number;
  openNonCancellationHandBackCents: number;
  finalPriceCents: number;
  changeFeeCents: number;
}): number {
  const paidAmountCents =
    input.amountCents - input.refundedAmountCents - input.openNonCancellationHandBackCents;
  return (
    Math.min(paidAmountCents, input.finalPriceCents + input.changeFeeCents) -
    input.changeFeeCents
  );
}

/**
 * #3809: the applied-credit slice a paid cancellation tiers, capped exactly as
 * the card slice is - money paid and credit applied together count no further
 * than the booking is now worth, money first. Without the cap, credit left
 * applied above a reduced price (a reduction's policy-kept share) came back at
 * the cancellation, so a credit-paid member got more than a card-paid one.
 * The difference of two `cancelRefundableBaseCents`, so there is one base rule.
 *
 * ONLY FOR A BOOKING REDUCED THROUGH #3809's SETTLEMENT (owner decision of 4 Oct
 * 2026, "Cap new reductions only"): `capAtWorth` is
 * `bookingReducedThroughCreditGiveBack`. Any other booking tiers all the credit
 * still applied, as before the cap - a credit-paid booking reduced before that
 * release is never short.
 */
export function cancelAppliedCreditBaseCents(input: {
  amountCents: number;
  refundedAmountCents: number;
  /**
   * The payment's open edit / refund-request hand-backs (#3827, `INV-PAY-117`):
   * cash already promised back, which counts as paid no more here than it does
   * in `cancelRefundableBaseCents`, so the cap reads the same paid figure.
   */
  openNonCancellationHandBackCents: number;
  finalPriceCents: number;
  changeFeeCents: number;
  creditAppliedCents: number;
  capAtWorth: boolean;
}): number {
  if (!input.capAtWorth) return Math.max(0, input.creditAppliedCents);
  const withCredit = cancelRefundableBaseCents({ ...input, amountCents: input.amountCents + input.creditAppliedCents });
  return Math.max(0, Math.min(input.creditAppliedCents, withCredit - cancelRefundableBaseCents(input)));
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
 * #1473/#1491: THE capture evidence for a payment whose status cannot be taken
 * at its word - a captured ledger row (each caller's own read), else the STRIPE
 * mirror. One home (`INV-SSOT-001`): `booking-cancel.ts`, the flattened-status
 * backfill and Net Collected (`netCollectedPaymentTookMoney`) all ask it.
 */
export function paymentShowsCaptureEvidence(
  payment: { source: string; status: string; refundedAmountCents: number },
  hasCapturedLedgerRow: boolean,
): boolean {
  return hasCapturedLedgerRow || stripeRefundMirrorShowsCapture(payment);
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

/**
 * #3194 / #3536: the payment an edit review's REFUND comes back out of, and its
 * source - the stored task id where it has one, else the booking's own captured
 * payment re-asked now. `chooseEditReviewSettlementRoute` picks its refund route
 * from this, and the settle queue asks it ahead of time so the cash-or-bank
 * question is offered only where the club pays the money back by hand.
 */
export function editReviewRefundSettlementPayment(task: {
  paymentId: string | null;
  payment: { source: string } | null | undefined;
  booking: {
    status: string;
    payment: (BookingPaymentState & { id: string; source: string }) | null | undefined;
  };
}): { id: string; source: string | null } | null {
  if (task.paymentId !== null) {
    return { id: task.paymentId, source: task.payment?.source ?? null };
  }
  const backfilled = editReviewSettlementPayment(task.booking);
  return backfilled ? { id: backfilled.id, source: backfilled.source } : null;
}

/**
 * #3536: THE one test of "this refund goes back on the card" for a payment
 * `editReviewRefundSettlementPayment` returned (`INV-SSOT`).
 * `chooseEditReviewSettlementRoute` takes the `stripe-refund` route exactly when
 * this is true, and `editReviewRefundIsPaidBackByHand` below is exactly its
 * complement over a non-null payment, so a new `PaymentSource` cannot be sent
 * down one route by the chooser and offered the other by the settle screen. A
 * missing source counts as NOT a card, matching the chooser's ledger fallback.
 */
export function editReviewRefundGoesBackOnCard(payment: {
  source: string | null;
}): boolean {
  return payment.source === "STRIPE";
}

/**
 * #3536: a refund on this review would be paid back by hand - the
 * `local-allocation` route - because the money behind it did not go out on a
 * card. Only the officer knows whether that hand-back was cash or a bank
 * transfer, so this is where the screen asks.
 */
export function editReviewRefundIsPaidBackByHand(
  task: Parameters<typeof editReviewRefundSettlementPayment>[0],
): boolean {
  const payment = editReviewRefundSettlementPayment(task);
  return payment !== null && !editReviewRefundGoesBackOnCard(payment);
}
