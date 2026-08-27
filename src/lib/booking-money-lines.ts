/**
 * Canonical booking-money rows and the arithmetic behind them.
 *
 * Separated from `booking.ts` because the same figures have to appear on BOTH
 * sides of a transaction: the member's confirmation says what to transfer, and
 * `admin-booking.ts` tells an admin what to invoice by hand for the very same
 * booking. Sharing the resolver is what stops the two disagreeing; a second
 * copy is how they would.
 *
 * Money is integer cents throughout. Values here are unescaped plain text —
 * the HTML templates escape at their own edge.
 *
 * This is domain code rather than rendering code: it holds no HTML and does not
 * import `escapeHtml`. Email renderers consume its rows at their escaping edge,
 * while `booking-confirmation-credit.ts` and `xero-credit-sync-checker.ts` use
 * the same arithmetic directly. Keeping the module at the `src/lib` business
 * boundary makes that ownership explicit without duplicating the calculation.
 *
 * THE ONE DATE IT RENDERS IS A LODGE NIGHT, AND IT TAKES NO TIMEZONE (#3123).
 * Every date this module formats is a `Booking.checkIn`/`checkOut` value — a
 * `DateTime @db.Date` calendar day, the same day everywhere on earth. It goes
 * through `emailCalendarDay`, which consults no zone and refuses a value
 * carrying a time of day, and which is the same function `email/booking.ts`
 * renders these two columns with in nine other places. That shared seam is the
 * "a second copy is how they would disagree" rule above, applied to a date
 * instead of an amount. It is deliberately NOT the club-zone formatter: a
 * blanket sweep of the retired `nzst-date` adapter onto the club's zone would
 * have introduced two brand-new wrong-day defects here and fixed nothing.
 */
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import { type BookingPaymentDueCredit } from "@/lib/email-message-notes";
import { formatCents as formatMoneyCents } from "@/lib/utils";

/**
 * #2267: the single source of truth for the signed promo adjustment behind a
 * booking's price, shared by the hand-built HTML confirmation and the send that
 * fills the admin-editable body so the two can never derive it differently.
 *
 * `promoAdjustmentCents` (the pricing policy's signed `priceAdjustmentCents`)
 * wins when present; older bookings only carry `discountCents`, which can only
 * ever describe a price cut, so it becomes a negative adjustment.
 */
export function resolvePromoAdjustmentCents(options?: {
  discountCents?: number;
  promoAdjustmentCents?: number;
}): number {
  return (
    options?.promoAdjustmentCents ??
    (options?.discountCents && options.discountCents > 0
      ? -options.discountCents
      : 0)
  );
}

/**
 * #2267: the single source of truth for how a promo shows on money emails —
 * shared by the hand-built HTML confirmation (bookingConfirmedTemplate) and the
 * flat {{promoSummary}} token the admin-editable body renders, so the two
 * paths cannot drift apart again (the 31651e00 failure mode).
 *
 * `promoAdjustmentCents` is the signed pricing-policy adjustment
 * (priceAdjustmentCents): negative for a discount, positive for a
 * FIXED_NIGHTLY/SET_PRICE promo that raises the price. Empty when zero — no
 * promo means no rows at all, never ragged "Subtotal:"/"Promo adjustment ():"
 * lines. Values are unescaped plain text; the HTML path escapes at the edge.
 */
export function promoAdjustmentSummaryRows(
  totalCents: number,
  promoAdjustmentCents: number,
  promoCode?: string,
): Array<{ label: string; value: string }> {
  if (promoAdjustmentCents === 0) return [];
  const subtotalCents = totalCents - promoAdjustmentCents;
  const adjustmentPrefix = promoAdjustmentCents > 0 ? "+" : "-";
  return [
    { label: "Subtotal", value: formatMoneyCents(subtotalCents) },
    {
      label: promoCode ? `Promo adjustment (${promoCode})` : "Promo adjustment",
      value: `${adjustmentPrefix}${formatMoneyCents(Math.abs(promoAdjustmentCents))}`,
    },
  ];
}

/**
 * #2328: how the money that was NOT taken from the member's card was settled.
 *
 * Only ever used to label the second line of the applied-credit pair, so the
 * confirmation never tells a member who bank-transferred that their card was
 * charged. Mirrors the `refundMethod` parameter `sendBookingCancelledEmail`
 * has always carried. Resolved from the booking's PERSISTED Payment row
 * (`loadBookingAppliedCredit`), never from a policy re-computation.
 */
export type ConfirmationSettlementMethod = "card" | "bank_transfer" | "manual";

/**
 * #2328: the applied-account-credit facts a booking confirmation needs, read
 * off the booking's own persisted records.
 */
export interface AppliedCreditSummary {
  /**
   * Account credit applied to this booking, as a POSITIVE integer-cents
   * amount (the ledger's `|Σ BOOKING_APPLIED|`). Zero for the overwhelming
   * majority of bookings, which renders no credit lines at all.
   */
  amountCents: number;
  /** How the remainder was settled; labels the "Paid by …" line. */
  settlementMethod: ConfirmationSettlementMethod;
}

const SETTLED_LINE_LABELS: Record<ConfirmationSettlementMethod, string> = {
  card: "Paid by card",
  bank_transfer: "Paid by bank transfer",
  manual: "Paid by cash or bank transfer",
};

/**
 * #2328 (review): the label used when the settled figure is EXACTLY $0.00 —
 * account credit covered the whole stay and no money changed hands by any
 * method.
 *
 * Method-NEUTRAL on purpose, because at $0.00 there is no evidence for a
 * method claim. A fully-credit-covered booking is settled by writing a Payment
 * row with `amountCents: 0` and NO `source`
 * (`src/lib/booking-create.ts`, the `isZeroDollarConfirmed` branch; and the
 * `paid_zero` upsert in
 * `src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts`), so the
 * row takes the schema default `PaymentSource.STRIPE` whatever the member
 * actually elected — and the branch itself is payment-method agnostic. A
 * method-bearing label therefore tells an Internet-Banking member with no card
 * on file "Paid by card: $0.00", which is a claim the records do not support.
 *
 * The line is NOT dropped: `total − credit = $0.00` is exactly the arithmetic
 * the pair exists to complete, and it is the case where "Total Paid: $300.00"
 * alone was at its most misleading. Only the method word goes. Non-zero
 * settlements keep the method-aware labels above, which ARE evidence-backed —
 * a real card charge or bank transfer writes its own source.
 */
const NOTHING_SETTLED_LABEL = "Nothing more to pay";

/**
 * #2328 × #2483: the one label under which account credit appears on a booking
 * confirmation, whether the booking is settled (the pair below) or still owing
 * (the netting rows further down). Shared so the two money outcomes cannot end
 * up naming the same thing differently.
 */
const APPLIED_CREDIT_LABEL = "Account credit applied";

/**
 * #2328: the single source of truth for how APPLIED ACCOUNT CREDIT shows on a
 * booking confirmation — shared by the hand-built HTML confirmation
 * (`bookingConfirmedTemplate`) and the flat `{{creditNote}}` token the
 * admin-editable body renders, exactly as `promoAdjustmentSummaryRows` is
 * shared for promos, so the two paths cannot drift.
 *
 * The bug it fixes: a member who paid $300.00 partly from account credit read
 * "Total Paid: $300.00" while their card statement said $180.00, with nothing
 * in the email to explain the gap. The pair below reconciles the two —
 * "Total Paid" stays the booking's FULL price (that is what the stay cost, and
 * the credit really did pay for part of it), and these rows say where the money
 * came from, so `total − credit = card` adds up on the page.
 *
 * `settledCents` is what the club took by card/bank/cash for this booking,
 * i.e. the settled amount MINUS the applied credit. Empty (no rows at all,
 * never a ragged label) when no credit was applied — the byte-for-byte
 * unchanged case — and also when `settledCents` is negative, which happens on
 * a send that reports money as NOT yet taken (no "paid by" story to tell, and
 * it must not invent one) or when more credit was consumed than the booking is
 * now worth. Both of those suppressions are logged by the SENDER rather than
 * here, where the booking id is in hand and the warning fires exactly once per
 * send — see `sendBookingConfirmedEmail` in `src/lib/email/booking.ts`, which
 * is the only caller of this module's confirmation template.
 *
 * At EXACTLY $0.00 settled the second line loses its method word (see
 * `NOTHING_SETTLED_LABEL`) but stays, because the arithmetic is the point.
 * Money is integer cents throughout; values are unescaped plain text, and the
 * HTML path escapes at its own edge.
 */
export function appliedCreditSummaryRows(
  appliedCreditCents: number,
  settledCents: number,
  settlementMethod: ConfirmationSettlementMethod = "card",
): Array<{ label: string; value: string }> {
  if (appliedCreditCents <= 0 || settledCents < 0) return [];
  return [
    {
      label: APPLIED_CREDIT_LABEL,
      value: `-${formatMoneyCents(appliedCreditCents)}`,
    },
    {
      // #2328 (review): a $0.00 settlement has no method to name — the Payment
      // row behind it is written without a source and takes the schema default.
      label:
        settledCents === 0
          ? NOTHING_SETTLED_LABEL
          : SETTLED_LINE_LABELS[settlementMethod],
      value: formatMoneyCents(settledCents),
    },
  ];
}

/**
 * #2328: the settled-by-non-credit figure the pair above reports, for whichever
 * of the confirmation's three money outcomes this send is.
 *
 * Kept beside the row builder, and used by BOTH the HTML template and the
 * sender, because getting this wrong is how the two paths would disagree about
 * the same booking:
 *  - unpaid (`paymentDue`): nothing has been settled at all, so there is no
 *    "paid by" figure — returns a negative sentinel that suppresses the rows.
 *
 *    That suppression is about the SETTLEMENT half of the pair only, and it is
 *    unconditionally right: no money has moved, so there is no "Paid by card"
 *    line to write. It does NOT mean an unpaid confirmation stays silent about
 *    credit. Since #2483 the unpaid branch states the netting in its own shape
 *    — booking total, credit applied, amount to transfer — built by
 *    `unpaidMoneySummaryRows` below. Before #2483 the whole subject was
 *    suppressed here, which was defensible only while no send site could pair
 *    `paymentDue` with applied credit;
 *
 *    A #2444 DRAFT claimed the invoice for this booking has the member's
 *    floating credit notes ALLOCATED against it under #1620, because the send
 *    site enqueues an allocation op a few lines above the send. That is WRONG
 *    as a statement about TODAY'S path and is retracted (re-verified 1 Aug
 *    2026): `enqueueXeroAppliedCreditAllocationOperation` only queues anything
 *    when the booking already carries `BOOKING_APPLIED` ledger rows, and the
 *    one live `paymentDue` path writes none, so it always returns
 *    `{ queueOperationId: null }` and the invoice stands at the FULL amount.
 *    #2483 nets that branch LOCALLY because `deriveBookingAppliedCreditCents`
 *    is the club's own amount-owing law, not a guess at Xero — see
 *    `resolveUnpaidCreditNetting` below, which also states precisely where the
 *    email's read and the allocation gate's read can come apart (the gate sees
 *    only the `xeroCreditNoteId: null` subset) and what #2501 has to catch;
 *  - partly paid (`outstandingBalance`, #2397): the settled slice is the
 *    booking's price minus what is still owing, and the credit comes out of
 *    THAT, not out of the full price;
 *  - paid in full: the whole price, minus the credit.
 *
 * Can return a NEGATIVE for a settled booking when more credit was consumed
 * than the booking is now worth. Unreachable today — the #1887 reprice clamp
 * refunds the over-consumed slice as a positive `BOOKING_APPLIED` offset on
 * every repriceable path, so the derived sum never exceeds the price — and the
 * rows are suppressed if it ever happens, which is why the sender logs it.
 */
export function settledByPaymentCents({
  totalCents,
  appliedCreditCents,
  unpaid,
  outstandingCents,
}: {
  totalCents: number;
  appliedCreditCents: number;
  unpaid: boolean;
  outstandingCents: number;
}): number {
  if (unpaid) return -1;
  return totalCents - outstandingCents - appliedCreditCents;
}

/**
 * #2483: what a confirmed-but-UNPAID booking is really asking the member for,
 * once the club's own account-credit ledger has been consulted.
 *
 * The bug. An unpaid confirmation states the booking's full price as
 * "Total Due" and asks the member to transfer it. Where account credit has been
 * applied to that booking app-side, the club's Xero invoice is reduced by
 * exactly that credit (#1620 "allocate-existing" — the allocation is gated on
 * the booking's `BOOKING_APPLIED` ledger rows), so the invoice asks for less
 * than the email does and a member who follows the email OVERPAYS.
 *
 * Why the figure is computed HERE and not read back from Xero (owner decision,
 * 2 Aug 2026). The allocation is asynchronous — queued on the Xero outbox and
 * processed afterwards — so waiting for it would either delay a member-facing
 * confirmation behind a provider operation or make the email's content depend
 * on outbox timing. The owner's direction is that the email uses the booking
 * app's OWN known credits, with no delay and an itemised amount, and that a
 * SEPARATE reconciliation checker (#2501) warns admins whenever the club's
 * ledger and Xero disagree. That split keeps the provider off the send path and
 * puts drift in front of an admin instead of in front of a member.
 *
 * Why that local figure is trustworthy — stated precisely, because an earlier
 * draft of this docblock overstated it (#2483 review, 2 Aug 2026).
 * `deriveBookingAppliedCreditCents` is the club's OWN amount-owing law: it is
 * the same figure `prepareManualSettlement` computes an effective price from
 * (`payment-reconciliation.ts`, `finalPriceCents − derive`), the same figure the
 * card-capture amount guard accepts, and the same `desiredAppliedCents` the Xero
 * deallocation engine converges an invoice to. So the netted figure the member
 * is asked for is exactly what the club would accept as full settlement — which
 * is the property that matters here.
 *
 * What it is NOT is the same predicate the allocation gate reads.
 * `enqueueXeroAppliedCreditAllocationOperation` aggregates only the
 * `xeroCreditNoteId: null` UNALLOCATED subset — a work-remaining filter over the
 * rows this sums — so the two agree only while a stamped row really does mean
 * the credit is already off the LIVE invoice. Three things can break that, and
 * all three are #2501's to surface, not the email's:
 *  - a hand edit to the credit note or invoice in Xero afterwards;
 *  - an allocation op that FAILED or was never processed, leaving the invoice at
 *    the full price with the queued work stalled;
 *  - a stamp that outlived the invoice it recorded (an invoice unlinked and
 *    re-raised), after which the gate finds no unallocated rows and queues
 *    nothing at all.
 * #2501's checker should therefore compare Σ STAMPED `BOOKING_APPLIED` against
 * the live invoice's own allocations, not merely club credits against Xero
 * credits.
 *
 * THE FOUR OUTCOMES. Money is integer cents throughout and the only arithmetic
 * is one subtraction, so no rounding is possible:
 *  - `"none"` — no credit applied (the overwhelming majority, and every send on
 *    today's one live `paymentDue` path), or a non-positive price. Renders the
 *    #2444 message byte-for-byte.
 *  - `"netted"` — credit smaller than the price. States the reconciling trio and
 *    asks for the difference.
 *  - `"covered"` — credit EQUALS the price. Not a contradiction: it is the
 *    documented steady state of the #1887 reprice clamp, and the state the
 *    club's own settle path calls "nothing owing". Folding it into a refusal
 *    that printed the full price would ask a member to pay 100% of a booking
 *    they owe nothing on — so it states `Total Due: $0.00` and asks for nothing.
 *  - `"unreconciled"` — MORE credit applied than the booking costs. The ledger
 *    contradicts the price, so no figure derived from the pair may be shown and
 *    no payment may be asked for. The email states the booking's price as a fact
 *    and nothing as an instruction; the sender logs it for an admin.
 */
export type UnpaidCreditNettingOutcome =
  | "none"
  | "netted"
  | "covered"
  | "unreconciled";

export interface UnpaidCreditNetting {
  /** Which of the four shapes above this send is. */
  outcome: UnpaidCreditNettingOutcome;
  /**
   * Account credit the club's own ledger has applied to this booking, in
   * integer cents. ZERO on `"none"` (none is applied) and on `"unreconciled"`
   * (the figures contradict each other, so none may be stated).
   */
  creditCents: number;
  /**
   * What the member must transfer: the booking's price less `creditCents`.
   * Equals the booking's price on `"none"`, is zero on `"covered"`, and is zero
   * on `"unreconciled"` — where nothing may be asked for at all, so no caller
   * can accidentally render a figure from it.
   */
  toTransferCents: number;
}

export function resolveUnpaidCreditNetting({
  totalCents,
  appliedCreditCents,
}: {
  totalCents: number;
  appliedCreditCents: number;
}): UnpaidCreditNetting {
  const creditCents = Math.max(0, appliedCreditCents);
  if (creditCents === 0 || totalCents <= 0) {
    return { outcome: "none", creditCents: 0, toTransferCents: totalCents };
  }
  if (creditCents > totalCents) {
    return { outcome: "unreconciled", creditCents: 0, toTransferCents: 0 };
  }
  return {
    outcome: creditCents === totalCents ? "covered" : "netted",
    creditCents,
    toTransferCents: totalCents - creditCents,
  };
}

/**
 * #2483: the `accountCredit` argument `bookingPaymentDueNote` takes, derived
 * from one netting by BOTH renderers so neither can pick a different paragraph
 * shape than the money rows beside it. `format` is the caller's own money
 * formatter, which is the only thing the two renderers differ in.
 */
export function unpaidCreditNoteInput(
  totalCents: number,
  netting: UnpaidCreditNetting,
  format: (cents: number) => string,
): BookingPaymentDueCredit | undefined {
  if (netting.outcome === "none") return undefined;
  if (netting.outcome === "unreconciled") return { outcome: "unreconciled" };
  return {
    outcome: netting.outcome,
    bookingTotal: format(totalCents),
    creditApplied: format(netting.creditCents),
  };
}

/**
 * #2483: the amount an admin must invoice BY HAND for a member whole-lodge
 * booking when the Xero module is off — the same figure, from the same
 * resolver, that the member's own confirmation asks them to transfer.
 * See `adminWholeLodgeManualInvoiceTemplate` for why the two must agree and why
 * `"unreconciled"` keeps the gross price.
 */
export function wholeLodgeManualInvoiceAmountCents(
  totalCents: number,
  appliedCreditCents: number,
): number {
  const netting = resolveUnpaidCreditNetting({ totalCents, appliedCreditCents });
  return netting.outcome === "unreconciled"
    ? totalCents
    : netting.toTransferCents;
}

/**
 * #2483: the money rows of an UNPAID confirmation — the single source of truth
 * for them, shared by the hand-built HTML confirmation and the pre-composed
 * `{{paymentOutcome}}` block an admin-editable body renders, exactly as
 * `appliedCreditSummaryRows` is shared for a settled booking.
 *
 * Without netting it is the one "Total Due" line #2263 shipped, so an unpaid
 * confirmation for a member holding no applicable credit is unchanged. With
 * netting it is the reconciling trio #2328 established for a settled booking,
 * in the tense an unpaid one needs: what the stay costs, what the club has
 * already put towards it, and what is left to transfer. "Total Due" keeps its
 * label — it is what the member owes, which is the point of the line — so a
 * saved override built on `{{totalDue}}` states the netted figure with no edit.
 * On `"covered"` that trio still reconciles and lands on `Total Due: $0.00`,
 * which is the honest figure.
 *
 * `"unreconciled"` states the booking's price as `Booking Total` and stops.
 * Calling a figure "Total Due" is an instruction to pay it, and the whole point
 * of that outcome is that no figure derived from a contradictory ledger may be
 * asked for; the paragraph beside these rows says the club will confirm what,
 * if anything, is left.
 *
 * Values are unescaped plain text; the HTML path escapes at its own edge.
 */
export function unpaidMoneySummaryRows(
  totalCents: number,
  netting: UnpaidCreditNetting,
): Array<{ label: string; value: string }> {
  if (netting.outcome === "none") {
    return [{ label: "Total Due", value: formatMoneyCents(totalCents) }];
  }
  if (netting.outcome === "unreconciled") {
    return [{ label: "Booking Total", value: formatMoneyCents(totalCents) }];
  }
  return [
    { label: "Booking Total", value: formatMoneyCents(totalCents) },
    {
      label: APPLIED_CREDIT_LABEL,
      value: `-${formatMoneyCents(netting.creditCents)}`,
    },
    { label: "Total Due", value: formatMoneyCents(netting.toTransferCents) },
  ];
}

/**
 * #2267: the single source of truth for WHICH change rows a booking-modified
 * email shows — shared by the hand-built HTML email (bookingModifiedTemplate)
 * and the flat {{changeSummary}} token the admin-editable body renders, so the
 * two paths cannot tell different stories about the same modification.
 *
 * Only what actually changed is shown as a Previous/New pair; anything
 * unchanged is stated once ("Dates", "Guests", "Total"), and a change fee only
 * appears when one was charged. The flat body used to hardcode every
 * Previous/New row unconditionally, so a guest-only change emailed a member
 * "Previous Dates" and "New Dates" that were identical and a "Change Fee:
 * $0.00" for a booking that was never charged one.
 *
 * Values are unescaped plain text; the HTML path escapes at its edge.
 */
export function bookingModificationSummaryRows(params: {
  oldCheckIn: Date;
  oldCheckOut: Date;
  newCheckIn: Date;
  newCheckOut: Date;
  oldGuestCount: number;
  newGuestCount: number;
  oldFinalPriceCents: number;
  newFinalPriceCents: number;
  changeFeeCents: number;
  // #2390: present only when a promotion's usage cap stopped it reaching
  // somebody this edit added. Added as a row here, rather than as a new
  // template token, so the hand-built HTML email and the admin-editable flat
  // body cannot end up telling different stories about the same split — the
  // whole reason this helper exists.
  promoCoverageNote?: string | null;
}): Array<{ label: string; value: string }> {
  // #3123: `oldCheckIn`/`newCheckIn`/`oldCheckOut`/`newCheckOut` are all
  // `Booking.checkIn`/`checkOut` values — `DateTime @db.Date` lodge nights.
  // A calendar day has no timezone, so `emailCalendarDay` consults none; it is
  // also the exact function `email/booking.ts` renders these same two columns
  // with everywhere else, so the modification rows and the rest of the email
  // cannot spell one booking's nights two ways. `formatNZDate` projected the
  // stored encoding through the container's zone and named the previous night
  // for any club behind Greenwich.
  const dateRange = (from: Date, to: Date) =>
    `${emailCalendarDay(from)} – ${emailCalendarDay(to)}`;
  const rows: Array<{ label: string; value: string }> = [];

  const datesChanged =
    params.oldCheckIn.getTime() !== params.newCheckIn.getTime() ||
    params.oldCheckOut.getTime() !== params.newCheckOut.getTime();
  if (datesChanged) {
    rows.push({
      label: "Previous Dates",
      value: dateRange(params.oldCheckIn, params.oldCheckOut),
    });
    rows.push({
      label: "New Dates",
      value: dateRange(params.newCheckIn, params.newCheckOut),
    });
  } else {
    rows.push({
      label: "Dates",
      value: dateRange(params.newCheckIn, params.newCheckOut),
    });
  }

  if (params.oldGuestCount !== params.newGuestCount) {
    rows.push({ label: "Previous Guests", value: String(params.oldGuestCount) });
    rows.push({ label: "New Guests", value: String(params.newGuestCount) });
  } else {
    rows.push({ label: "Guests", value: String(params.newGuestCount) });
  }

  if (params.oldFinalPriceCents !== params.newFinalPriceCents) {
    rows.push({
      label: "Previous Total",
      value: formatMoneyCents(params.oldFinalPriceCents),
    });
    rows.push({
      label: "New Total",
      value: formatMoneyCents(params.newFinalPriceCents),
    });
  } else {
    rows.push({
      label: "Total",
      value: formatMoneyCents(params.newFinalPriceCents),
    });
  }

  if (params.changeFeeCents > 0) {
    rows.push({
      label: "Change Fee",
      value: formatMoneyCents(params.changeFeeCents),
    });
  }

  // Last, deliberately: it explains the New Total above it.
  if (params.promoCoverageNote && params.promoCoverageNote.trim().length > 0) {
    rows.push({ label: "Promo coverage", value: params.promoCoverageNote });
  }

  return rows;
}

/**
 * #2267: member-facing wording for a booking modification type, shared by the
 * hand-built HTML email and the flat {{modificationTypeLabel}} token the
 * admin-editable body renders. Before this, the flat body passed the raw enum
 * word through, so an override-using club emailed members "DATE_CHANGE", and
 * even the HTML path had no wording for BATCH_MODIFY (emitted by the admin
 * batch edit in booking-batch-modification-service) and emailed "BATCH_MODIFY".
 *
 * The wording matches the booking history timeline's labels
 * (MODIFICATION_LABELS in booking-history.ts) so a member reading the email and
 * an admin reading the timeline see the same words. Unknown values fall back to
 * the raw string rather than hiding the change.
 */
export function bookingModificationTypeLabel(modificationType: string): string {
  const labels: Record<string, string> = {
    DATE_CHANGE: "Dates Changed",
    GUEST_ADD: "Guests Added",
    GUEST_REMOVE: "Guest Removed",
    EXTEND_STAY: "Stay Extended",
    BATCH_MODIFY: "Booking Modified",
  };
  return labels[modificationType] ?? modificationType;
}
