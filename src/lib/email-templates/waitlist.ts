/**
 * Waitlist emails: joining the queue, an offer, an offer that lapsed, and a
 * place handed back.
 *
 * The family boundary is `src/lib/email/waitlist.ts`.
 */
import { escapeHtml } from "./escape";
import {
  alertBox,
  BASE_URL,
  button,
  formatCents,
  heading,
  infoTable,
  layout,
  muted,
  paragraph,
} from "./layout";
import { emailCalendarDay, emailClubDateTime } from "@/lib/email-templates-club-time";

// ---- Waitlist templates ----

export function waitlistConfirmationTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  position: number
): string {
  return layout(`
    ${heading("You're on the Waitlist")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", the lodge is currently fully booked for your requested dates, but you've been added to the waitlist.")}
    ${infoTable([
      { label: "Check-in", value: emailCalendarDay(checkIn) },
      { label: "Check-out", value: emailCalendarDay(checkOut) },
      { label: "Guests", value: String(guestCount) },
      { label: "Waitlist Position", value: "#" + String(position) },
    ])}
    ${alertBox("We'll email you as soon as a spot opens up. You'll have 48 hours to confirm your booking.", "info")}
    ${button("View Booking", BASE_URL + "/bookings")}
    ${muted("You can cancel your waitlist entry at any time from your booking page.")}
  `);
}

export function waitlistOfferTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  expiresAt: Date,
  bookingId: string,
  // Price the member pays on confirmation (repriced at offer time, #1035;
  // the offered lodge's quote for cross-lodge offers).
  priceCents: number,
  // Cross-lodge offer (ADR-004): names the alternate lodge; the member
  // confirms lodge and price explicitly. Null renders same-lodge offers.
  crossLodgeOffer?: { lodgeName: string | null } | null,
  // #2543: why the Price row reads what it reads, when somebody on this booking
  // is priced as a non-member for an unpaid season subscription. Rendered
  // verbatim from the shared policy sentence — it names nobody and no amount, so
  // it is safe in an email a family member may open. Null renders exactly as
  // before.
  subscriptionMemberRateNotice?: string | null
): string {
  const lodgeLabel = crossLodgeOffer?.lodgeName ?? "another of our lodges";
  return layout(`
    ${heading("A Spot Has Opened Up!")}
    ${
      crossLodgeOffer
        ? paragraph(
            "Hi " +
              escapeHtml(firstName) +
              ", great news — a spot has become available at " +
              escapeHtml(lodgeLabel) +
              ", one of the alternate lodges you said you'd accept for your waitlisted booking."
          )
        : paragraph("Hi " + escapeHtml(firstName) + ", great news — a spot has become available for your waitlisted booking.")
    }
    ${infoTable([
      ...(crossLodgeOffer && crossLodgeOffer.lodgeName
        ? [{ label: "Lodge", value: escapeHtml(crossLodgeOffer.lodgeName) }]
        : []),
      { label: "Check-in", value: emailCalendarDay(checkIn) },
      { label: "Check-out", value: emailCalendarDay(checkOut) },
      { label: "Guests", value: String(guestCount) },
      {
        label: crossLodgeOffer ? "Price at this lodge" : "Price",
        value: formatCents(priceCents),
      },
    ])}
    ${
      crossLodgeOffer
        ? paragraph(
            "This lodge's price differs from the one you originally waitlisted for, so nothing is booked until you review and confirm this price on your booking page."
          )
        : ""
    }
    ${
      subscriptionMemberRateNotice
        ? paragraph(escapeHtml(subscriptionMemberRateNotice))
        : ""
    }
    ${alertBox("This offer expires on " + emailClubDateTime(expiresAt) + ". If you don't confirm in time, the spot will be offered to the next person in line.", "warning")}
    ${button("Confirm Booking", BASE_URL + "/bookings/" + bookingId)}
    ${muted("If you no longer need this booking, you can decline from your booking page.")}
  `);
}

export function waitlistOfferExpiredTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  position: number
): string {
  return layout(`
    ${heading("Waitlist Offer Expired")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", your waitlist offer for the dates below has expired.")}
    ${infoTable([
      { label: "Check-in", value: emailCalendarDay(checkIn) },
      { label: "Check-out", value: emailCalendarDay(checkOut) },
      { label: "New Position", value: "#" + String(position) },
    ])}
    ${paragraph("You've been returned to the waitlist. We'll notify you again if another spot opens up.")}
    ${button("View Booking", BASE_URL + "/bookings")}
  `);
}

/**
 * The RESTORED sibling of `waitlistOfferExpiredTemplate` (#2649).
 *
 * Same shape, same arguments, same rows — the only difference is the copy, and
 * the copy is the whole point. A member whose free waitlist confirmation got
 * stranded in PAYMENT_PENDING did NOT let their offer lapse: they confirmed
 * inside the window and the club's own code failed to finish the job. Sending
 * them the expiry notice states the opposite of what happened, and it
 * contradicts the "your confirmation is stuck, please don't retry" message
 * (#2648) they were already sent. So this template says what is true — their
 * place is back, nothing they did caused it, and they need do nothing.
 */
export function waitlistPlaceRestoredTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  position: number
): string {
  return layout(`
    ${heading("Your Waitlist Place Is Back")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", your booking for the dates below could not be finished, so we have put you back on the waitlist. This was not something you did wrong, and your offer did not run out — you confirmed in time and our system could not complete it.")}
    ${infoTable([
      { label: "Check-in", value: emailCalendarDay(checkIn) },
      { label: "Check-out", value: emailCalendarDay(checkOut) },
      { label: "New Position", value: "#" + String(position) },
    ])}
    ${paragraph("You do not need to do anything. We will email you again as soon as a spot opens up for these nights.")}
    ${button("View Booking", BASE_URL + "/bookings")}
  `);
}
