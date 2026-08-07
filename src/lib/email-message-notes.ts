/**
 * #2268 - composers for the OPTIONAL and outcome-dependent lines of the
 * admin-editable plain-text email bodies.
 *
 * The editable bodies are rendered by a flat regex substitution
 * (`renderTemplateString`) with no conditional syntax whatsoever, so a body
 * that writes `Admin note: {{adminNote}}` prints a dangling `Admin note:` on
 * every send where the value is absent, and a body that states one branch of an
 * either/or states it even when the other branch is true. Authors used to paper
 * over both with `[only when ...]` guidance, which simply printed itself into
 * member inboxes.
 *
 * These helpers are the single source of truth for that copy: the hand-built
 * HTML templates and the flat `{{...Note}}` tokens the senders supply are built
 * from the same function, so the two paths cannot drift apart.
 *
 * This module deliberately imports nothing - the email template layer, the
 * senders and the template registry all depend on it.
 */

/**
 * #2268 — compose an OPTIONAL line of an admin-editable plain-text email body.
 *
 * The editable bodies are rendered by a flat regex substitution
 * (`renderTemplateString`) with no conditional syntax whatsoever, so a body that
 * writes `Admin note: {{adminNote}}` prints a dangling `Admin note:` on every
 * send where the value is absent. Authors used to paper over that with
 * `[only when adminNote exists]` guidance, which simply printed itself.
 *
 * The fix is the `{{provisionalGuestsNote}}` / `{{promoSummary}}` pattern: the
 * SENDER composes the whole line (or nothing at all) and the default body
 * carries only the token. The composed value brings its own trailing blank
 * line, so a default body writes `{{adminNoteLine}}Next paragraph` and renders
 * a clean paragraph when there is a value and nothing whatsoever when there is
 * not.
 *
 * `label` may be null for a value that is already a full sentence.
 * Values are unescaped plain text; HTML paths escape at their own edge.
 */
export function composeOptionalEmailLine(
  label: string | null,
  value: string | null | undefined,
  options?: { trailing?: string },
): string {
  const text = (value ?? "").trim();
  if (!text) return "";
  return `${label ? `${label}: ${text}` : text}${options?.trailing ?? "\n\n"}`;
}

/**
 * #2268 — one line of a chore list for a flat email body: `Name: description`,
 * or just `Name` when the chore carries no description, so the line can never
 * trail off after a colon. Each line brings its own newline.
 */
export function composeChoreLine(
  name: string,
  description?: string | null,
): string {
  const text = (description ?? "").trim();
  return text ? `${name}: ${text}\n` : `${name}\n`;
}

/**
 * #2268 — the one paragraph of the duplicate-capture alert that changes with
 * the outcome, shared by the hand-built HTML below and the `{{refundOutcomeNote}}`
 * token the admin-editable body renders. The flat body used to state the
 * success wording unconditionally and park the failure wording in an
 * `[only when …]` annotation, so an admin who saved that default was told a
 * duplicate charge had been refunded even when the refund had failed.
 */
export function duplicateCaptureRefundOutcomeParagraph(
  refundFailed: boolean,
): string {
  return refundFailed
    ? "A second, distinct card capture arrived on a booking that was already paid and settled by another capture. The system tried to refund the duplicate charge automatically, but the refund could not complete inline. A durable recovery operation is queued and the payment recovery cron will retry it with backoff — watch the recovery queue and confirm the refund lands. The booking's own settlement is untouched."
    : "A second, distinct card capture arrived on a booking that was already paid and settled by another capture. The duplicate charge was automatically refunded in full, so the member has not been double-charged and no action is needed unless the member reports otherwise. The booking's own settlement is untouched.";
}

/**
 * #2268 — the outcome-dependent lead paragraph of the recurring split-settlement
 * alert, shared by the hand-built HTML below and the `{{settlementActionNote}}`
 * token the admin-editable body renders. The flat body used to assert that a
 * payment link had been emailed and park the "no link sent, chase the whole
 * booking" case in an `[only when …]` annotation.
 */
export function adminSplitSettlementUnpaidLeadParagraph(
  parentUnpaid: boolean,
): string {
  return parentUnpaid
    ? "A split booking reached its hold deadline for the non-member guest portion, but there is no saved card to charge and the member's own linked booking has not been paid either. No payment link has been sent — the guest portion should not be paid ahead of the member's own place. The hold has been extended; follow up with the member about paying for the whole booking."
    : "A split booking reached its hold deadline for the non-member guest portion, but there is no saved card to charge — the member paid their own place by internet banking. A secure payment link has been emailed to the member so they can pay for their guests, and the hold has been extended.";
}

/**
 * #2268 — the outcome-dependent lead paragraph of the terminal split-settlement
 * cancellation alert, shared by the hand-built HTML below and the
 * `{{settlementActionNote}}` token the admin-editable body renders. The flat
 * body used to assert the member's own booking was settled and unaffected, and
 * park the "not settled either — review the whole booking" case in an
 * `[only when …]` annotation.
 */
export function adminSplitSettlementCancelledLeadParagraph(
  parentUnpaid: boolean,
): string {
  return parentUnpaid
    ? "A split booking's non-member guest portion was still unpaid at the end of its check-in day, with no saved card to charge, and the member's own linked booking is not settled either (it may be unpaid or already cancelled). The provisional guest booking has now been automatically cancelled. No payment was taken and no beds were held. The member has been notified. Review the whole booking to confirm the state of the member's own place."
    : "A split booking's non-member guest portion was still unpaid at the end of its check-in day, with no saved card to charge (the member had paid their own place by internet banking). The provisional guest booking has now been automatically cancelled. No payment was taken and no beds were held. The member has been notified; the member's own linked booking is settled and is unaffected.";
}

/**
 * #2263 × #2444 × #2483 — the whole confirmed-but-UNPAID paragraph of a booking
 * confirmation, shared by the hand-built HTML confirmation
 * (`bookingConfirmedTemplate`) and the flat `{{paymentDueNote}}` token the
 * admin-editable body renders inside `{{paymentOutcome}}`.
 *
 * It was written out TWICE — once in `email-templates.ts` and once in
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

export function bookingPaymentDueNote({
  amount,
  reference,
  invoiceEmailed,
  accountCredit,
}: {
  /**
   * What the member must TRANSFER, already formatted as money — "$300.00".
   * Already net of `accountCredit.creditApplied` when that is supplied.
   */
  amount: string;
  /** Internet-banking reference the member must quote, already escaped. */
  reference: string;
  /** TRUE only when an invoice really was raised (the Xero module is on). */
  invoiceEmailed: boolean;
  /**
   * #2483 — present ONLY when the club's own credit ledger says credit is
   * applied to this booking. Absent renders the #2444 paragraph unchanged.
   */
  accountCredit?: BookingPaymentDueCredit;
}): string {
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

/**
 * #2268 — the one member-facing sentence about their OWN booking, shared by the
 * hand-built HTML below and the `{{ownBookingNote}}` token the admin-editable
 * body renders. The flat body used to promise "your own booking is unaffected
 * and remains confirmed" unconditionally, with the truthful alternative parked
 * in an `[only when …]` annotation — so an admin who saved that default told
 * members with an unsettled booking something false.
 */
export function splitGuestPortionOwnBookingLine(
  parentConfirmed: boolean,
): string {
  return parentConfirmed
    ? "This only affects your guests' provisional place — your own booking is unaffected and remains confirmed."
    : "This only affects your guests' provisional place — your own linked booking has not been changed by this cancellation.";
}

/**
 * #2621 (epic #2629, owner decision D-M5) — the checkout-day chore sentence of
 * the pre-arrival reminder, shared by the hand-built HTML
 * (`preArrivalReminderTemplate`) and the `{{checkoutChoreNote}}` token the
 * admin-editable body renders.
 *
 * WHY IT IS COMPOSED RATHER THAN WRITTEN INTO THE DEFAULT BODY. **The chores
 * module defaults OFF** (`ClubModuleSettings.chores` is `@default(false)`), and
 * plenty of clubs never turn it on. An unconditional sentence in the shipped
 * default therefore told every member of every one of those clubs that they are
 * on a chore roster that does not exist, and instructed them to talk to a hut
 * leader about it — on the last message most members read before they travel.
 * This is the `{{choreListNote}}` shape from the sibling `checkin-reminder`
 * template in the same file: the sender composes the whole sentence or nothing at
 * all, and the flat body carries only the token, because
 * `renderTemplateString` has no conditional syntax to express "only when the club
 * runs a chore roster".
 *
 * Empty is the ORDINARY case, not the exceptional one, so the token is declared
 * in `OPTIONAL_TEMPLATE_TOKENS["pre-arrival-reminder"]` — it is in the shipped
 * default body, which is what makes that the correct table rather than
 * `EMPTYABLE_OVERRIDE_TOKENS` — and guard 4 proves the default body renders
 * cleanly without it. The token sits on a line of its own between blank lines, so
 * `plainTextEmailTemplate` drops the whole block when it is empty and leaves no
 * blank-line artefact; the value therefore carries no trailing newlines of its
 * own (the `{{outstandingAdditionalNote}}` convention in the same body).
 *
 * The wording is the owner's, verbatim, and may not be paraphrased here: it is
 * D-M5's replacement for the retired expected-arrival-time entry, and it is what
 * tells a member who wants to leave early that the conversation happens with the
 * hut leader rather than through a form.
 */
export function checkoutDayChoreNote(choresModuleEnabled: boolean): string {
  if (!choresModuleEnabled) return "";
  return "You are on the chore roster on the morning you check out, so please talk to the hut leader beforehand if you plan to leave early.";
}

/**
 * #2550 — the one escalating sentence of the whole-lodge guest-name reminder,
 * shared by the hand-built HTML (`wholeLodgeGuestNamesReminderTemplate`) and the
 * `{{namingUrgencyNote}}` token the admin-editable body renders.
 *
 * Composed rather than written into the flat default because the urgency is the
 * only thing that changes between the first nudge and the last one, and because
 * this is precisely the shape that used to ship as an `[only when …]`
 * annotation. It is NEVER empty — every stage has a sentence — so it needs no
 * `OPTIONAL_TEMPLATE_TOKENS` declaration.
 *
 * Every variant is careful to stay a request, not a threat: #2550's owner
 * decision is that an unnamed party is chased by visibility only, and the stay,
 * check-in and roster are never withheld. No wording here may imply otherwise.
 */
export function wholeLodgeGuestNamesUrgencyNote(
  stage: "first" | "reminder" | "final",
): string {
  if (stage === "final") {
    return "Your stay is about to start and the lodge roster is printed from these names, so please add them now if you can. If you cannot, come anyway and tell the lodge on arrival — your booking and your beds are confirmed either way, and nobody will be turned away over a name.";
  }
  if (stage === "reminder") {
    // Deliberately says nothing about a previous email. The cadence stamp is
    // claimed BEFORE the send and kept when the send fails (see
    // `placeholder-guest-name-reminders.ts`), so the stage a member reaches is
    // proof of a reminder ATTEMPT, never of a delivery — a first email lost to
    // a bounce or an SES outage would otherwise open by reminding them of a
    // message they never received.
    return "This is a nudge rather than anything to worry about. Adding the names now means the chore list and roster name real people instead of Guest 1 and Guest 2.";
  }
  return "Adding the names now means the chore list and the arrival roster at the lodge name real people instead of Guest 1 and Guest 2. It takes a minute and you can change them again later.";
}

/** A labelled link in an email: the button caption and the site-relative path. */
export interface EmailLinkAction {
  label: string;
  path: string;
}

/**
 * #2430 — where a BUMPED booking's owner is invited to go next.
 *
 * The bumped notice used to end in "Book Again: {BASE_URL}/book" for everyone,
 * but `/book` is the MEMBER booking flow behind the login. Two of the three
 * recipient classes that reach `sendBookingBumpedEmail` cannot use it:
 *
 *   - a club MEMBER whose pending booking (their own non-member guests, or a
 *     split guest child) lost its beds — `/book` is exactly right;
 *   - the non-login NON_MEMBER/SCHOOL contact who owns a booking converted from
 *     a public booking request (#707), and any other non-login contact an admin
 *     booked on behalf of — these have `canLogin = false` by construction
 *     (`assertMappableOwnerContact` refuses a login-capable owner outright), so
 *     `/book` bounces them to a login they can never complete.
 *
 * There is no tokenised respond link to offer them either: the bump path
 * revokes the booking's payment links, and the request itself is CONVERTED, so
 * the club's contact page is the only live way back in.
 *
 * Whichever way it goes, the notice also names the club's support address (the
 * `{{SUPPORT_EMAIL}}` line both the HTML template and the default body carry),
 * because a club-authored Contact page need not host a contact form — without
 * that line a recipient who cannot sign in could be left with no way to reply
 * at all. Both branches carry it, so the two readers get the same courtesy.
 *
 * Shared by the hand-built HTML template and the `{{rebookLabel}}` /
 * `{{rebookPath}}` tokens the admin-editable body renders, so the two paths
 * cannot drift. The caller owns the base URL — this module deliberately
 * imports nothing.
 */
export function bookingBumpedRebookAction(
  recipientCanBookOnline: boolean,
): EmailLinkAction {
  return recipientCanBookOnline
    ? { label: "Book Again", path: "/book" }
    : { label: "Contact the Club", path: "/contact" };
}
