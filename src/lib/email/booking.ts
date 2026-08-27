import { loadBookingAppliedCredit } from "@/lib/booking-confirmation-credit";
import { resolveBookingEmailLink } from "@/lib/booking-email-authority";
import {
  type BookingCalendarLinks,
  bookingAddToCalendarBlock,
  bookingAddToCalendarHtmlRow,
  bookingCalendarLinks,
} from "@/lib/calendar-links";
import logger from "@/lib/logger";
import {
  bookingBumpedTemplate, bookingCancelledTemplate, bookingConfirmedTemplate,
  bookingGuestsCancelledTemplate, bookingModifiedTemplate, bookingPendingTemplate,
  setupIntentFailedTemplate,
  splitGuestPortionCancelledTemplate,
} from "@/lib/email-templates/booking";
import {
  bookingPolicyExceptionApprovedTemplate, bookingPolicyExceptionRefusedTemplate,
  bookingReviewApprovedTemplate, bookingReviewRejectedTemplate,
  hostingCoverageLostTemplate,
  policyExceptionRequestExpiredTemplate,
} from "@/lib/email-templates/booking-exceptions";
import {
  type AppliedCreditSummary,
  appliedCreditSummaryRows,
  bookingModificationSummaryRows,
  bookingModificationTypeLabel,
  promoAdjustmentSummaryRows,
  resolvePromoAdjustmentCents,
  resolveUnpaidCreditNetting,
  settledByPaymentCents,
  unpaidCreditNoteInput,
  unpaidMoneySummaryRows,
} from "@/lib/booking-money-lines";
import {
  additionalPaymentReminderTemplate,
  checkinReminderTemplate,
  preArrivalReminderTemplate,
  wholeLodgeGuestNamesReminderTemplate,
} from "@/lib/email-templates/booking-reminders";
import {
  bookingBumpedRebookAction,
  bookingPaymentDueNote,
  checkoutDayChoreNote,
  composeChoreLine,
  composeOptionalEmailLine,
  splitGuestPortionOwnBookingLine,
  wholeLodgeGuestNamesUrgencyNote,
} from "../email-message-notes";
import { CLUB_NAME } from "@/config/club-identity";
import { EMAIL_DEFAULT_LODGE_NAME } from "@/lib/email-message-settings";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { loadEmailMessageSettingsForLodge } from "@/lib/email-message-settings";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { sendEmail } from "./core";
import { bookingOwnerEmailContext } from "@/lib/booking-email-contract";
import { renderEmailHtml } from "@/lib/email-theme";
import { emailCalendarDay, emailClubDate, emailClubDateTime } from "@/lib/email-templates-club-time";

/**
 * #2328 (review): what the confirmation renders when the applied-credit read
 * itself fails — no credit pair, i.e. exactly the pre-#2328 message. The
 * settlement method is inert at zero credit (no rows are built at all), so it
 * carries no claim about how anyone paid.
 */
const NO_APPLIED_CREDIT: AppliedCreditSummary = {
  amountCents: 0,
  settlementMethod: "card",
};

export async function sendBookingConfirmedEmail(
  // Booking this message belongs to (#2258). Required, and an object rather
  // than a bare string so it can never be transposed with one of the sibling
  // string arguments. Every message in this file is unambiguously
  // booking-scoped, so `"none"` is not offered here: the per-booking "No
  // emails" switch must be able to withhold all of them.
  bookingContext: { bookingId: string; recipientMemberId: string },
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  totalCents: number,
  options?: {
    discountCents?: number;
    promoAdjustmentCents?: number;
    promoCode?: string;
    // Booking's lodge (multi-lodge phase 8): the email carries this lodge's
    // name, travel note, and door code. Omitted/null resolves the club's
    // default lodge — including its real door code, so always thread the
    // booking's own lodgeId.
    lodgeId?: string | null;
    // Split-booking parent (#738): describes the provisional non-member child
    // whose places are charged separately around the hold deadline. Present
    // only when this confirmation is a split parent (see
    // getProvisionalNonMemberChildSummary). Read-only email content — it never
    // changes the hold/settlement decision.
    provisionalGuests?: {
      guestCount: number;
      holdUntil: Date;
    };
    // #2263: the booking is CONFIRMED but the money is NOT in — the member
    // whole-lodge approval books a PENDING Internet Banking receivable. Pass
    // this and the message states the amount OWING plus the internet-banking
    // reference instead of claiming payment was processed. `invoiceEmailed`
    // must be TRUE only when an invoice really was raised (Xero module on);
    // otherwise the copy promises the club will send one by hand.
    paymentDue?: {
      reference: string;
      invoiceEmailed: boolean;
    };
    // #2397: the booking IS settled, but for less than it is worth — an admin
    // recorded a cash / off-Xero payment and said it did not cover an
    // uncollected price increase, so the club will still ask for the rest.
    // Passing this is what stops the confirmation telling the member they paid
    // in full while the admin's own receipt says the opposite. See
    // `bookingConfirmedTemplate` for the field meanings; `paymentDue` (nothing
    // paid at all) wins if both are supplied.
    outstandingBalance?: {
      amountCents: number;
      payableOnline: boolean;
    };
  },
) {
  // #2328: account credit spent on this booking, read from the booking's own
  // persisted ledger rows (and its Payment row, for how the rest was settled)
  // rather than threaded in by the caller — see
  // `loadBookingAppliedCredit` for why the sender owns this read. Every send
  // site calls this function after its settlement transaction has committed,
  // so what is read here is the settled truth for THIS booking at THIS moment.
  //
  // Run ALONGSIDE the settings load (#2328 review): the two reads share no
  // input and no ordering, and `loadEmailMessageSettingsForLodge` says in its
  // own docblock not to serialise per-send lookups behind one another.
  //
  // FAILS OPEN, deliberately (#2328 review). A thrown read here would abort the
  // send BEFORE `sendEmail`, so there would be no EmailLog row and no
  // fail-closed admin alert — the "member is silently owed an email" state that
  // machinery exists to prevent, caused by a decoration on the message rather
  // than by anything wrong with the message itself. So a failure degrades to
  // pre-#2328 rendering (no credit pair) and the send, its logging and its
  // alerting all still happen. The settings load beside it keeps its existing
  // throw-on-failure behaviour; that pre-existing hole is not #2328's to widen
  // or to close.
  const [settings, appliedCredit, calendarLinkDecision] = await Promise.all([
    loadEmailMessageSettingsForLodge(options?.lodgeId),
    loadBookingAppliedCredit(
      bookingContext.bookingId,
      undefined,
      // Lets the loader flag a price that moved between this caller's snapshot
      // and its own read; it never changes which figure renders.
      totalCents,
    ).catch((err) => {
      logger.error(
        { err, bookingId: bookingContext.bookingId },
        "Failed to read applied account credit for a booking confirmation; sending without the credit lines (#2328)",
      );
      return NO_APPLIED_CREDIT;
    }),
    // Fork issue #35 (review F1): the {{ical}} block embeds the booking id in
    // a sessionless bearer URL, so it is governed by the SAME privacy decision
    // as {{bookingUrl}} — resolveBookingEmailLink, "the privacy gate that
    // decides whether the booking id may be placed in outbound mail". The
    // outbound HTML sanitiser only recognises /bookings paths, so an
    // unauthorized send must never contain the calendar links in the first
    // place. sendEmail resolves the same decision again for the button; the
    // two reads cannot disagree in a way that leaks (a race can only differ
    // toward the later, more current state, and each read gates its own
    // artifact). FAILS CLOSED on error — a resolver failure means no calendar
    // links, never links to an unverified recipient — while the send itself
    // still goes out.
    resolveBookingEmailLink({
      bookingId: bookingContext.bookingId,
      templateName: "booking-confirmed",
      recipient: { kind: "member", memberId: bookingContext.recipientMemberId },
      deliveryAddress: email,
    }).catch((err) => {
      logger.error(
        { err, bookingId: bookingContext.bookingId },
        "Failed to resolve booking-link authority for calendar links; sending without them (fork #35)",
      );
      return null;
    }),
  ]);
  // #2267: derived by the same shared helper the HTML template uses, so the
  // two paths can never disagree about what the promo did to the price.
  const promoAdjustmentCents = resolvePromoAdjustmentCents(options);
  const promoAdjustmentPrefix = promoAdjustmentCents > 0 ? "+" : "-";
  // #2267: pre-composed {{promoSummary}} block for the admin-editable body —
  // the provisionalGuestsNote precedent, built from the same rows as the HTML
  // template so both paths always tell the same money story. Each row becomes
  // a "Label: value" line WITH its own trailing newline, so the default body
  // can write "{{promoSummary}}Total Paid: {{totalPaid}}" and render a clean
  // contiguous block for a promo and no leftover blank line without one. The
  // adjustment value carries its own sign (-$12.00 discount, +$1,370.00 for a
  // price-raising FIXED_NIGHTLY/SET_PRICE promo), so the body must never
  // prefix a minus of its own.
  const promoSummary = promoAdjustmentSummaryRows(
    totalCents,
    promoAdjustmentCents,
    options?.promoCode,
  )
    .map((row) => `${row.label}: ${row.value}\n`)
    .join("");
  // #2267: pre-composed {{doorCodeNote}} line, mirroring what the HTML
  // arrival-instructions section does — the whole "Door code: 1234" line, or
  // nothing at all for a lodge with no code recorded. The default body used to
  // hardcode the "Door code: " label around the bare {{doorCode}} value, which
  // left a dangling "Door code:" line in every confirmation a club without a
  // door code sent.
  // #2268: built by the one shared composer, so this line and the identical
  // one on the pre-arrival reminder cannot drift. `trailing: ""` keeps the
  // #2267 shape — a bare line that the body surrounds with its own blank
  // lines — rather than a block that carries its own.
  const doorCodeNote = composeOptionalEmailLine(
    "Door code",
    settings.doorCode,
    { trailing: "" },
  );
  const provisionalGuests = options?.provisionalGuests;
  // Composed sentence for the {{provisionalGuestsNote}} token — the same story
  // the FILE template renders, so an operator override keeps parity. Empty when
  // this is not a split parent so the token renders nothing.
  const provisionalGuestsNote =
    provisionalGuests && provisionalGuests.guestCount > 0
      ? `Your ${provisionalGuests.guestCount} non-member guest${
          provisionalGuests.guestCount === 1 ? "" : "s"
        } ${
          provisionalGuests.guestCount === 1 ? "is" : "are"
        } held provisionally as a linked booking — no bed is reserved for them yet, and the payment above covers only your member places. If beds remain around ${emailClubDateTime(
          provisionalGuests.holdUntil,
        )}, we'll automatically take that guest portion from your saved payment method and your guests are confirmed. If we can't take payment, we'll contact you to arrange it. If the lodge fills with member bookings first, that portion is not charged and those guests are bumped.`
      : "";
  const paymentDue = options?.paymentDue;
  // #2263 × #2267: the whole money outcome as ONE pre-composed block for the
  // default body ({{promoSummary}}'s convention — complete lines or nothing),
  // because the paid and unpaid stories are mutually exclusive and a flat body
  // cannot branch. Paid: the total-paid line plus the processed sentence.
  // Unpaid (a member whole-lodge approval's PENDING internet-banking
  // receivable): the total-due line plus the owing sentence above — never
  // "Payment has been processed successfully" for money that has not moved.
  // The legacy per-piece tokens (totalPaid, totalDue, paymentDueNote,
  // paymentReference) stay supplied for overrides that build their own lines.
  // #2397: the third money outcome — settled, but for LESS than the booking is
  // worth. Same convention again: complete lines, then the composed sentence,
  // byte-identical to what the FILE template renders.
  const outstandingBalance = paymentDue ? undefined : options?.outstandingBalance;
  const outstandingPaidCents = outstandingBalance
    ? totalCents - outstandingBalance.amountCents
    : 0;
  const outstandingBalanceNote = outstandingBalance
    ? `Your payment of ${formatMoneyCents(outstandingPaidCents)} has been recorded and your booking is confirmed. ${formatMoneyCents(outstandingBalance.amountCents)} is still owing from a later change to this booking.` +
      (outstandingBalance.payableOnline
        ? " You can pay it from your booking page."
        : " The club will be in touch to arrange it.")
    : "";
  const appliedCreditCents = Math.max(0, appliedCredit.amountCents);
  const settledCents = settledByPaymentCents({
    totalCents,
    appliedCreditCents,
    unpaid: Boolean(paymentDue),
    outstandingCents: outstandingBalance?.amountCents ?? 0,
  });
  // #2483: on an UNPAID confirmation the credit is not a "where the money came
  // from" story — nothing has been paid — it is a reduction in what the member
  // must transfer. This resolves that netting from the club's OWN ledger figure
  // read above, with no Xero read and no wait on the outbox (owner decision,
  // 2 Aug 2026). The same resolver runs inside `bookingConfirmedTemplate`, from
  // the same two inputs, so the HTML table and the tokens below always agree.
  const unpaidNetting = resolveUnpaidCreditNetting({
    totalCents,
    appliedCreditCents,
  });
  // #2263 × #2444 × #2483: the composed unpaid-confirmation paragraph, from the
  // SHARED composer the FILE template renders, so an operator override keeps
  // parity (the same convention provisionalGuestsNote follows). Empty when the
  // booking is paid. The amount is what the member must TRANSFER — netted when
  // credit applies — and the composer states the arithmetic in words, so a body
  // that renders this token without the money block still tells the whole
  // story. Plain text, so the reference goes in raw; the HTML path escapes it
  // at its own edge.
  const paymentDueNote = paymentDue
    ? bookingPaymentDueNote({
        amount: formatMoneyCents(unpaidNetting.toTransferCents),
        reference: paymentDue.reference,
        invoiceEmailed: paymentDue.invoiceEmailed,
        accountCredit: unpaidCreditNoteInput(
          totalCents,
          unpaidNetting,
          formatMoneyCents,
        ),
      })
    : "";
  // #2328 (review): the states in which credit a booking really spent goes
  // UNSTATED. Both are believed unreachable, and both would be invisible if
  // they were not logged — a silent email looks exactly like a booking that
  // used no credit, which is the very failure #2328 exists to fix. Logged here
  // rather than inside the row builders because this is the one place per send
  // that holds the booking id, and the HTML template is composed from these
  // same figures a few lines below.
  if (paymentDue && appliedCreditCents > 0 && unpaidNetting.creditCents === 0) {
    // #2483 replaced the blanket unpaid-branch suppression this used to warn
    // about: an unpaid confirmation now STATES its netting, including the
    // fully-covered case (`"covered"` — credit exactly equal to the price —
    // which states $0.00 rather than the old refusal's full price). What is
    // left is credit LARGER than the booking's price on a send that says the
    // booking is unpaid, which cannot both be true, plus the degenerate
    // non-positive-price send. The member is asked for no figure at all rather
    // than one derived from contradictory inputs, and an admin gets this.
    logger.warn(
      {
        bookingId: bookingContext.bookingId,
        appliedCreditCents,
        totalCents,
        nettingOutcome: unpaidNetting.outcome,
      },
      "Confirmed-but-unpaid booking confirmation carries applied account credit the netting could not state; the email asks the member for no figure (#2483)",
    );
  } else if (!paymentDue && settledCents < 0) {
    // More credit consumed than the booking is now worth. The #1887 reprice
    // clamp refunds the over-consumed slice on every repriceable path, so this
    // should not be reachable.
    logger.warn(
      {
        bookingId: bookingContext.bookingId,
        appliedCreditCents,
        totalCents,
        outstandingCents: outstandingBalance?.amountCents ?? 0,
        settledCents,
      },
      "Booking confirmation applied more account credit than the booking is worth; the credit lines were suppressed (#2328)",
    );
  }
  // #2328: the pre-composed {{creditNote}} block — the two reconciling lines
  // that say where the money came from when part of it came from the member's
  // account credit, or NOTHING AT ALL when it did not. Built from the SAME
  // shared rows the HTML confirmation's info table uses, so the two paths tell
  // one story about one booking. Each row carries its own trailing newline
  // (the {{promoSummary}} convention), so the block sits hard against the
  // "Total Paid" line above it and leaves no blank line behind when empty —
  // which is what keeps every no-credit confirmation byte-for-byte unchanged.
  // The credit value carries its own minus sign, so a body must never prefix
  // one of its own (the editor rejects that at save time).
  const creditNote = appliedCreditSummaryRows(
    appliedCreditCents,
    settledCents,
    appliedCredit.settlementMethod,
  )
    .map((row) => `${row.label}: ${row.value}\n`)
    .join("");
  // #2483: the unpaid money block, from the SHARED row builder the HTML table
  // uses. One "Total Due" line when no credit applies — byte-for-byte the
  // pre-#2483 block — the reconciling trio when it does, and a bare
  // "Booking Total" when the ledger contradicts the price.
  const unpaidMoneyBlock = unpaidMoneySummaryRows(totalCents, unpaidNetting)
    .map((row) => `${row.label}: ${row.value}\n`)
    .join("");
  const paymentOutcome = paymentDue
    ? `${unpaidMoneyBlock}\n${paymentDueNote}`
    : outstandingBalance
      ? `Booking Total: ${formatMoneyCents(totalCents)}\nPaid: ${formatMoneyCents(outstandingPaidCents)}\n${creditNote}Still Owing: ${formatMoneyCents(outstandingBalance.amountCents)}\n\n${outstandingBalanceNote}`
      : `Total Paid: ${formatMoneyCents(totalCents)}\n${creditNote}\nPayment has been processed successfully.`;
  // Fork issue #35: the add-to-calendar links and their flat {{ical}} block —
  // built ONLY when the recipient's booking-link authority above allows the
  // booking id in outbound mail (review F1: the links carry the id in a
  // bearer URL the outbound sanitiser does not recognise, so gating at
  // composition is the guard). Within that, the build FAILS OPEN exactly like
  // the applied-credit read (#2328's reasoning): the only realistic throw is
  // a missing auth secret in a misconfigured environment, and that must
  // degrade to a confirmation without calendar links, never abort the send.
  // An empty {{ical}} is declared in OPTIONAL_TEMPLATE_TOKENS so the
  // dangling-line guard proves the default body survives its absence.
  let calendarLinks: BookingCalendarLinks | undefined;
  let icalBlock = "";
  let icalHtmlRow = "";
  if (calendarLinkDecision?.bookingUrl) {
    try {
      calendarLinks = bookingCalendarLinks({
        stay: { bookingId: bookingContext.bookingId, checkIn, checkOut },
        lodgeName: settings.lodgeName,
      });
      icalBlock = bookingAddToCalendarBlock(calendarLinks);
      // Fork #43: the icon row an OVERRIDE body's {{ical}} renders, injected
      // by the renderer's sentinel swap so token-value escaping stays intact.
      icalHtmlRow = bookingAddToCalendarHtmlRow(calendarLinks);
    } catch (err) {
      logger.error(
        { err, bookingId: bookingContext.bookingId },
        "Failed to build add-to-calendar links for a booking confirmation; sending without them (fork #35)",
      );
    }
  }
  // #2262: the outcome is RETURNED so a caller that promised the admin a
  // receipt can report honestly what became of it (queued vs withheld vs
  // failed) instead of turning a decision into a delivery claim. Existing
  // callers ignore it and are unaffected.
  return await sendEmail({
    to: email,
    subject: `Booking Confirmed - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: await renderEmailHtml(() => bookingConfirmedTemplate(
      firstName,
      checkIn,
      checkOut,
      guestCount,
      totalCents,
      {
        ...options,
        lodgeTravelNote: settings.lodgeTravelNote,
        doorCode: settings.doorCode,
        provisionalGuests,
        // #2328: the same figures the {{creditNote}} token above is built from,
        // handed to the hand-built HTML so both render the shared rows.
        appliedCredit,
        calendarLinks,
      },
    )),
    bookingContext: bookingOwnerEmailContext(
      bookingContext.bookingId,
      bookingContext.recipientMemberId,
    ),
    templateName: "booking-confirmed",
    templateData: {
      firstName,
      checkIn: emailCalendarDay(checkIn),
      checkOut: emailCalendarDay(checkOut),
      guestCount,
      provisionalGuestsNote,
      promoSummary,
      // Legacy per-piece promo tokens, kept supplied so a saved override that
      // still references them keeps rendering (#2267). New bodies should use
      // {{promoSummary}}: {{discount}} can only express a price cut (it is
      // empty for a price-raising promo), which is exactly the bug that
      // produced a dangling "Discount: -" line on surcharge promos.
      subtotal:
        promoAdjustmentCents !== 0
          ? formatMoneyCents(totalCents - promoAdjustmentCents)
          : "",
      promoCode: options?.promoCode ?? "",
      discount:
        promoAdjustmentCents < 0
          ? formatMoneyCents(Math.abs(promoAdjustmentCents))
          : "",
      promoAdjustment:
        promoAdjustmentCents !== 0
          ? `${promoAdjustmentPrefix}${formatMoneyCents(Math.abs(promoAdjustmentCents))}`
          : "",
      // An unpaid confirmation must not render a "Total Paid" line at all
      // (#2263). #2397 adds the third case: a PARTLY paid confirmation carries
      // BOTH, because both are true — {{totalPaid}} is what the club actually
      // has (cash plus any credit applied) and {{totalDue}} is what is still
      // owed, never the whole price.
      // #2483: {{totalDue}} has always meant "what is still owed", so on an
      // unpaid send it is the NETTED figure — a saved override that writes its
      // own "Total Due: {{totalDue}}" line asks for the transferable amount
      // with no edit, which is the whole point of not inventing a new token.
      // On the `"unreconciled"` outcome it is EMPTY, not the gross price: the
      // whole point of that outcome is that no figure may be asked for, and an
      // override is the one path that could still print one. Empty is the
      // token's existing convention on a branch that has no figure to state
      // (see {{totalPaid}} directly above), and the editor already warns about
      // a label typed in front of an emptyable token.
      totalPaid: paymentDue
        ? ""
        : formatMoneyCents(
            outstandingBalance ? outstandingPaidCents : totalCents,
          ),
      totalDue: paymentDue
        ? unpaidNetting.outcome === "unreconciled"
          ? ""
          : formatMoneyCents(unpaidNetting.toTransferCents)
        : outstandingBalance
          ? formatMoneyCents(outstandingBalance.amountCents)
          : "",
      total: formatMoneyCents(totalCents),
      // #2328: pre-composed and ALREADY INSIDE {{paymentOutcome}} above, which
      // is what the shipped default body renders. It is supplied separately for
      // the same reason {{totalPaid}} is: an override that builds its own money
      // lines out of the per-piece tokens has no other way to explain a card
      // charge that is smaller than the total. A body that uses both renders the
      // pair twice — exactly as one using {{paymentOutcome}} and {{totalPaid}}
      // together renders the total twice.
      creditNote,
      paymentOutcome,
      paymentDueNote,
      paymentReference: paymentDue?.reference ?? "",
      doorCodeNote,
      // Legacy bare value, still supplied so an existing override that writes
      // its own "Door code: {{doorCode}}" line keeps rendering (#2267).
      doorCode: settings.doorCode ?? "",
      // Fork issue #35: pre-composed add-to-calendar block; empty only when
      // link building failed above. #43: the icon-row HTML the renderer
      // swaps in wherever {{ical}} renders — never a token an admin can
      // reference ({{icalHtml}} is not approved, and it is subject-forbidden
      // belt-and-braces).
      ical: icalBlock,
      icalHtml: icalHtmlRow,
    },
    lodgeId: options?.lodgeId,
  });
}

export async function sendBookingPendingEmail(
  // Booking this message belongs to (#2258); see sendBookingConfirmedEmail.
  bookingContext: { bookingId: string; recipientMemberId: string },
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  holdUntil: Date,
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null,
) {
  await sendEmail({
    to: email,
    subject: `Booking Pending - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: await renderEmailHtml(() => bookingPendingTemplate(
      firstName,
      checkIn,
      checkOut,
      guestCount,
      holdUntil,
    )),
    bookingContext: bookingOwnerEmailContext(bookingContext.bookingId, bookingContext.recipientMemberId),
    templateName: "booking-pending",
    templateData: {
      firstName,
      checkIn: emailCalendarDay(checkIn),
      checkOut: emailCalendarDay(checkOut),
      guestCount,
      holdUntil: emailClubDateTime(holdUntil),
    },
    lodgeId,
  });
}

/**
 * Tell a member their booking-policy exception request was approved and the
 * booking now exists (#2526).
 *
 * The gap this closes. An approved NEW-booking exception normally lands on
 * PAYMENT_PENDING, and `createConfirmedBooking` emails only a $0 confirmation or
 * a non-member hold notice — a member booking through the wizard learns what to
 * pay because the wizard redirects them to checkout. An approval happens days
 * later while the member is elsewhere, so without this they were told nothing at
 * all: no booking, no amount, and PAYMENT_PENDING holds no beds, so the stay
 * could be filled or reaped with them none the wiser.
 *
 * Only the NEW-booking flavour uses this. An approved CHANGE to an existing
 * booking is announced by the canonical `booking-modified` email the modification
 * service already sends, so the two never double up.
 */
export async function sendBookingPolicyExceptionApprovedEmail(
  // Booking this message belongs to (#2258); see sendBookingConfirmedEmail.
  bookingContext: { bookingId: string; recipientMemberId: string },
  email: string,
  args: {
    firstName: string;
    checkIn: Date;
    checkOut: Date;
    guestCount: number;
    /** Integer cents still owed on the created booking; 0 owes nothing. */
    amountDueCents: number;
    /** The officer's decision note, when they left one. */
    adminNotes?: string | null;
    // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
    lodgeId?: string | null;
  },
) {
  const amountDue = formatMoneyCents(args.amountDueCents);
  // Composed by the sender, never conditionally in the body: the render path has
  // no conditional syntax, so a token that is sometimes empty must arrive as a
  // whole line or as nothing (see composeOptionalEmailLine).
  const paymentNote =
    args.amountDueCents > 0
      ? `There is ${amountDue} to pay on this booking. Open it from your account to pay now — the beds are not held until it is paid.`
      : "";
  const adminNotesLine = composeOptionalEmailLine(
    "Note from the club",
    args.adminNotes,
    { trailing: "" },
  );

  await sendEmail({
    to: email,
    subject: `Your Request Was Approved - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: await renderEmailHtml(() => bookingPolicyExceptionApprovedTemplate({
      firstName: args.firstName,
      checkIn: args.checkIn,
      checkOut: args.checkOut,
      guestCount: args.guestCount,
      paymentNote,
      adminNotesLine,
    })),
    bookingContext: bookingOwnerEmailContext(
      bookingContext.bookingId,
      bookingContext.recipientMemberId,
    ),
    templateName: "booking-policy-exception-approved",
    templateData: {
      firstName: args.firstName,
      checkIn: emailCalendarDay(args.checkIn),
      checkOut: emailCalendarDay(args.checkOut),
      guestCount: args.guestCount,
      paymentNote,
      adminNotesLine,
      // Raw values behind the two composed lines, so an admin override written
      // against either form keeps rendering.
      amount: amountDue,
      adminNotes: args.adminNotes ?? "",
    },
    lodgeId: args.lodgeId,
  });
}

/**
 * Tell a member their booking-policy exception request was REFUSED (#2562 review).
 *
 * The gap this closes: the refusal branch recorded a mandatory member-facing
 * explanation and then delivered it nowhere. There is no in-app notification
 * centre in this app, so without this the member's only signal was a badge on My
 * Bookings, and their realistic next act was the phone call the workflow exists to
 * remove.
 *
 * `bookingContext` is a UNION on this sender, and both arms are real: a refused
 * MODIFICATION request hangs off a booking, so the per-booking "No emails" switch
 * must be able to withhold this notice like every other message about that
 * booking; a refused NEW-booking request has no booking at all and passes `"none"`.
 * That is also why the template carries no booking button — see its own doc
 * comment.
 *
 * Fire-and-forget at the call site, AFTER the terminal claim has committed: a mail
 * failure must never turn a recorded refusal into an error the officer sees.
 */
export async function sendBookingPolicyExceptionRefusedEmail(params: {
  /**
   * The booking id when one exists, or the explicit `"none"`. Deliberately the
   * narrow shape rather than a full `EmailBookingContext`: the recipient half is
   * always this request's requester, so the sender builds it and no call site can
   * name the wrong person.
   */
  bookingContext: { bookingId: string } | "none";
  email: string;
  recipientMemberId: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  /** The officer's MEMBER-FACING explanation. Never the internal note. */
  adminNotes: string | null;
  /** Which flavour was refused, so the opening sentence says what it was. */
  source: "NEW_BOOKING" | "MODIFICATION";
  // Booking's/lodge's identity (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null;
}) {
  const settings = await loadEmailMessageSettingsForLodge(params.lodgeId);
  // Composed by the sender, never conditionally in the body: the render path has
  // no conditional syntax, so a token that can be empty must arrive as a whole
  // line or as nothing (see composeOptionalEmailLine). In practice a refusal
  // always carries one — the decision route refuses without it.
  const reasonLine = composeOptionalEmailLine(
    "Why the Booking Officer said no",
    params.adminNotes,
    { trailing: "" },
  );
  const askDescription =
    params.source === "NEW_BOOKING"
      ? "your request to be let past a booking rule for a new stay"
      : "your request to be let past a booking rule for a change to your booking";

  return sendEmail({
    to: params.email,
    subject: `Your request was not approved - ${settings.lodgeName}`,
    html: await renderEmailHtml(() => bookingPolicyExceptionRefusedTemplate({
      firstName: params.firstName,
      lodgeName: settings.lodgeName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      reasonLine,
      askDescription,
    })),
    bookingContext:
      params.bookingContext === "none"
        ? "none"
        : bookingOwnerEmailContext(
            params.bookingContext.bookingId,
            params.recipientMemberId,
          ),
    templateName: "booking-policy-exception-refused",
    templateData: {
      firstName: params.firstName,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
      askDescription,
      reasonLine,
      // The raw value behind the composed line, so an override written against
      // either form keeps rendering.
      adminNotes: params.adminNotes ?? "",
    },
    lodgeId: params.lodgeId,
  });
}

export async function sendBookingBumpedEmail(
  // Booking this message belongs to (#2258); see sendBookingConfirmedEmail.
  bookingContext: { bookingId: string; recipientMemberId: string },
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  // Required (pass `null` when unknown) so the recipient argument after it can
  // be required too — TypeScript allows no required parameter behind an
  // optional one, and that argument must not be omittable (below).
  lodgeId: string | null,
  // #2430: whether the owner of the bumped booking can sign in and rebook.
  // Pass the owner's `Member.canLogin`: a booking converted from a public
  // booking request (#707), or any booking an admin made for a non-login
  // NON_MEMBER/SCHOOL contact, is owned by a member that cannot authenticate,
  // so `/book` would send them to a login they can never complete. REQUIRED,
  // with no default: `true` is the leaky value, so a defaulted argument would
  // let a future send site mail a login-less contact a members-only link
  // without anyone noticing (#2430 review).
  recipientCanBookOnline: boolean,
) {
  const rebook = bookingBumpedRebookAction(recipientCanBookOnline);
  await sendEmail({
    to: email,
    subject: `Booking Update - ${EMAIL_DEFAULT_LODGE_NAME}`,
    // Both halves of the #2430 / #2473 overlap are load-bearing and compose:
    // the template argument is #2430's recipient split (a recipient who cannot
    // sign in must never be sent the members-only booking link), and the
    // context is #2473's recipient-authority resolution. Neither replaces the
    // other, and in particular this must not route a non-login recipient to an
    // authenticated booking-detail link — see the coordination thread on #2466.
    html: await renderEmailHtml(() => bookingBumpedTemplate(
      firstName,
      checkIn,
      checkOut,
      guestCount,
      recipientCanBookOnline,
    )),
    bookingContext: bookingOwnerEmailContext(
      bookingContext.bookingId,
      bookingContext.recipientMemberId,
    ),
    templateName: "booking-bumped",
    templateData: {
      firstName,
      checkIn: emailCalendarDay(checkIn),
      checkOut: emailCalendarDay(checkOut),
      guestCount,
      // The caption and the path only — the body keeps {{BASE_URL}} in front of
      // the path so the club's own configured public URL still resolves it.
      rebookLabel: rebook.label,
      rebookPath: rebook.path,
    },
    lodgeId,
  });
}

export async function sendBookingGuestsCancelledEmail(
  // Booking this message belongs to (#2258); see sendBookingConfirmedEmail.
  bookingContext: { bookingId: string; recipientMemberId: string },
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null,
) {
  await sendEmail({
    to: email,
    subject: `Booking Cancelled - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: await renderEmailHtml(() => bookingGuestsCancelledTemplate(firstName, checkIn, checkOut)),
    bookingContext: bookingOwnerEmailContext(bookingContext.bookingId, bookingContext.recipientMemberId),
    templateName: "booking-guests-cancelled",
    templateData: {
      firstName,
      checkIn: emailCalendarDay(checkIn),
      checkOut: emailCalendarDay(checkOut),
    },
    lodgeId,
  });
}

export async function sendBookingCancelledEmail(
  // Booking this message belongs to (#2258); see sendBookingConfirmedEmail.
  bookingContext: { bookingId: string; recipientMemberId: string },
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  refundCents: number,
  // B5 (#2262): "manual" — a cash / off-Xero settlement handed back by a person.
  refundMethod: "card" | "credit" | "manual" = "card",
  creditRestoredCents: number = 0,
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null,
) {
  await sendEmail({
    to: email,
    subject: `Booking Cancelled - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: await renderEmailHtml(() => bookingCancelledTemplate(
      firstName,
      checkIn,
      checkOut,
      refundCents,
      refundMethod,
      creditRestoredCents,
    )),
    bookingContext: bookingOwnerEmailContext(bookingContext.bookingId, bookingContext.recipientMemberId),
    templateName: "booking-cancelled",
    templateData: {
      firstName,
      checkIn: emailCalendarDay(checkIn),
      checkOut: emailCalendarDay(checkOut),
      refundAmount: formatMoneyCents(refundCents),
      refundMessage:
        refundCents > 0 && refundMethod === "manual"
          ? `You paid for this booking in cash or by bank transfer, so there is no card payment to reverse. The club will arrange your refund of ${formatMoneyCents(refundCents)} directly and will be in touch.`
          : refundCents > 0 && refundMethod === "credit"
            ? `A credit of ${formatMoneyCents(refundCents)} has been added to your account for future bookings.`
            : refundCents > 0
              ? `A refund of ${formatMoneyCents(refundCents)} has been processed to your original payment method.`
              : "No refund was applicable based on the cancellation policy.",
      // #1164 / D7: applied account credit is restored subject to the same
      // cancellation policy as the card slice. Empty when nothing was restored
      // so the override body renders no line (mirrors the refundMessage token).
      creditRestored: formatMoneyCents(creditRestoredCents),
      creditRestoredMessage:
        creditRestoredCents > 0
          ? `${formatMoneyCents(creditRestoredCents)} of previously applied account credit has been restored to your account (per the cancellation policy).`
          : "",
    },
    lodgeId,
  });
}

/**
 * #1993 Part A: member notice that the provisional non-member guest portion of
 * their stay was auto-cancelled because it stayed unpaid up to the check-in day.
 * Replaces the misleading generic booking-cancelled email on the terminal path:
 * nothing was ever charged for the guest portion, and their own linked booking
 * is untouched. `parentConfirmed` selects the reassurance wording (see the
 * template); `parentBookingReference` is shown when cheaply available.
 */
export async function sendSplitGuestPortionCancelledEmail(params: {
  // Booking this message belongs to (#2258); see sendBookingConfirmedEmail.
  bookingId: string;
  recipientMemberId: string;
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  parentConfirmed: boolean;
  parentBookingReference?: string | null;
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your guests' provisional place was cancelled — ${CLUB_NAME}`,
    html: await renderEmailHtml(() => splitGuestPortionCancelledTemplate({
      firstName: params.firstName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      parentConfirmed: params.parentConfirmed,
      parentBookingReference: params.parentBookingReference ?? null,
    })),
    bookingContext: bookingOwnerEmailContext(params.bookingId, params.recipientMemberId),
    templateName: "split-guest-portion-cancelled",
    templateData: {
      firstName: params.firstName,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
      bookingReference: params.parentBookingReference ?? "",
      // #2268: pre-composed optional line — a member whose own booking
      // reference is not cheaply available must not read a dangling
      // "Your booking reference:".
      bookingReferenceNote: composeOptionalEmailLine(
        "Your booking reference",
        params.parentBookingReference,
        { trailing: "\n" },
      ),
      // #2268: the reassurance sentence about the member's OWN booking, built
      // from the same helper as the hand-built HTML. The flat body used to
      // promise "unaffected and remains confirmed" unconditionally, which is
      // false when the parent booking is not settled.
      ownBookingNote: splitGuestPortionOwnBookingLine(params.parentConfirmed),
    },
    lodgeId: params.lodgeId,
  });
}

export async function sendBookingReviewApprovedEmail(params: {
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  adminNotes: string;
  bookingId: string;
  recipientMemberId: string;
  // Booking's lodge (multi-lodge phase 8); omitted/null resolves the
  // default lodge identity — always thread the booking's own lodgeId.
  lodgeId?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your booking has been approved - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: await renderEmailHtml(() => bookingReviewApprovedTemplate(
      params.firstName,
      params.checkIn,
      params.checkOut,
      params.adminNotes,
      params.bookingId,
    )),
    bookingContext: bookingOwnerEmailContext(params.bookingId, params.recipientMemberId),
    templateName: "booking-review-approved",
    lodgeId: params.lodgeId,
    templateData: {
      firstName: params.firstName,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
      adminNotes: params.adminNotes,
      // #2268: pre-composed optional line — an approval with no admin note
      // must not print a bare "Note from admin:".
      adminNotesLine: composeOptionalEmailLine(
        "Note from admin",
        params.adminNotes,
      ),
      bookingId: params.bookingId,
    },
  });
}

export async function sendBookingReviewRejectedEmail(params: {
  // Booking this message belongs to (#2258); see sendBookingConfirmedEmail.
  bookingId: string;
  recipientMemberId: string;
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  adminNotes: string;
  // Booking's lodge (multi-lodge phase 8); omitted/null resolves the
  // default lodge identity — always thread the booking's own lodgeId.
  lodgeId?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your booking could not be approved - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: await renderEmailHtml(() => bookingReviewRejectedTemplate(
      params.firstName,
      params.checkIn,
      params.checkOut,
      params.adminNotes,
    )),
    bookingContext: bookingOwnerEmailContext(params.bookingId, params.recipientMemberId),
    templateName: "booking-review-rejected",
    lodgeId: params.lodgeId,
    templateData: {
      firstName: params.firstName,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
      adminNotes: params.adminNotes,
      // #2268: pre-composed optional line — see sendBookingReviewApprovedEmail.
      adminNotesLine: composeOptionalEmailLine(
        "Reason from admin",
        params.adminNotes,
      ),
    },
  });
}

// N-01: Check-in reminder
export async function sendCheckinReminderEmail(
  // Booking this message belongs to (#2258); see sendBookingConfirmedEmail.
  bookingContext: { bookingId: string; recipientMemberId: string },
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guests: Array<{ firstName: string; lastName: string }>,
  chores: Array<{ name: string; description: string | null }>,
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null,
) {
  // One "First Last" per line — see the token comments below for why the same
  // string is handed to three tokens.
  const guestList = guests
    .map((guest) => `${guest.firstName} ${guest.lastName}`.trim())
    .join("\n");

  await sendEmail({
    to: email,
    subject: `Check-in Reminder - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: await renderEmailHtml(() => checkinReminderTemplate(firstName, checkIn, checkOut, guests, chores)),
    bookingContext: bookingOwnerEmailContext(bookingContext.bookingId, bookingContext.recipientMemberId),
    templateName: "checkin-reminder",
    templateData: {
      firstName,
      checkIn: emailCalendarDay(checkIn),
      checkOut: emailCalendarDay(checkOut),
      guestCount: guests.length,
      // #2307: the audited/overridable body renders one guest per line. This
      // used to supply every FIRST name comma-joined into {{guestFirstName}} and
      // every LAST name comma-joined into {{guestLastName}} on one line, so a
      // three-guest booking read "Ada, Bob, Cleo Lovelace, Smith, Jones" — each
      // guest's surname attached to somebody else. One newline-joined
      // "First Last" per guest is what the HTML template has always rendered as
      // a <li> list, so the audit trail and the delivered mail now agree.
      guestName: guestList,
      // BACK-COMPATIBILITY for a club that SAVED an override of this body before
      // the fix above. Their stored text still says
      // "{{guestFirstName}} {{guestLastName}}", and a token nobody supplies
      // renders as an empty string — so dropping the pair outright would have
      // sent those clubs a reminder that names NOBODY, which is worse than the
      // bug it replaced.
      //
      // THE MAPPING, and why it is this one. {{guestFirstName}} carries the same
      // full "First Last" per-guest list as {{guestName}}, and
      // {{guestLastName}} is deliberately empty:
      //   - the saved pair "{{guestFirstName}} {{guestLastName}}" renders the
      //     correct one-guest-per-line list, with the literal space between the
      //     two tokens left trailing at the end of the last line — invisible,
      //     because plainTextEmailTemplate trims every blank-line-separated
      //     block, and because an empty guest list makes the whole block trim to
      //     nothing and drop out rather than leaving a stray blank line;
      //   - a body using {{guestFirstName}} alone still names everybody;
      //   - a body using {{guestLastName}} alone renders nothing. Surnames on
      //     their own cannot be shown truthfully — a bare list of surnames is
      //     how the original bug misattributed them — so this shows nobody
      //     rather than somebody wrong.
      // What it can NEVER do, which was the whole point of the fix, is put one
      // guest's surname next to another guest's first name.
      guestFirstName: guestList,
      guestLastName: "",
      choreName: chores.map((chore) => chore.name).join(", "),
      choreDescription: chores
        .map((chore) => chore.description ?? "")
        .filter(Boolean)
        .join(", "),
      // #2268: the whole arrival-day chore block, pre-composed — heading and
      // all — or nothing at all. The flat body has no conditional syntax, so
      // a stay with no arrival-day chores must not print a bare
      // "Your arrival day chores:" heading over an empty list.
      choreListNote: chores.length
        ? "Your arrival day chores:\n\n" +
          chores
            .map((chore) => composeChoreLine(chore.name, chore.description))
            .join("") +
          "\n"
        : "",
    },
    lodgeId,
  });
}

export async function sendPreArrivalReminderEmail(params: {
  // Booking this message belongs to (#2258); see sendBookingConfirmedEmail.
  bookingId: string;
  recipientMemberId: string;
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  expectedArrivalTime?: string | null;
  // Booking's lodge (multi-lodge phase 8): the email carries this lodge's
  // name, travel note, and door code. Omitted/null resolves the club's
  // default lodge — including its real door code, so always thread the
  // booking's own lodgeId.
  lodgeId?: string | null;
  // #2350: extra still owing on this booking after an upward change. Passed by
  // the pre-arrival cron when the delta is uncollected; zero/omitted otherwise,
  // which leaves the message byte-for-byte as it was.
  outstandingAdditionalAmountCents?: number;
}) {
  const settings = await loadEmailMessageSettingsForLodge(params.lodgeId);
  const outstandingAdditionalAmountCents =
    params.outstandingAdditionalAmountCents ?? 0;
  // #2621 (owner decision D-M5) — the checkout-day chore sentence, and the one
  // thing that decides whether it is said at all.
  //
  // The chores module DEFAULTS OFF (`ClubModuleSettings.chores` is
  // `@default(false)`), so an unconditional sentence would tell every member of
  // every club that never turns chores on that they are on a roster that does
  // not exist — on the last message most members read before they travel.
  // Composed once here and handed to BOTH the hand-built HTML and the
  // admin-editable body's {{checkoutChoreNote}}, so an override and the built-in
  // message cannot say different things (the {{namingUrgencyNote}} convention).
  //
  // Read here rather than threaded through every caller so no send site can
  // forget it, and read BEFORE `sendEmail` rather than inside any transaction —
  // there is none on this path, and the provider call stays outside one.
  // `loadEffectiveModuleFlags` fails SOFT to all-modules-off, which is the right
  // direction for this sentence: a database blip costs a club with chores one
  // reminder sentence, whereas failing open would tell a club with no chore
  // roster to go and talk to a hut leader about one.
  const modules = await loadEffectiveModuleFlags();
  // The bare sentence (or ""). The HTML wraps it in its own paragraph; the flat
  // body needs it to bring its own paragraph break, which is the composition
  // below rather than newlines in the default body — see the note there.
  const checkoutChoreSentence = checkoutDayChoreNote(modules.chores);
  // RETURNS the mailer's outcome (#3035). It used to swallow it, and the
  // pre-arrival cron consequently could not tell a send from a withhold — so an
  // environment withhold burned `preArrivalReminderSentAt` permanently and the
  // member arrived at a locked lodge with no door code. Its caller inspects this.
  return sendEmail({
    to: params.email,
    subject: `Pre-arrival Information - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: await renderEmailHtml(() => preArrivalReminderTemplate({
      ...params,
      lodgeTravelNote: settings.lodgeTravelNote,
      doorCode: settings.doorCode,
      checkoutChoreNote: checkoutChoreSentence,
    })),
    bookingContext: bookingOwnerEmailContext(params.bookingId, params.recipientMemberId),
    templateName: "pre-arrival-reminder",
    templateData: {
      firstName: params.firstName,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
      guestCount: params.guestCount,
      expectedArrivalTime: params.expectedArrivalTime ?? "",
      doorCode: settings.doorCode ?? "",
      // #2268: pre-composed optional lines. Both values are nullable, so the
      // flat body carries only these tokens — a stay with no expected arrival
      // time, or a lodge with no door code, prints neither a dangling
      // "Expected arrival:" nor a dangling "Door code:".
      expectedArrivalNote: composeOptionalEmailLine(
        "Expected arrival",
        params.expectedArrivalTime,
        { trailing: "\n" },
      ),
      // #2621 (D-M5): the sentence with its OWN trailing blank line, or the
      // empty string for a club with no chore roster.
      //
      // The separator rides the VALUE, not the default body — the
      // `{{adminNoteLine}}` / `{{promoSummary}}` convention (see
      // `composeOptionalEmailLine`). Newlines around the token in the body would
      // be emitted whether or not the club runs chores, which changes the shape
      // of every chore-free club's reminder (they are the default) for a
      // sentence they never receive. This way the body reads
      // `{{checkoutChoreNote}}{{outstandingAdditionalNote}}` and a chores-OFF
      // send renders byte-for-byte what it rendered before #2621, while a
      // chores-ON send gets a real paragraph of its own.
      checkoutChoreNote: composeOptionalEmailLine(null, checkoutChoreSentence, {
        trailing: "\n\n",
      }),
      // #2268: identical shape to the booking-confirmed line above — a bare
      // "Door code: 1234", or nothing at all for a lodge with no code.
      doorCodeNote: composeOptionalEmailLine("Door code", settings.doorCode, {
        trailing: "",
      }),
      // Pre-composed so an admin override places one block rather than having
      // to write the conditional itself (the {{doorCodeNote}} convention).
      outstandingAdditionalNote:
        outstandingAdditionalAmountCents > 0
          ? `There is still ${formatMoneyCents(outstandingAdditionalAmountCents)} to pay on this booking after a change to your stay. Please pay it from your booking page before you arrive.`
          : "",
    },
    lodgeId: params.lodgeId,
  });
}

/**
 * #2550 — escalating reminder that a member whole-lodge booking's party is
 * still listed as "Guest 1..N".
 *
 * Sent by the `placeholder-guest-name-reminders` cron only. There is no token
 * and no public page: the member edits their own guests behind their login, and
 * the canonical authenticated booking link is appended centrally for every
 * booking-scoped send.
 *
 * The escalation is a change of TONE and FREQUENCY, never of consequence — the
 * stay, check-in and roster are never withheld over an unnamed guest (owner
 * decision, #2550). `{{namingUrgencyNote}}` is the one sentence that changes,
 * composed once here and handed to both the HTML and the flat body so an admin
 * override and the built-in message cannot say different things.
 */
export async function sendWholeLodgeGuestNamesReminderEmail(params: {
  bookingId: string;
  recipientMemberId: string;
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  unnamedGuestCount: number;
  stage: "first" | "reminder" | "final";
  lodgeId?: string | null;
}) {
  const urgencyNote = wholeLodgeGuestNamesUrgencyNote(params.stage);
  const isFinal = params.stage === "final";

  return sendEmail({
    to: params.email,
    lodgeId: params.lodgeId,
    subject: isFinal
      ? `Last chance: tell us who is coming — ${CLUB_NAME}`
      : `Who is coming with you? — ${CLUB_NAME}`,
    html: await renderEmailHtml(() => wholeLodgeGuestNamesReminderTemplate({
      firstName: params.firstName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      guestCount: params.guestCount,
      unnamedGuestCount: params.unnamedGuestCount,
      isFinal,
      urgencyNote,
    })),
    bookingContext: bookingOwnerEmailContext(
      params.bookingId,
      params.recipientMemberId,
    ),
    templateName: "whole-lodge-guest-names-reminder",
    templateData: {
      firstName: params.firstName,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
      guestCount: params.guestCount,
      unnamedGuestCount: params.unnamedGuestCount,
      namingUrgencyNote: urgencyNote,
    },
  });
}

/**
 * F-#2350: the extra owed after an upward booking change has not been paid.
 *
 * Sent automatically a few days after the change and once more shortly before
 * check-in (src/lib/cron-additional-payment-reminders.ts), and on demand by an
 * admin from the booking page. One template for all three so the member always
 * reads the same wording, and so an admin override edits one message rather than
 * three.
 */
export async function sendAdditionalPaymentReminderEmail(params: {
  bookingId: string;
  recipientMemberId: string;
  email: string;
  firstName: string;
  additionalAmountCents: number;
  checkIn: Date;
  checkOut: Date;
  requestedOn: Date;
  lodgeId?: string | null;
}) {
  // Returns the outcome rather than swallowing it (#2350): both callers write a
  // stamp BEFORE sending, and that stamp is also the 60-minute cooldown, so a
  // withheld/suppressed/placeholder send — which returns, it does not throw —
  // must not be mistaken for a delivered one.
  return sendEmail({
    to: params.email,
    subject: `Payment Still Needed - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: await renderEmailHtml(() => additionalPaymentReminderTemplate(params)),
    bookingContext: bookingOwnerEmailContext(params.bookingId, params.recipientMemberId),
    templateName: "additional-payment-reminder",
    templateData: {
      firstName: params.firstName,
      additionalAmount: formatMoneyCents(params.additionalAmountCents),
      requestedOn: emailClubDate(params.requestedOn),
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
    },
    lodgeId: params.lodgeId,
  });
}

// EML-01: Booking modified email
export async function sendBookingModifiedEmail(params: {
  // Booking this message belongs to (#2258); see sendBookingConfirmedEmail.
  bookingId: string;
  recipientMemberId: string;
  email: string;
  firstName: string;
  modificationType: string;
  oldCheckIn: Date;
  oldCheckOut: Date;
  newCheckIn: Date;
  newCheckOut: Date;
  oldGuestCount: number;
  newGuestCount: number;
  oldFinalPriceCents: number;
  newFinalPriceCents: number;
  changeFeeCents: number;
  refundAmountCents: number;
  accountCreditAmountCents?: number;
  additionalAmountCents: number;
  additionalPaymentMethod?: "STRIPE" | "INTERNET_BANKING";
  paymentReference?: string | null;
  xeroInvoiceNumber?: string | null;
  // #2390: the plain-English sentence about who a capped promotion still covers
  // after this edit. Flows into the shared change rows, so the HTML email, the
  // admin-editable body, the edit preview and the booking's own history all
  // carry the identical wording.
  promoCoverageNote?: string | null;
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null;
}) {
  const accountCreditAmountCents = params.accountCreditAmountCents ?? 0;
  // #2267: pre-composed {{changeSummary}} block for the admin-editable body,
  // built from the same rows as the HTML template — only what actually changed
  // is shown as a Previous/New pair, and a change fee only when one was
  // charged. Each row carries its own trailing newline (the {{promoSummary}}
  // precedent) so the default body can place it as a single block.
  const changeSummary = bookingModificationSummaryRows(params)
    .map((row) => `${row.label}: ${row.value}\n`)
    .join("");
  const xeroInvoicePaymentContext = params.xeroInvoiceNumber
    ? ` Xero invoice ${params.xeroInvoiceNumber} will be used for payment.`
    : " A Xero invoice and payment reference will be used for payment.";
  const paymentReferenceContext = params.paymentReference
    ? ` Payment reference: ${params.paymentReference}.`
    : "";
  const paymentNote =
    params.refundAmountCents > 0
      ? `A refund of ${formatMoneyCents(params.refundAmountCents)} has been processed to your original payment method.`
      : accountCreditAmountCents > 0
        ? `Account credit of ${formatMoneyCents(accountCreditAmountCents)} has been added for future bookings.`
        : params.additionalAmountCents > 0
          ? params.additionalPaymentMethod === "INTERNET_BANKING"
            ? `An additional Internet Banking payment of ${formatMoneyCents(params.additionalAmountCents)} is required.${xeroInvoicePaymentContext}${paymentReferenceContext} Xero reconciliation confirms the payment before it is treated as paid.`
            : `An additional payment of ${formatMoneyCents(params.additionalAmountCents)} is required.`
          : "";

  await sendEmail({
    to: params.email,
    subject: `Booking Modified - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: await renderEmailHtml(() => bookingModifiedTemplate(params)),
    bookingContext: bookingOwnerEmailContext(params.bookingId, params.recipientMemberId),
    templateName: "booking-modified",
    templateData: {
      firstName: params.firstName,
      // #2267: the same wording the HTML path shows — not the raw enum word an
      // override-using club used to email members.
      modificationTypeLabel: bookingModificationTypeLabel(
        params.modificationType,
      ),
      changeSummary,
      // Legacy per-piece change tokens, still supplied so an override saved
      // before {{changeSummary}} existed keeps rendering (#2267). They cannot
      // express "only show what changed", which is why the default body no
      // longer builds its rows out of them.
      oldCheckIn: emailCalendarDay(params.oldCheckIn),
      oldCheckOut: emailCalendarDay(params.oldCheckOut),
      newCheckIn: emailCalendarDay(params.newCheckIn),
      newCheckOut: emailCalendarDay(params.newCheckOut),
      oldGuestCount: params.oldGuestCount,
      newGuestCount: params.newGuestCount,
      oldTotal: formatMoneyCents(params.oldFinalPriceCents),
      newTotal: formatMoneyCents(params.newFinalPriceCents),
      changeFee: formatMoneyCents(params.changeFeeCents),
      refundAmount: formatMoneyCents(params.refundAmountCents),
      accountCreditAmount: formatMoneyCents(accountCreditAmountCents),
      additionalAmount: formatMoneyCents(params.additionalAmountCents),
      additionalPaymentMethod: params.additionalPaymentMethod ?? "",
      paymentReference: params.paymentReference ?? "",
      xeroInvoiceNumber: params.xeroInvoiceNumber ?? "",
      paymentNote,
    },
    lodgeId: params.lodgeId,
  });
}

/**
 * Tell a member their bed-holding policy-exception request lapsed (#2553).
 *
 * Called by the hold-reaper cron AFTER the release transaction has committed, so
 * a mail failure can never roll back or repeat a capacity release. The recipient
 * is the member who RAISED the request (not necessarily the booking's owner — a
 * family delegate can raise one), which is also the authority the optional
 * booking link is resolved against.
 */
export async function sendPolicyExceptionRequestExpiredEmail(params: {
  // Booking this message belongs to (#2258); see sendBookingConfirmedEmail.
  bookingId: string;
  recipientMemberId: string;
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  /** The hold deadline that passed, stamped or derived; never "now". */
  expiresAt: Date;
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null;
}) {
  const settings = await loadEmailMessageSettingsForLodge(params.lodgeId);

  return sendEmail({
    to: params.email,
    subject: `Your exception request has lapsed - ${settings.lodgeName}`,
    html: await renderEmailHtml(() => policyExceptionRequestExpiredTemplate({
      firstName: params.firstName,
      lodgeName: settings.lodgeName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      expiresAt: params.expiresAt,
    })),
    bookingContext: bookingOwnerEmailContext(
      params.bookingId,
      params.recipientMemberId,
    ),
    templateName: "policy-exception-request-expired",
    templateData: {
      firstName: params.firstName,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
      expiresAt: emailClubDateTime(params.expiresAt),
    },
    lodgeId: params.lodgeId,
  });
}

/**
 * Tell a booking owner their confirmed booking has lost its required adult-member
 * cover (#2576 §7, §16).
 *
 * Called by the coverage drain AFTER the causing change has committed, and only
 * once delivery has been LEASED against the incident row
 * (`claimHostingCoverageOwnerNotification`). The success stamp is written only
 * after this function returns `sent`; failures release the lease for the durable
 * queue to retry. Immediately before this wrapper is called, the exact claimant
 * renews its lease atomically; a successor-token race leaves only one active exact
 * claimant for that renewed lease. Delivery is still at-least-once: a crash after
 * provider acceptance but before the success stamp can make a later lease send the
 * transition again.
 *
 * The recipient is the booking's OWNER, which is also the authority the optional
 * booking link is resolved against. Under `SAME_BOOKING_OWNER` the cover that went
 * away was on their own account (§11), so pointing them at their own booking
 * discloses nothing.
 */
export async function sendHostingCoverageLostEmail(params: {
  // Booking this message belongs to (#2258); see sendBookingConfirmedEmail.
  bookingId: string;
  recipientMemberId: string;
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  /** The NZ lodge-nights with no adult-member cover, already formatted. */
  uncoveredNights: string;
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null;
}) {
  const settings = await loadEmailMessageSettingsForLodge(params.lodgeId);

  return sendEmail({
    to: params.email,
    subject: `Your booking needs adult member cover - ${settings.lodgeName}`,
    html: await renderEmailHtml(() => hostingCoverageLostTemplate({
      firstName: params.firstName,
      lodgeName: settings.lodgeName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      uncoveredNights: params.uncoveredNights,
    })),
    bookingContext: bookingOwnerEmailContext(
      params.bookingId,
      params.recipientMemberId,
    ),
    templateName: "hosting-coverage-lost",
    templateData: {
      firstName: params.firstName,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
      uncoveredNights: params.uncoveredNights,
    },
    lodgeId: params.lodgeId,
  });
}

export async function sendSetupIntentFailedEmail(params: {
  // Booking this message belongs to (#2258); see sendBookingConfirmedEmail.
  bookingId: string;
  recipientMemberId: string;
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Card Setup Failed - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: await renderEmailHtml(() => setupIntentFailedTemplate(params)),
    bookingContext: bookingOwnerEmailContext(params.bookingId, params.recipientMemberId),
    templateName: "setup-intent-failed",
    templateData: {
      firstName: params.firstName,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
    },
    lodgeId: params.lodgeId,
  });
}
