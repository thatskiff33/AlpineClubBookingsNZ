/**
 * The payment-due note of an unpaid booking confirmation (#2444, #2483, #4019):
 * how much is owing, how the member is asked to pay it, and what the club's
 * credit ledger says about this booking. Its own module because it is one
 * decision in two shapes — `payOnline` (no receivable yet; the member chooses
 * card or internet banking on their booking page) and the legacy pay-on-account
 * shape (a reference to quote, and whether the invoice was emailed) — and
 * `email-message-notes.ts` had no room left for the second shape.
 *
 * Like `email-message-notes.ts`, this module imports nothing: every figure
 * arrives already formatted and escaped for the caller's medium, so money
 * formatting and HTML escaping stay with the caller.
 */

/**
 * #2263 × #2444 × #2483 — the whole confirmed-but-UNPAID paragraph of a booking
 * confirmation, shared by the hand-built HTML confirmation
 * (`bookingConfirmedTemplate`) and the flat `{{paymentDueNote}}` token the
 * admin-editable body renders inside `{{paymentOutcome}}`.
 *
 * It was written out TWICE — once in the template monolith (now
 * `email-templates/booking.ts`) and once in
 * `email/booking.ts` — with only a comment claiming the two copies were
 * byte-identical. #2444 has to add a sentence to it, and adding a sentence to
 * two hand-kept copies is exactly the drift `composeOptionalEmailLine` and
 * `appliedCreditSummaryRows` exist to prevent, so the paragraph moved here.
 *
 * TWO SHAPES, chosen by whether `accountCredit` is supplied.
 *
 * 1. NO APPLICABLE CREDIT (`accountCredit` absent) — the #2444 paragraph,
 *    unchanged to the byte. This is what every member on today's one live
 *    unpaid path receives. The "Total Due" line above is the BOOKING's own
 *    price; the invoice the member actually pays against is a separate document
 *    a club admin can adjust by hand in Xero, so the closing sentence points at
 *    the invoice as the figure to transfer and names the commonest reason the
 *    two would differ. It is CONDITIONAL and states no second figure, because
 *    most invoices match the total exactly, and it does NOT say credit "will be
 *    applied", because on this path nothing applies it: the member whole-lodge
 *    approval in `school-booking-request.ts` mints a brand-new booking and
 *    writes no `MemberCredit` row, so the
 *    `enqueueXeroAppliedCreditAllocationOperation` call it makes always
 *    short-circuits with "No unallocated applied credit; nothing to allocate."
 *    (re-verified in review, 1 Aug 2026 — an earlier draft asserted the
 *    opposite and was corrected before merge; do not reinstate it without
 *    making the allocation real).
 *
 * 2. CREDIT APPLIED TO THIS BOOKING (`accountCredit` supplied, #2483). The
 *    caller supplies it only from `resolveUnpaidCreditNetting`, and its
 *    `outcome` picks one of three further shapes — because the one thing this
 *    paragraph must never do is name a figure the club's own ledger
 *    contradicts:
 *
 *    - `"netted"` (credit smaller than the price) — names the NET figure, shows
 *      the arithmetic in words, and asks for it.
 *    - `"covered"` (credit equals the price exactly) — asks for NOTHING. This
 *      is not a corrupt state: it is the documented steady state of the #1887
 *      reprice clamp, and it is exactly what the club's own amount-owing law
 *      calls "nothing owing" (`prepareManualSettlement` refuses to take a
 *      payment for it). Asking for the price here would be a 100% overpayment
 *      — the single worst outcome this whole change exists to prevent — so the
 *      paragraph states that nothing further is to be transferred.
 *    - `"unreconciled"` (more credit applied than the booking costs) — names NO
 *      figure and issues NO payment instruction at all. Something upstream is
 *      inconsistent, and a refusal that still printed the gross price and told
 *      the member to pay it would be the same overpayment wearing a disclaimer.
 *      The member is asked to wait; the sender logs it for an admin.
 *
 *    Why the closing instruction inverts under `"netted"`. Under (1) the email
 *    defers to the invoice. It cannot do that here: the allocation that reduces
 *    the invoice is processed asynchronously on the Xero outbox, so a member
 *    reading the invoice first may still see the full price — and "transfer
 *    what the invoice shows" would then produce exactly the overpayment this
 *    whole change exists to prevent. So the netted figure stands where the
 *    invoice asks for MORE.
 *
 *    It is deliberately NOT symmetric (#2483 review, 2 Aug 2026). An invoice
 *    asking for LESS than the netted figure is the drift direction a hand edit
 *    in Xero produces, and telling the member to transfer the email's larger
 *    figure anyway would recreate the very overpayment #2444 was raised to
 *    stop. So the rule is "pay the smaller of the two, and tell the club":
 *    underpaying is recoverable by an admin, overpaying is not, and either way
 *    the disagreement is routed to the club rather than acted on silently.
 *    Admins are not left to notice it by hand: a separate reconciliation
 *    checker (#2501) compares the club's credits against Xero's and warns them
 *    on drift. The sentence promises only that the club will check — never that
 *    Xero has already been updated, which this module cannot know.
 *
 * `amount`, `reference` and the `accountCredit` figures arrive ALREADY
 * FORMATTED and already escaped for the caller's medium — this module imports
 * nothing (see the file docblock), so money formatting stays with the caller,
 * and the HTML path escapes the club-entered reference at its own edge exactly
 * as it did before. `amount` and `reference` are UNUSED under `"covered"` and
 * `"unreconciled"`: neither shape may ask for money, so neither may quote a
 * figure or a payment reference.
 */
export type BookingPaymentDueCredit =
  | {
      /** Credit smaller than the price: the member owes the difference. */
      outcome: "netted";
      /** The booking's full price, formatted — "$300.00". */
      bookingTotal: string;
      /** Credit applied to it, formatted and UNSIGNED — "$120.00". */
      creditApplied: string;
    }
  | {
      /** Credit equals the price exactly: nothing further is owed. */
      outcome: "covered";
      bookingTotal: string;
      creditApplied: string;
    }
  | {
      /**
       * More credit applied than the booking costs. No figure may be stated
       * and no payment may be asked for.
       */
      outcome: "unreconciled";
    };

/**
 * HOW an unpaid confirmation asks to be paid (#4019).
 *
 * `payOnline`: no receivable exists yet — the member chooses on their booking
 * page between a card payment and a switch to internet banking (the member
 * whole-lodge approval with the Internet Banking and Xero modules on). The
 * note names no reference and no invoice, because neither exists until the
 * member chooses.
 *
 * Otherwise the legacy pay-on-account shape: an internet-banking reference the
 * member must quote, and whether the invoice really was emailed.
 */
export type BookingPaymentDueInstruction =
  | { payOnline: true }
  | {
      payOnline?: false;
      /** Internet-banking reference the member must quote, already escaped. */
      reference: string;
      /** TRUE only when an invoice really was raised (the Xero module is on). */
      invoiceEmailed: boolean;
    };

export function bookingPaymentDueNote(
  input: {
    /**
     * What the member must TRANSFER, already formatted as money — "$300.00".
     * Already net of `accountCredit.creditApplied` when that is supplied.
     */
    amount: string;
    /**
     * #2483 — present ONLY when the club's own credit ledger says credit is
     * applied to this booking. Absent renders the #2444 paragraph unchanged.
     */
    accountCredit?: BookingPaymentDueCredit;
  } & BookingPaymentDueInstruction,
): string {
  const { amount, accountCredit } = input;

  if (input.payOnline === true) {
    const howToPay =
      " Please pay it from your booking page, where you can pay by card or choose to pay by internet banking.";
    if (!accountCredit) {
      return (
        `This booking is confirmed, but payment of ${amount} is still owing.` +
        howToPay
      );
    }
    if (accountCredit.outcome === "unreconciled") {
      return "This booking is confirmed. The club is checking its record of the account credit held against this booking and will confirm what, if anything, is left to pay. Please wait to hear from the club before paying anything.";
    }
    if (accountCredit.outcome === "covered") {
      return `This booking is confirmed and there is nothing further to pay — the booking's price of ${accountCredit.bookingTotal} is fully covered by the ${accountCredit.creditApplied} of account credit the club has put towards it.`;
    }
    return (
      `This booking is confirmed, but payment of ${amount} is still owing — the booking's price of ${accountCredit.bookingTotal} less the ${accountCredit.creditApplied} of account credit the club has put towards it.` +
      howToPay
    );
  }

  const { reference, invoiceEmailed } = input;
  const invoiceSentence = invoiceEmailed
    ? " An invoice has been emailed to you separately."
    : " The club will send you an invoice for it.";

  if (!accountCredit) {
    return (
      `This booking is confirmed, but payment of ${amount} is still owing. Please pay by internet banking quoting reference ${reference}.` +
      invoiceSentence +
      " If the invoice asks for a different amount — for example because the club has put account credit you hold towards it — please transfer the amount the invoice shows."
    );
  }

  if (accountCredit.outcome === "unreconciled") {
    return (
      "This booking is confirmed. The club is checking its record of the account credit held against this booking and will confirm what, if anything, is left to pay." +
      (invoiceEmailed
        ? " An invoice has been emailed to you separately — please wait to hear from the club before transferring anything against it."
        : " Please wait to hear from the club before transferring anything.")
    );
  }

  if (accountCredit.outcome === "covered") {
    return (
      `This booking is confirmed and there is nothing further to transfer — the booking's price of ${accountCredit.bookingTotal} is fully covered by the ${accountCredit.creditApplied} of account credit the club has put towards it.` +
      (invoiceEmailed
        ? " An invoice has been emailed to you separately."
        : " The club will send you an invoice for the booking.") +
      " If the invoice asks for a payment, please let the club know rather than paying it, and the club will check its own record of your credit against the invoice."
    );
  }

  return (
    `This booking is confirmed, but payment of ${amount} is still owing — the booking's price of ${accountCredit.bookingTotal} less the ${accountCredit.creditApplied} of account credit the club has put towards it. Please pay ${amount} by internet banking quoting reference ${reference}.` +
    invoiceSentence +
    ` If the invoice asks for more than that, please still transfer ${amount}; if it asks for less, please pay what the invoice asks. Either way, let the club know, and the club will check its own record of your credit against the invoice.`
  );
}
