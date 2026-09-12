/**
 * The member's answer to a refund appeal.
 *
 * Both outcomes share one layout so an approval and a decline cannot drift
 * apart in shape. They are sent from the admin refund-request review route
 * rather than an `src/lib/email/*` sender; the admin-side alert about the same
 * appeal lives in `admin-finance.ts`.
 *
 * #3340 added the second kind of member-facing refund notice here: a payment the
 * member made against a charge a later booking edit had already replaced,
 * refunded automatically by the recovery queue. It is a refund outcome rather
 * than a booking-lifecycle message, which is what this module is for, and its
 * sender does live in `src/lib/email/booking.ts` — booking-scoped, so the
 * per-booking "No emails" switch withholds it.
 */
import { escapeHtml } from "./escape";
import {
  alertBox,
  BASE_URL,
  button,
  formatCents,
  heading,
  layout,
  multilineBlock,
  paragraph,
  supportContactSentence,
} from "./layout";
import { emailCalendarDay } from "@/lib/email-templates-club-time";

/**
 * #2321 — the refund-appeal outcome emails, ONE FUNCTION PER OUTCOME.
 *
 * These were a single template switching on a `status` boolean, alongside a
 * single registered `refund-request-resolved` body whose default wording said
 * "approved". The HTML path always branched correctly, but the flat editable
 * body could not — so a club that had saved an override sent approval wording,
 * and a sentence with an empty amount, to members whose appeal was declined.
 * Splitting both the registered template and this function means no surface
 * exists on which one outcome's wording can reach the other's recipient.
 */
function refundRequestOutcomeLayout(data: {
  firstName: string;
  headingText: string;
  outcomeSentence: string;
  outcomeTone: "success" | "warning";
  adminNotes: string | null;
}): string {
  return layout(`
    ${heading(data.headingText)}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ",")}
    ${alertBox(data.outcomeSentence, data.outcomeTone)}
    ${data.adminNotes ? multilineBlock("<strong>Notes:</strong>\n" + escapeHtml(data.adminNotes)) : ""}
    ${supportContactSentence("If you have questions, contact the club at ")}
  `);
}

export function refundRequestApprovedTemplate(data: {
  firstName: string;
  amountCents: number | null;
  adminNotes: string | null;
  checkIn: Date;
  checkOut: Date;
}): string {
  return refundRequestOutcomeLayout({
    firstName: data.firstName,
    headingText: "Refund Appeal Approved",
    outcomeSentence:
      "Your refund appeal for your booking (" + emailCalendarDay(data.checkIn) + " - " + emailCalendarDay(data.checkOut) + ") has been approved. A refund of " + formatCents(data.amountCents ?? 0) + " will be processed to your original payment method.",
    outcomeTone: "success",
    adminNotes: data.adminNotes,
  });
}

export function refundRequestDeclinedTemplate(data: {
  firstName: string;
  adminNotes: string | null;
  checkIn: Date;
  checkOut: Date;
}): string {
  // Deliberately takes no amount at all: there is no refund to state, and the
  // parameter's absence is what stops one being printed.
  return refundRequestOutcomeLayout({
    firstName: data.firstName,
    headingText: "Refund Appeal Update",
    outcomeSentence:
      "Your refund appeal for your booking (" + emailCalendarDay(data.checkIn) + " - " + emailCalendarDay(data.checkOut) + ") was not approved at this time.",
    outcomeTone: "warning",
    adminNotes: data.adminNotes,
  });
}

/**
 * #3340 — a payment the member made against a charge a later booking edit had
 * already replaced was captured and has been refunded in full.
 *
 * WHY IT EXISTS. Until #3340 the supersede refund sent NOTHING: Stripe's own
 * receipt was the only notice the member got, with no explanation of what had
 * been charged, why it came back, or what was still owing. A member in the live
 * case wrote in asking, and was right to.
 *
 * WHAT IT MUST SAY, and in this order: the money is back, nobody is out of
 * pocket, and here is what is still owing now. `amountOwingCents` is the figure
 * as at the refund — zero is a real and reassuring answer, and it gets its own
 * sentence rather than an empty row.
 */
export function supersededPaymentRefundedTemplate(data: {
  bookingId: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  refundedAmountCents: number;
  amountOwingCents: number;
}): string {
  const dates = `${emailCalendarDay(data.checkIn)} – ${emailCalendarDay(data.checkOut)}`;
  const owingLine =
    data.amountOwingCents > 0
      ? `There is still ${formatCents(data.amountOwingCents)} to pay on this booking. You can pay it from your booking page.`
      : "Nothing further is owing on this booking.";
  return layout(`
    ${heading("We've Refunded a Payment")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ",")}
    ${alertBox(
      "We have refunded " +
        formatCents(data.refundedAmountCents) +
        " to your card. That payment was made against an earlier charge for your booking (" +
        dates +
        ") that a later change to the booking had already replaced, so it should not have been taken.",
      "info"
    )}
    ${paragraph("You are not out of pocket: the money is on its way back to the card you used, and your booking is unaffected.")}
    ${paragraph(owingLine)}
    ${button("View Booking", BASE_URL + "/bookings/" + data.bookingId)}
    ${supportContactSentence("If anything about this looks wrong, please contact the club at ")}
  `);
}
