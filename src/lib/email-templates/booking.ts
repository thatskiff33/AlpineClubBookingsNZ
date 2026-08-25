/**
 * Member-facing emails about the life of a booking: confirmed, pending,
 * bumped, cancelled, modified, and the card-setup failure that puts one at
 * risk.
 *
 * The family boundary is `src/lib/email/booking.ts`, the sender module that
 * ships these. Three sub-modules split off it to stay inside the 700-line
 * module budget, not as a new taxonomy: `./booking-reminders` (sent ahead of a
 * stay), `./booking-exceptions` (asking the club to bend a booking rule, and
 * every answer to that ask), and `@/lib/booking-money-lines` (the money rows, shared
 * with the admin alerts about the same booking).
 */
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
import { escapeHtml } from "./escape";
import {
  type BookingCalendarLinks,
  bookingAddToCalendarHtmlRow,
} from "@/lib/calendar-links";
import {
  alertBox,
  BASE_URL,
  button,
  formatCents,
  heading,
  infoTable,
  layout,
  multilineBlock,
  muted,
  paragraph,
  supportContactSentence,
} from "./layout";
import { CLUB_LODGE_TRAVEL_NOTE } from "@/config/club-identity";
import {
  bookingBumpedRebookAction,
  bookingPaymentDueNote,
  splitGuestPortionOwnBookingLine,
} from "@/lib/email-message-notes";
import { formatNZDate, formatNZDateTime } from "@/lib/nzst-date";

/**
 * The "how to get to the lodge" block: travel note, and the door code when the
 * booking has one.
 *
 * Exported for `./booking-reminders`, where the pre-arrival reminder prints the
 * same block as the confirmation does. One implementation, so the two cannot
 * tell an arriving member two different things.
 */
export function arrivalInstructionsSection({
  travelNote,
  doorCode,
}: {
  travelNote: string;
  doorCode?: string | null;
}): string {
  const safeTravelNote = travelNote.trim();
  const safeDoorCode = doorCode?.trim() || null;
  const doorCodeTable = safeDoorCode
    ? infoTable([
        {
          label: "Door code",
          value: `<strong style="font-size: 18px; letter-spacing: 1px;">${escapeHtml(safeDoorCode)}</strong>`,
        },
      ])
    : "";

  return `
    ${paragraph("<strong>How to get to the lodge</strong>")}
    ${safeTravelNote ? multilineBlock(escapeHtml(safeTravelNote)) : ""}
    ${doorCodeTable}
    ${safeDoorCode ? muted("Please keep the door code private and use the current code when you arrive.") : ""}
  `;
}

// The built-in template's {{ical}} row (fork #35/#41/#43): one shared
// composer in calendar-links.ts renders the icons here AND in admin override
// bodies via the renderer's sentinel swap, so the two paths cannot drift.
function addToCalendarLine(links: BookingCalendarLinks): string {
  return paragraph(bookingAddToCalendarHtmlRow(links));
}

export function bookingConfirmedTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  totalCents: number,
  options?: {
    discountCents?: number;
    promoAdjustmentCents?: number;
    promoCode?: string;
    // #2328: account credit applied to this booking, read off the ledger by
    // the sender and threaded through unchanged. Absent/zero renders no credit
    // lines and leaves the message byte-for-byte as it was.
    appliedCredit?: AppliedCreditSummary;
    lodgeTravelNote?: string;
    doorCode?: string | null;
    // Split-booking parent (#738): the non-member places on this party are held
    // as a provisional linked booking, charged separately around the hold
    // deadline. Present only when this confirmation is a split parent.
    provisionalGuests?: {
      guestCount: number;
      holdUntil: Date;
    };
    // #2263: a confirmation for a booking that is CONFIRMED but NOT yet paid —
    // the member whole-lodge approval creates a PENDING Internet Banking
    // receivable, so "Total Paid" and "Payment has been processed successfully"
    // would both be false. When present, the money row states what is OWING and
    // the alert box says how to pay it. Same template (and therefore the same
    // operator override) as the paid confirmation, exactly as the split-parent
    // `provisionalGuests` variant is (#738).
    paymentDue?: {
      /** Internet-banking reference the member must quote (never a bearer token). */
      reference: string;
      /** True once the club's accounting system actually emails the invoice. */
      invoiceEmailed: boolean;
    };
    // #2397: the booking is settled but NOT in full — an admin recorded a cash
    // / off-Xero payment and said it did not cover an uncollected price
    // increase, so the club took less than the booking is worth and will go on
    // asking for the rest. "Total Paid: <whole price>" and "Payment has been
    // processed successfully" would both be false, and would contradict the
    // admin's own receipt. The money rows split into paid vs still owing and
    // the alert box says what happens next. `paymentDue` (nothing paid at all)
    // takes precedence if both are somehow supplied — it is the stronger
    // statement, and the two are mutually exclusive by construction.
    outstandingBalance?: {
      /** Still owed, in integer cents. Always < totalCents. */
      amountCents: number;
      /**
       * True when the member still holds a live card instrument for it (the
       * addition's own payment intent, deliberately spared by the settlement),
       * so their booking page can actually take the money. False means the
       * only route is the club contacting them, and the copy must say so
       * rather than sending them to a door that does not open.
       */
      payableOnline: boolean;
    };
    // Fork issue #35: the add-to-calendar links, built by the sender from the
    // same stay the flat {{ical}} token describes. Absent when link building
    // failed (the sender fails open on this decoration) — no line renders.
    calendarLinks?: BookingCalendarLinks;
  }
): string {
  const promoAdjustmentCents = resolvePromoAdjustmentCents(options);
  const provisional = options?.provisionalGuests;
  const provisionalSection =
    provisional && provisional.guestCount > 0
      ? alertBox(
          `Your ${provisional.guestCount} non-member guest${
            provisional.guestCount === 1 ? "" : "s"
          } ${
            provisional.guestCount === 1 ? "is" : "are"
          } held provisionally as a linked booking — no bed is reserved for them yet, and the payment above covers only your member places. If beds remain around ${formatNZDateTime(
            provisional.holdUntil,
          )}, we'll automatically take that guest portion from your saved payment method and your guests are confirmed. If we can't take payment, we'll contact you to arrange it. If the lodge fills with member bookings first, that portion is not charged and those guests are bumped.`,
          "warning",
        )
      : "";
  const rows: Array<{ label: string; value: string }> = [
    { label: "Check-in", value: formatNZDate(checkIn) },
    { label: "Check-out", value: formatNZDate(checkOut) },
    { label: "Guests", value: String(guestCount) },
  ];

  for (const row of promoAdjustmentSummaryRows(
    totalCents,
    promoAdjustmentCents,
    options?.promoCode,
  )) {
    // The shared rows are unescaped plain text (the flat token path needs them
    // raw); the promo code inside the label is club-entered data, so escape at
    // this HTML edge.
    rows.push({ label: escapeHtml(row.label), value: escapeHtml(row.value) });
  }

  const paymentDue = options?.paymentDue;
  // #2397: only when nothing is due in full — the two states are exclusive.
  const outstandingBalance = paymentDue ? undefined : options?.outstandingBalance;
  // #2328: the applied-credit pair, from the SHARED row builder the flat
  // {{creditNote}} token uses, so the HTML table and an admin-editable body
  // tell one story. Empty for every booking that used no credit, which is why
  // those confirmations are byte-for-byte unchanged.
  const appliedCreditCents = Math.max(0, options?.appliedCredit?.amountCents ?? 0);
  const creditRows = appliedCreditSummaryRows(
    appliedCreditCents,
    settledByPaymentCents({
      totalCents,
      appliedCreditCents,
      unpaid: Boolean(paymentDue),
      outstandingCents: outstandingBalance?.amountCents ?? 0,
    }),
    options?.appliedCredit?.settlementMethod ?? "card",
  ).map((row) => ({
    // Labels and formatted money only — no club- or member-entered data — but
    // escaped at this HTML edge on the same principle as the promo rows above.
    label: escapeHtml(row.label),
    value: escapeHtml(row.value),
  }));
  // #2483: what an unpaid member is really being asked for, netted from the
  // club's own credit ledger by the SHARED resolver the sender uses, so the
  // table and the {{paymentOutcome}} block cannot disagree about the figure.
  const unpaidNetting = resolveUnpaidCreditNetting({
    totalCents,
    appliedCreditCents,
  });
  if (paymentDue) {
    // One "Total Due" row when no credit applies (byte-for-byte the pre-#2483
    // email), the reconciling trio when it does, and a bare "Booking Total"
    // when the ledger contradicts the price — from the shared builder, escaped
    // at this HTML edge on the same principle as the rows above.
    for (const row of unpaidMoneySummaryRows(totalCents, unpaidNetting)) {
      rows.push({ label: escapeHtml(row.label), value: escapeHtml(row.value) });
    }
  } else if (outstandingBalance) {
    rows.push(
      { label: "Booking Total", value: formatCents(totalCents) },
      {
        label: "Paid",
        value: formatCents(totalCents - outstandingBalance.amountCents),
      },
      // Between "Paid" and "Still Owing": the credit pair breaks down the
      // amount immediately above it, and the balance still owing stays last.
      ...creditRows,
      { label: "Still Owing", value: formatCents(outstandingBalance.amountCents) },
    );
  } else {
    rows.push({ label: "Total Paid", value: formatCents(totalCents) }, ...creditRows);
  }

  // One composed paragraph, from the SHARED composer the {{paymentDueNote}}
  // token in sendBookingConfirmedEmail is built from, so an operator override
  // tells the same story — including the #2444 account-credit sentence, which
  // must never appear on one renderer and not the other. The reference is
  // club-entered data, so it is escaped at this HTML edge (the composer takes
  // it already escaped, on the same principle as the shared money rows above).
  // #2483: the amount is what the member must TRANSFER, so it is netted; the
  // arithmetic behind it goes in the paragraph in words, for a body that
  // renders {{paymentDueNote}} without the money table beside it. The paragraph
  // shape comes from the SAME netting the rows above were built from, via the
  // shared adapter, so the table and the prose can never disagree about whether
  // this member is being asked for money at all.
  const paymentDueNote = paymentDue
    ? bookingPaymentDueNote({
        amount: formatCents(unpaidNetting.toTransferCents),
        reference: escapeHtml(paymentDue.reference),
        invoiceEmailed: paymentDue.invoiceEmailed,
        accountCredit: unpaidCreditNoteInput(
          totalCents,
          unpaidNetting,
          formatCents,
        ),
      })
    : "";
  // #2397, same convention: one composed sentence shared with the token path.
  const outstandingBalanceNote = outstandingBalance
    ? `Your payment of ${formatCents(totalCents - outstandingBalance.amountCents)} has been recorded and your booking is confirmed. ${formatCents(outstandingBalance.amountCents)} is still owing from a later change to this booking.` +
      (outstandingBalance.payableOnline
        ? " You can pay it from your booking page."
        : " The club will be in touch to arrange it.")
    : "";

  return layout(`
    ${heading("Booking Confirmed")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", your lodge booking has been confirmed!")}
    ${infoTable(rows)}
    ${
      paymentDue
        ? alertBox(paymentDueNote, "warning")
        : outstandingBalance
          ? alertBox(outstandingBalanceNote, "warning")
          : alertBox("Payment has been processed successfully.", "success")
    }
    ${provisionalSection}
    ${arrivalInstructionsSection({
      travelNote: options?.lodgeTravelNote ?? CLUB_LODGE_TRAVEL_NOTE,
      doorCode: options?.doorCode ?? null,
    })}
    ${paragraph("You can view your booking details and manage your stay from your account.")}${
      // Concatenated (no dedicated template line) so a confirmation WITHOUT
      // links renders byte-identical to the pre-#35 output — the #2689
      // equivalence pins hold for every fixture that does not pass links.
      options?.calendarLinks ? addToCalendarLine(options.calendarLinks) : ""
    }
    ${button("View Booking", BASE_URL + "/bookings")}
  `);
}

export function bookingPendingTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  holdUntil: Date
): string {
  return layout(`
    ${heading("Booking Pending")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", your lodge booking has been received and is currently pending.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
      { label: "Guests", value: String(guestCount) },
      { label: "Hold Until", value: formatNZDateTime(holdUntil) },
    ])}
    ${alertBox("Your booking includes non-member guests and will be held as pending until " + formatNZDateTime(holdUntil) + ".", "warning")}
    ${paragraph("During this time, club members have priority. If the lodge fills up with member bookings, your booking may be bumped. <strong>Your card will only be charged when the booking is confirmed.</strong>")}
    ${button("View Booking", BASE_URL + "/bookings")}
  `);
}

export function bookingBumpedTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  // #2430: whether this recipient can actually use the member booking flow.
  // A non-login NON_MEMBER/SCHOOL contact (a converted public booking request,
  // or an admin booking on their behalf) is pointed at the club contact page
  // instead of a login they can never complete. REQUIRED, with no default: the
  // leaky value is `true`, so a new send site that forgot this argument would
  // silently mail a login-less contact a members-only link (#2430 review).
  recipientCanBookOnline: boolean
): string {
  const rebook = bookingBumpedRebookAction(recipientCanBookOnline);
  return layout(`
    ${heading("Booking Update")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", unfortunately your pending lodge booking has been bumped due to member demand.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
      { label: "Guests", value: String(guestCount) },
    ])}
    ${alertBox("Your card has not been charged.", "info")}
    ${paragraph("As a non-member booking, priority is given to club members when the lodge reaches capacity. You're welcome to rebook for different dates where availability exists.")}
    ${button(rebook.label, BASE_URL + rebook.path)}
    ${supportContactSentence("If you have any questions, contact the club at ")}
    ${muted("We apologise for the inconvenience.")}
  `);
}

export function bookingCancelledTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  refundCents: number,
  // B5 (#2262): "manual" is a cash / off-Xero settlement being handed back by a
  // person. It must NEVER read as "on its way to your card" (no card was
  // charged) nor as account credit (none was minted — a hand-back task was
  // raised instead), so it gets its own honest copy.
  refundMethod: "card" | "credit" | "manual" = "card",
  creditRestoredCents: number = 0
): string {
  let refundInfo: string;
  if (refundCents > 0 && refundMethod === "manual") {
    refundInfo = alertBox(
      "You paid for this booking in cash or by bank transfer, so there is no card payment to reverse. The club will arrange your refund of " +
        formatCents(refundCents) +
        " directly and will be in touch.",
      "info"
    );
  } else if (refundCents > 0 && refundMethod === "credit") {
    refundInfo = alertBox(
      "A credit of " + formatCents(refundCents) + " has been added to your account for future bookings.",
      "success"
    );
  } else if (refundCents > 0) {
    refundInfo = alertBox(
      "A refund of " + formatCents(refundCents) + " has been processed to your original payment method.",
      "success"
    );
  } else {
    refundInfo = alertBox("No refund was applicable based on the cancellation policy.", "info");
  }

  // #1164 / D7: the account credit originally applied to this booking is now
  // restored subject to the same cancellation policy as the card slice, so a
  // late cancellation may restore less than the full amount applied.
  const creditRestoredInfo =
    creditRestoredCents > 0
      ? alertBox(
          formatCents(creditRestoredCents) +
            " of previously applied account credit has been restored to your account (per the cancellation policy).",
          "success"
        )
      : "";

  return layout(`
    ${heading("Booking Cancelled")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", your lodge booking has been cancelled.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
    ])}
    ${refundInfo}
    ${creditRestoredInfo}
    ${paragraph("You can make a new booking at any time from your account.")}
    ${button("Make a New Booking", BASE_URL + "/book")}
  `);
}

export function bookingGuestsCancelledTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date
): string {
  return layout(`
    ${heading("Booking Cancelled")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", you asked us to cancel your whole booking if your non-member guests couldn't come. The lodge filled up with member bookings, so we've cancelled it.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
    ])}
    ${alertBox("Your card has not been charged.", "info")}
    ${paragraph("You're welcome to rebook for different dates where availability exists.")}
    ${button("Book Again", BASE_URL + "/book")}
  `);
}

export function bookingModifiedTemplate(params: {
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
  // #2390: see bookingModificationSummaryRows — it renders as one more change
  // row, so the HTML and the flat body stay identical.
  promoCoverageNote?: string | null;
}): string {
  const {
    firstName,
    modificationType,
    oldCheckIn,
    oldCheckOut,
    newCheckIn,
    newCheckOut,
    oldGuestCount,
    newGuestCount,
    oldFinalPriceCents,
    newFinalPriceCents,
    changeFeeCents,
    refundAmountCents,
    accountCreditAmountCents = 0,
    additionalAmountCents,
    additionalPaymentMethod,
    paymentReference,
    xeroInvoiceNumber,
    promoCoverageNote,
  } = params;

  // The change rows come from the shared helper the flat {{changeSummary}}
  // token also uses, so both paths always show the same rows (#2267). The
  // shared rows are plain text, so escape at this HTML edge.
  const rows = bookingModificationSummaryRows({
    oldCheckIn,
    oldCheckOut,
    newCheckIn,
    newCheckOut,
    oldGuestCount,
    newGuestCount,
    oldFinalPriceCents,
    newFinalPriceCents,
    changeFeeCents,
    promoCoverageNote,
  }).map((row) => ({
    label: escapeHtml(row.label),
    value: escapeHtml(row.value),
  }));

  let paymentNote = "";
  if (refundAmountCents > 0) {
    paymentNote = alertBox(
      `A refund of ${formatCents(refundAmountCents)} has been processed to your original payment method.`,
      "success"
    );
  } else if (accountCreditAmountCents > 0) {
    paymentNote = alertBox(
      `Account credit of ${formatCents(accountCreditAmountCents)} has been added for future bookings.`,
      "success"
    );
  } else if (additionalAmountCents > 0) {
    if (additionalPaymentMethod === "INTERNET_BANKING") {
      const invoiceContext = xeroInvoiceNumber
        ? ` Xero invoice ${escapeHtml(xeroInvoiceNumber)} will be used for payment.`
        : " A Xero invoice and payment reference will be used for payment.";
      const referenceContext = paymentReference
        ? ` Payment reference: ${escapeHtml(paymentReference)}.`
        : "";
      paymentNote = alertBox(
        `An additional Internet Banking payment of ${formatCents(additionalAmountCents)} is required.${invoiceContext}${referenceContext} Xero reconciliation confirms the payment before it is treated as paid.`,
        "warning"
      );
    } else {
      paymentNote = alertBox(
        `An additional payment of ${formatCents(additionalAmountCents)} is required.`,
        "warning"
      );
    }
  }

  return layout(`
    ${heading("Booking Modified")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", your booking has been updated.")}
    ${alertBox(escapeHtml(bookingModificationTypeLabel(modificationType)), "info")}
    ${infoTable(rows)}
    ${paymentNote}
    ${paragraph("You can view your updated booking details from your account.")}
    ${button("View Booking", BASE_URL + "/bookings")}
  `);
}

export function setupIntentFailedTemplate(data: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
}): string {
  // #2256: these had the right locale but no `timeZone`, so they rendered in
  // whatever zone the sending process happened to run in — a 2026-04-15T23:30Z
  // check-in reads as 15 April from a UTC worker and 16 April in New Zealand.
  // formatNZDate pins both the zone and the house "16 Apr 2026" format.
  const dates = `${formatNZDate(data.checkIn)} – ${formatNZDate(data.checkOut)}`;
  return layout(`
    ${heading("Card Setup Failed")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ",")}
    ${alertBox("We were unable to save your card details for your upcoming booking (" + dates + "). Your booking is still held, but we won't be able to charge you automatically when it's confirmed.", "warning")}
    ${paragraph("Please log in and update your payment method to avoid your booking being cancelled.")}
    ${button("Update Payment Method", (process.env.NEXTAUTH_URL || "http://localhost:3000") + "/bookings")}
    ${supportContactSentence("If you need help, contact the club at ")}
  `);
}

/**
 * #1993 Part A — member-facing notice that the provisional non-member guest
 * portion of their stay was auto-cancelled because it stayed unpaid up to the
 * check-in day. Reassures that nothing was ever charged for the guest portion
 * and that the cancellation touches only that portion. `parentConfirmed`
 * selects the reassurance about their own booking: a settled/internet-banking
 * parent "remains confirmed"; otherwise the copy only states the parent was not
 * changed by this cancellation, never a false "confirmed". No bearer token, so
 * this is not sensitive-log material.
 */

export function splitGuestPortionCancelledTemplate(data: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  parentConfirmed: boolean;
  parentBookingReference?: string | null;
}): string {
  const ownBookingLine = splitGuestPortionOwnBookingLine(data.parentConfirmed);
  return layout(`
    ${heading("Your Guests' Provisional Place Was Cancelled")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", the provisional place we were holding for your non-member guests stayed unpaid up to the check-in day, so it has now been automatically cancelled. Nothing was ever charged for it, and no beds were held.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      ...(data.parentBookingReference
        ? [
            {
              label: "Your booking reference",
              value: escapeHtml(data.parentBookingReference),
            },
          ]
        : []),
    ])}
    ${paragraph(ownBookingLine)}
    ${paragraph("If your guests are still coming, you can make a new booking for them at any time.")}
    ${button("Make a New Booking", BASE_URL + "/book")}
  `);
}
