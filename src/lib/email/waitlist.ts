import {
  waitlistConfirmationTemplate,
  waitlistOfferExpiredTemplate,
  waitlistOfferTemplate,
  waitlistPlaceRestoredTemplate,
} from "@/lib/email-templates/waitlist";
import { EMAIL_DEFAULT_LODGE_NAME } from "@/lib/email-message-settings";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { sendEmail } from "./core";
import { bookingOwnerEmailContext } from "@/lib/booking-email-contract";
import { renderEmailHtml } from "@/lib/email-theme";
import { emailCalendarDay, emailClubDateTime } from "@/lib/email-templates-club-time";

// ---- Waitlist emails ----

export async function sendWaitlistConfirmationEmail(
  // Waitlist entry's booking (#2258): a waitlist entry IS a booking row, so the
  // per-booking "No emails" switch must be able to withhold these too.
  bookingContext: { bookingId: string; recipientMemberId: string },
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  position: number,
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null,
) {
  await sendEmail({
    to: email,
    subject: `Waitlist Confirmation - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: await renderEmailHtml(() => waitlistConfirmationTemplate(
      firstName,
      checkIn,
      checkOut,
      guestCount,
      position,
    )),
    bookingContext: bookingOwnerEmailContext(
      bookingContext.bookingId,
      bookingContext.recipientMemberId,
    ),
    templateName: "waitlist-confirmation",
    templateData: {
      firstName,
      checkIn: emailCalendarDay(checkIn),
      checkOut: emailCalendarDay(checkOut),
      guestCount,
      position,
    },
    lodgeId,
  });
}

export async function sendWaitlistOfferEmail(
  // Waitlist entry's booking (#2258): a waitlist entry IS a booking row, so the
  // per-booking "No emails" switch must be able to withhold these too.
  bookingContext: { bookingId: string; recipientMemberId: string },
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  expiresAt: Date,
  bookingId: string,
  // Price the member pays on confirmation (upstream #1035): the offer-time
  // reprice for same-lodge offers, or the offered lodge's quote for a
  // cross-lodge offer.
  priceCents: number,
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  // A cross-lodge offer passes the OFFERED lodge here so the message
  // carries that lodge's identity.
  lodgeId?: string | null,
  // Cross-lodge offer (ADR-004): names the alternate lodge the member is
  // being offered. Null for same-lodge offers, which render as before.
  crossLodgeOffer?: { lodgeName: string | null } | null,
  // #2543: the "why is this the price" sentence, when the club runs
  // NON_MEMBER_PRICING and somebody on this booking is priced as a non-member
  // because their season subscription is unpaid. The offer-time reprice can raise
  // the stored figure by the whole member/non-member spread, and this email states
  // that figure, so the explanation belongs with it. Null on every other offer,
  // which renders exactly as before.
  subscriptionMemberRateNotice?: string | null,
) {
  await sendEmail({
    to: email,
    subject: `Spot Available! - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: await renderEmailHtml(() => waitlistOfferTemplate(
      firstName,
      checkIn,
      checkOut,
      guestCount,
      expiresAt,
      bookingId,
      priceCents,
      crossLodgeOffer,
      subscriptionMemberRateNotice,
    )),
    bookingContext: bookingOwnerEmailContext(
      bookingContext.bookingId,
      bookingContext.recipientMemberId,
    ),
    templateName: "waitlist-offer",
    templateData: {
      firstName,
      checkIn: emailCalendarDay(checkIn),
      checkOut: emailCalendarDay(checkOut),
      guestCount,
      // The price the member pays on confirmation (repriced at offer time, #1035).
      price: formatMoneyCents(priceCents),
      expiresAt: emailClubDateTime(expiresAt),
      bookingId,
      ...(crossLodgeOffer
        ? { offeredLodgeName: crossLodgeOffer.lodgeName }
        : {}),
      ...(subscriptionMemberRateNotice
        ? { subscriptionMemberRateNotice }
        : {}),
    },
    lodgeId,
  });
}

export async function sendWaitlistOfferExpiredEmail(
  // Waitlist entry's booking (#2258): a waitlist entry IS a booking row, so the
  // per-booking "No emails" switch must be able to withhold these too.
  bookingContext: { bookingId: string; recipientMemberId: string },
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  position: number,
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null,
) {
  await sendEmail({
    to: email,
    subject: `Waitlist Offer Expired - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: await renderEmailHtml(() => waitlistOfferExpiredTemplate(firstName, checkIn, checkOut, position)),
    bookingContext: bookingOwnerEmailContext(
      bookingContext.bookingId,
      bookingContext.recipientMemberId,
    ),
    templateName: "waitlist-offer-expired",
    templateData: {
      firstName,
      checkIn: emailCalendarDay(checkIn),
      checkOut: emailCalendarDay(checkOut),
      position,
    },
    lodgeId,
  });
}

/**
 * The RESTORED sibling of {@link sendWaitlistOfferExpiredEmail} (#2649).
 *
 * Identical plumbing — same arguments, same tokens, same booking-owner context,
 * same optional lodge branding — because the two messages describe the same
 * state change (the member is back on the waitlist at a known position). Only
 * the reason differs, and only this one is true when an admin repairs a
 * confirmation the club's own code stranded: the offer did not expire, so the
 * expiry notice must not be reused for it.
 */
export async function sendWaitlistPlaceRestoredEmail(
  // Waitlist entry's booking (#2258): a waitlist entry IS a booking row, so the
  // per-booking "No emails" switch must be able to withhold these too.
  bookingContext: { bookingId: string; recipientMemberId: string },
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  position: number,
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null,
) {
  await sendEmail({
    to: email,
    subject: `Your Waitlist Place Is Back - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: await renderEmailHtml(() => waitlistPlaceRestoredTemplate(firstName, checkIn, checkOut, position)),
    bookingContext: bookingOwnerEmailContext(
      bookingContext.bookingId,
      bookingContext.recipientMemberId,
    ),
    templateName: "waitlist-place-restored",
    templateData: {
      firstName,
      checkIn: emailCalendarDay(checkIn),
      checkOut: emailCalendarDay(checkOut),
      position,
    },
    lodgeId,
  });
}
