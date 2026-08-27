/**
 * What a member is told when a booking rule is bent, or is not.
 *
 * One module for the whole shape of that conversation: a policy exception
 * approved, refused or lapsed; a booking held for review approved or rejected;
 * and the notice that a booking has lost the adult member cover its non-member
 * guests need, which is the usual reason a member asks for one. Members see the
 * set together under "My booking-rule requests", so they read together here.
 *
 * Same sender family as `./booking` (`src/lib/email/booking.ts`).
 */
import { escapeHtml } from "./escape";
import {
  alertBox,
  BASE_URL,
  button,
  heading,
  infoTable,
  layout,
  paragraph,
  supportContactSentence,
} from "./layout";
import { emailCalendarDay, emailClubDateTime } from "@/lib/email-templates-club-time";

/**
 * A member's booking-policy exception request was approved and the booking now
 * exists (#2526).
 *
 * Why this template has to exist at all: an approved NEW-booking exception
 * normally lands on PAYMENT_PENDING, and the canonical create service emails only
 * a $0 confirmation or a non-member hold notice — a member using the wizard learns
 * what to pay because they are standing in it and get redirected to checkout.
 * Nobody is standing in anything here: the member asked days ago and an officer
 * decided while they were elsewhere. Without this notice the member is never told
 * they have a booking, never sees what to pay, and PAYMENT_PENDING holds no beds,
 * so the stay can be lost without them ever knowing they had it.
 */
export function bookingPolicyExceptionApprovedTemplate(args: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  paymentNote: string;
  adminNotesLine: string;
}): string {
  return layout(`
    ${heading("Your Request Was Approved")}
    ${paragraph("Hi " + escapeHtml(args.firstName) + ", an administrator has approved your request and your booking is now in place.")}
    ${infoTable([
      { label: "Check-in", value: emailCalendarDay(args.checkIn) },
      { label: "Check-out", value: emailCalendarDay(args.checkOut) },
      { label: "Guests", value: String(args.guestCount) },
    ])}
    ${args.paymentNote ? alertBox(escapeHtml(args.paymentNote), "warning") : ""}
    ${args.adminNotesLine ? paragraph(escapeHtml(args.adminNotesLine)) : ""}
    ${button("View Booking", BASE_URL + "/bookings")}
  `);
}

/**
 * "Your request was not approved" — the refusal notice (#2562 review).
 *
 * THE GAP THIS CLOSES. The refusal branch recorded the officer's member-facing
 * explanation, wrote the audit row, released any held beds — and told the member
 * nothing. No email, no notification: this app has no in-app notification centre,
 * so their only signal was a badge on My Bookings they would have to go looking
 * for. The predictable next act is the telephone call the whole workflow exists to
 * remove, or a duplicate request raised in ignorance days later.
 *
 * THE EXPLANATION IS THE POINT. `adminNotes` is mandatory on a refusal precisely
 * so the member can act on it, and a mandatory explanation nobody delivers is a
 * refusal with no reason attached. It arrives as a pre-composed line because the
 * render path has no conditional syntax.
 *
 * NO BOOKING BUTTON, deliberately. The canonical authorized booking-detail link is
 * gated on `ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES`, whose contract is that every
 * sender of a member template hands over a real booking id — and a refused
 * NEW-booking request has no booking at all, so this template cannot honestly join
 * that set. Claiming membership to win a button would make the set's own statement
 * false and would stop the retry cron replaying a failed new-booking refusal. So
 * the notice names where to look instead, which is the same place for both
 * flavours.
 *
 * NO MONEY, because none moved, and NO APOLOGY: an officer exercised the
 * discretion the member was told about when they asked.
 */
export function bookingPolicyExceptionRefusedTemplate(args: {
  firstName: string;
  lodgeName: string;
  checkIn: Date;
  checkOut: Date;
  /** The officer's member-facing explanation, as a whole composed line. */
  reasonLine: string;
  /** What the request had been asking for, in one clause. */
  askDescription: string;
}): string {
  return layout(`
    ${heading("Your request was not approved")}
    ${paragraph("Hi " + escapeHtml(args.firstName) + ", a Booking Officer has looked at " + escapeHtml(args.askDescription) + " at " + escapeHtml(args.lodgeName) + " and decided not to allow it this time.")}
    ${infoTable([
      { label: "Check-in", value: emailCalendarDay(args.checkIn) },
      { label: "Check-out", value: emailCalendarDay(args.checkOut) },
    ])}
    ${args.reasonLine ? alertBox(escapeHtml(args.reasonLine), "info") : ""}
    ${paragraph("Nothing was booked and nothing was changed. Any beds this request was holding have gone back into the pool.")}
    ${paragraph("You can ask again with different dates or a different party. Your requests are listed under My booking-rule requests on your My Bookings page.")}
    ${supportContactSentence("If you would like to talk it through, contact the club at ")}
  `);
}

export function bookingReviewApprovedTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  adminNotes: string,
  bookingId: string,
): string {
  return layout(`
    ${heading("Booking Approved")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", an admin has approved your booking. You can now complete payment to confirm it.")}
    ${infoTable([
      { label: "Check-in", value: emailCalendarDay(checkIn) },
      { label: "Check-out", value: emailCalendarDay(checkOut) },
    ])}
    ${adminNotes ? alertBox("Note from admin: " + escapeHtml(adminNotes), "info") : ""}
    ${button("Complete Payment", BASE_URL + "/bookings/" + bookingId)}
  `);
}

export function bookingReviewRejectedTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  adminNotes: string,
): string {
  return layout(`
    ${heading("Booking Declined")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", an admin has reviewed your booking and was not able to approve it. The booking has been cancelled — no payment was taken.")}
    ${infoTable([
      { label: "Check-in", value: emailCalendarDay(checkIn) },
      { label: "Check-out", value: emailCalendarDay(checkOut) },
    ])}
    ${adminNotes ? alertBox("Reason from admin: " + escapeHtml(adminNotes), "warning") : ""}
    ${paragraph("You are welcome to make a new booking that includes an adult guest, or contact the club to discuss.")}
    ${button("Make a New Booking", BASE_URL + "/book")}
  `);
}

/**
 * "Your booking needs adult member cover" — #2576 §7, §16.
 *
 * Sent when a CONFIRMED booking at an enforcing lodge loses the adult-member
 * cover the club requires — because an officer deliberately overrode the refusal,
 * or because an authoritative change (a membership lapsing, an administrative
 * cancellation, a lifecycle transition) removed it and could not be blocked.
 *
 * THE SECOND PARAGRAPH IS THE MOST IMPORTANT ONE, and it is there because of what
 * a member assumes when the club emails them about a problem with a confirmed
 * stay: that the stay is gone. It is not. §7 and §16 both forbid automatic
 * cancellation, the beds and payments are untouched, and saying so plainly is the
 * difference between a notice and a scare.
 *
 * NAMES NO PERSON, under any scope (§11). It says which nights need cover, never
 * who stopped providing it — even though under `SAME_BOOKING_OWNER` that person is
 * on the member's own account, because the covering member may be a family adult
 * whose membership has just lapsed and that is not this email's news to break.
 * The three ways out are the ones the owner listed.
 */
export function hostingCoverageLostTemplate(data: {
  firstName: string;
  lodgeName: string;
  checkIn: Date;
  checkOut: Date;
  uncoveredNights: string;
}): string {
  return layout(`
    ${heading("Your booking needs adult member cover")}
    ${paragraph(
      `Hi ${escapeHtml(data.firstName)}, a change elsewhere means your booking at ${escapeHtml(data.lodgeName)} no longer has a qualifying adult member staying on every night your non-member guests are there.`,
    )}
    ${infoTable([
      { label: "Check-in", value: escapeHtml(emailCalendarDay(data.checkIn)) },
      { label: "Check-out", value: escapeHtml(emailCalendarDay(data.checkOut)) },
      { label: "Nights needing cover", value: escapeHtml(data.uncoveredNights) },
    ])}
    ${paragraph("Your booking has not been cancelled, and your beds and payments are unchanged. A Booking Officer has been notified and will be in touch.")}
    ${paragraph("You can also fix it yourself: add adult member cover for those nights, change the affected booking, or ask a Booking Officer to approve an exception.")}
    ${supportContactSentence("If you have any questions, contact the club at ")}
  `);
}

/**
 * "Your exception request has lapsed" — #2553.
 *
 * A bed-holding policy-exception request the club never decided is closed by the
 * hold-reaper cron and its beds go back into the pool. Without this notice the
 * member's only signal is a bare `Expired` badge they would have to go looking
 * for, so their next act is a duplicate request raised in ignorance.
 *
 * THREE THINGS THIS SAYS AND ONE IT DOES NOT. It says the request lapsed, that
 * the beds it held were released, and that the booking itself is untouched — that
 * last one matters most, because "your request expired" reads to a member as
 * though the STAY had lapsed. It does NOT apologise or assign blame: nobody did
 * anything wrong, a deadline passed.
 *
 * NO MONEY, because none moved. A policy-exception request never charged
 * anything; the released beds were provisional. The booking link is the core
 * finalizer's optional canonical action, so it appears only where this recipient
 * independently retains route authority.
 */
export function policyExceptionRequestExpiredTemplate(data: {
  firstName: string;
  lodgeName: string;
  checkIn: Date;
  checkOut: Date;
  expiresAt: Date;
}): string {
  return layout(`
    ${heading("Your exception request has lapsed")}
    ${paragraph(
      `Hi ${escapeHtml(data.firstName)}, the exception request you raised for your stay at ${escapeHtml(data.lodgeName)} was not decided by ${escapeHtml(emailClubDateTime(data.expiresAt))}, so it has lapsed and the beds it was holding have been released.`,
    )}
    ${infoTable([
      { label: "Check-in", value: escapeHtml(emailCalendarDay(data.checkIn)) },
      { label: "Check-out", value: escapeHtml(emailCalendarDay(data.checkOut)) },
    ])}
    ${paragraph("Your booking itself has not changed. Only the change you asked the club to allow has lapsed.")}
    ${paragraph("If you still want that change, you can raise a fresh request from your booking.")}
    ${supportContactSentence("If you have any questions, contact the club at ")}
  `);
}
